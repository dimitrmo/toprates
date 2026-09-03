import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Finance from './finance.js';
import * as Widgets from './widgets.js';
import {QuoteDetails} from './quoteDetails.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async',
    'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

// Nothing moves while every followed exchange is shut, so the poll slows down
// rather than waking the radio every few minutes all night.
const CLOSED_REFRESH_INTERVAL = 1800;

// A round that failed completely is retried sooner than the configured
// interval, then backs off. Never slower than the interval itself.
const RETRY_DELAYS = [30, 60, 120, 300];

// Bumped when the on-disk shape changes, so an old cache is ignored.
const CACHE_VERSION = 2;

// org.gnome.SessionManager.Presence: 0 available, 1 invisible, 2 busy, 3 idle.
// Only the last one means nobody is looking at the panel.
const PRESENCE_IDLE = 3;

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Top Rates', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._finance = new Finance.YahooFinance();
        this._quotes = new Map();     // symbol -> {quote} | {error}
        this._lastUpdate = null;
        this._timeoutId = 0;
        this._ageTimeoutId = 0;
        this._menuStateId = 0;
        this._failures = 0;
        this._settingsIds = [];
        this._cancellable = null;
        this._destroyed = false;
        this._refreshing = false;
        this._retries = 0;
        this._marketsClosed = false;
        this._cachedAt = null;
        // FX pairs, keyed the way Yahoo names them: {'USDEUR=X': 0.92}. Only
        // fetched for the currencies the held symbols are actually quoted in.
        this._rates = {};
        this._idle = false;
        // Details windows outlive the popup that opened them, so they are
        // tracked -- with the handler that unregisters each one -- and closed
        // when the extension goes away under them.
        this._dialogs = new Map();     // dialog -> 'destroy' handler id
        // Aborts the cache read if the panel goes away before it lands.
        this._cacheCancellable = new Gio.Cancellable();
        // Shell themes ship as two whole stylesheets with nothing on the stage
        // to tell them apart, so the variant is measured once we are styled.
        this._dark = true;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/toprates-symbolic.svg`),
            style_class: 'system-status-icon toprates-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._icon);

        this._labels = [];

        this._buildMenu();

        for (const key of ['show-label', 'show-change', 'colorize', 'panel-symbol',
            'panel-symbols', 'panel-separator', 'font-scale', 'font-weight',
            'font-family', 'show-graph', 'graph-height', 'show-icon',
            'show-portfolio'])
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => this._sync()));

        // Both change what has to be fetched, not just how it is drawn.
        for (const key of ['symbols', 'history-range'])
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => this._refresh()));
        this._settingsIds.push(
            this._settings.connect('changed::refresh-interval', () => this._scheduleRefresh()));

        // A new holding, or a new base currency, can want a pair that has
        // never been fetched; the rest of the round is already in hand.
        for (const key of ['holdings', 'base-currency']) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._sync();
                this._refreshRates(this._cancellable);
            }));
        }

        this._settingsIds.push(this._settings.connect('changed::pause-when-idle',
            () => this._applyPause()));

        this.connect('style-changed', () => this._updateThemeVariant());

        // Coming back online is worth a retry: without this the panel sits on
        // stale dashes until the next tick, however long that is.
        this._network = Gio.NetworkMonitor.get_default();
        this._networkId = this._network.connect('network-changed', (_monitor, available) => {
            if (available && !this._refreshing && (this._failures > 0 || this._isStale()))
                this._refresh();
        });

        this._watchPresence();

        this._loadCache();
        this._sync();
        this._refresh();
    }

    // --- Idle ------------------------------------------------------------

    /**
     * Nobody is watching a panel on an idle session, and the lock screen is
     * already covered: the extension declares the `user` session mode only, so
     * the shell disables it outright when the screen locks. This closes the
     * other half, where the session sits unlocked and untouched for hours.
     */
    _watchPresence() {
        Gio.DBusProxy.new(
            Gio.DBus.session, Gio.DBusProxyFlags.NONE, null,
            'org.gnome.SessionManager', '/org/gnome/SessionManager/Presence',
            'org.gnome.SessionManager.Presence', null,
            (_source, result) => {
                if (this._destroyed)
                    return;
                try {
                    this._presence = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    // No session manager to ask: keep polling as before.
                    console.debug(`TopRates: presence unavailable: ${e.message}`);
                    return;
                }
                this._presenceId = this._presence.connect('g-signal',
                    (_proxy, _sender, signal, params) => {
                        if (signal === 'StatusChanged')
                            this._onPresence(params.deepUnpack()[0]);
                    });
                this._onPresence(
                    this._presence.get_cached_property('status')?.deepUnpack());
            });
    }

    _onPresence(status) {
        const idle = status === PRESENCE_IDLE;
        if (idle === this._idle)
            return;
        this._idle = idle;
        this._applyPause();
    }

    _paused() {
        return this._idle && this._settings.get_boolean('pause-when-idle');
    }

    /** Drop the pending timer while paused; catch up the moment we are not. */
    _applyPause() {
        if (this._destroyed)
            return;

        if (this._paused()) {
            if (this._timeoutId) {
                GLib.Source.remove(this._timeoutId);
                this._timeoutId = 0;
            }
            this._updateStatus();
            return;
        }

        // Hours can have passed, so this is the same catch-up the network
        // monitor does: refresh when the data has gone stale, otherwise just
        // put the timer back.
        if (this._isStale() && !this._refreshing)
            this._refresh();
        else
            this._scheduleRefresh();
    }

    // --- Theme ---------------------------------------------------------

    /**
     * Read the variant back from the colour the theme actually gives us: a
     * light foreground means the shell is dark. More reliable than the
     * colour-scheme setting, and it follows third-party themes too.
     */
    _updateThemeVariant() {
        let color;
        try {
            color = this.get_theme_node().get_foreground_color();
        } catch {
            return;     // not on a stage yet; style-changed will come again
        }

        const [r, g, b] = Widgets.inkFrom(color);
        const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
        if (dark === this._dark)
            return;

        this._dark = dark;
        this._applyThemeVariant();
        this._sync();
    }

    _applyThemeVariant() {
        // Only descendants are restyled, so this cannot feed back into the
        // style-changed handler that called it.
        for (const actor of [this, this.menu.box]) {
            if (this._dark)
                actor.remove_style_class_name('toprates-light');
            else
                actor.add_style_class_name('toprates-light');
        }
    }

    _buildMenu() {
        this._quoteSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._quoteSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupMenuItem(_('Loading…'), {
            reactive: false,
            style_class: 'toprates-status',
        });
        this.menu.addMenuItem(this._statusItem);

        const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh now'));
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        // e.g.o. adds a numeric `version`; the tree only carries `version-name`.
        const meta = this._extension.metadata;
        const version = meta['version-name'] ?? meta.version;
        if (version !== undefined) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                `${_('Version')} ${version}`, {
                    reactive: false,
                    style_class: 'toprates-version',
                }));
        }

        // Refresh when the menu is opened after a long idle period.
        this._menuStateId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen && this._isStale())
                this._refresh();
            if (isOpen)
                this._startAgeTicker();
            else
                this._stopAgeTicker();
        });
    }

    _symbols() {
        return this._settings.get_strv('symbols')
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }

    /** Symbols to draw in the panel, in the order of the followed list. */
    _panelSymbols() {
        const symbols = this._symbols();
        const preferred = this._settings.get_strv('panel-symbols')
            .map(s => s.trim())
            .filter(s => symbols.includes(s));
        if (preferred.length > 0)
            return symbols.filter(s => preferred.includes(s));
        return symbols.length > 0 ? [symbols[0]] : [];
    }

    /** The held positions, keyed the way the settings spell the symbol. */
    _holdings() {
        try {
            return Finance.parseHoldings(
                this._settings.get_value('holdings').deepUnpack());
        } catch {
            return new Map();    // an unreadable key is an empty portfolio
        }
    }

    _baseCurrency() {
        return this._settings.get_string('base-currency').trim().toUpperCase();
    }

    /**
     * One position per held symbol that has a price, in the order of the
     * followed list. Symbols without a holding are simply not in it.
     */
    _positions() {
        const holdings = this._holdings();
        if (holdings.size === 0)
            return new Map();

        const base = this._baseCurrency();
        const positions = new Map();
        for (const symbol of this._symbols()) {
            const holding = holdings.get(symbol.toUpperCase());
            if (!holding)
                continue;
            const position = Finance.positionOf(
                this._quotes.get(symbol)?.quote, holding, base, this._rates);
            if (position)
                positions.set(symbol, position);
        }
        return positions;
    }

    /** The totals line as the popup wants it, which is only when asked for. */
    _portfolio(positions) {
        if (!this._settings.get_boolean('show-portfolio'))
            return null;
        return this._portfolioTotals(positions);
    }

    /**
     * The totals line, or null when there is nothing to add up. Without a base
     * currency the positions are only summed while they already share one:
     * adding dollars to euros would print a number that means nothing.
     */
    _portfolioTotals(positions) {
        if (positions.size === 0)
            return null;

        const base = this._baseCurrency();
        const currencies = new Set([...positions.values()]
            .map(position => Finance.majorUnitOf(position.currency).code));
        if (!base && currencies.size !== 1)
            return null;

        const totals = Finance.portfolioTotals(positions.values());
        if (!totals)
            return null;
        return {...totals, currency: base || [...currencies][0]};
    }

    _historyRange() {
        const range = this._settings.get_string('history-range');
        return Finance.HISTORY_INTERVALS[range] ? range : Finance.DEFAULT_RANGE;
    }

    _trend(percent) {
        return Finance.trendOf(percent);
    }

    /**
     * The details window for one symbol: the quote page's chart, statistics
     * and history, drawn in the shell rather than handed to a browser.
     *
     * The rates and the portfolio total travel with it because the window
     * fetches neither: it re-prices the holding off its own polling, but a
     * foreign position still needs the panel's rates to reach the base
     * currency, and a weight still needs the whole to be a share of.
     */
    _openDetails(symbol) {
        const dialog = new QuoteDetails(symbol, {
            settings: this._settings,
            finance: this._finance,
            quote: this._quotes.get(symbol)?.quote,
            range: this._historyRange(),
            light: !this._dark,
            rates: this._rates,
            portfolio: this._portfolioTotals(this._positions()),
        });
        this._dialogs.set(dialog,
            dialog.connect('destroy', () => this._dialogs.delete(dialog)));
        dialog.open();
    }

    _isStale() {
        if (!this._lastUpdate)
            return true;
        const age = GLib.DateTime.new_now_local().difference(this._lastUpdate);
        return age > this._settings.get_int('refresh-interval') * GLib.TIME_SPAN_SECOND;
    }

    _changeStyle(percent) {
        if (!this._settings.get_boolean('colorize') || !Number.isFinite(percent) || percent === 0)
            return 'toprates-flat';
        return percent > 0 ? 'toprates-up' : 'toprates-down';
    }

    /** Visual state that depends only on settings and cached quotes. */
    _sync() {
        if (this._destroyed)
            return;

        const showLabel = this._settings.get_boolean('show-label');
        const showIcon = this._settings.get_boolean('show-icon');
        this._icon.visible = showIcon;
        // Never leave an empty button behind: fall back to the icon.
        this._box.visible = showLabel || showIcon;

        this._updatePanel();
        this._updateMenu();
    }

    /**
     * Font family declaration, or an empty string for the system font. St
     * inherits font-family, so setting it on a container styles its labels.
     */
    _fontStyle() {
        const family = this._settings.get_string('font-family').trim();
        // Quoted so multi-word families ("DejaVu Sans Mono") survive parsing.
        return family ? `font-family: "${family.replace(/"/g, '')}";` : '';
    }

    _labelStyle() {
        return `font-size: ${this._settings.get_int('font-scale') / 100}em; ` +
            `font-weight: ${this._settings.get_int('font-weight')}; ` +
            this._fontStyle();
    }

    _addLabel(text, styleClass, opacity = 255) {
        const label = new St.Label({
            text,
            style_class: styleClass,
            opacity,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.set_style(this._labelStyle());
        this._box.add_child(label);
        this._labels.push(label);
        return label;
    }

    /** One label per panel symbol, with a separator label in between. */
    _updatePanel() {
        for (const label of this._labels)
            label.destroy();
        this._labels = [];

        if (!this._settings.get_boolean('show-label'))
            return;

        const symbols = this._panelSymbols();
        if (symbols.length === 0) {
            this._addLabel(_('No symbols'), 'toprates-label');
            return;
        }

        const separator = this._settings.get_string('panel-separator');
        symbols.forEach((symbol, i) => {
            if (i > 0)
                this._addLabel(separator, 'toprates-label toprates-separator', Widgets.FAINT_OPACITY);
            this._addLabel(...this._panelText(symbol));
        });
    }

    /** [text, style class] for one symbol in the panel. */
    _panelText(symbol) {
        const entry = this._quotes.get(symbol);
        if (!entry)
            return [`${symbol} …`, 'toprates-label'];
        if (!entry.quote)
            return [`${symbol} —`, 'toprates-label toprates-error'];

        const {price, currency, percent} = entry.quote;
        let text = `${symbol} ${Finance.formatPrice(price, currency)}`;
        if (this._settings.get_boolean('show-change')) {
            const change = Finance.formatPercent(percent);
            if (change)
                text += ` ${change}`;
        }
        return [text, `toprates-label ${this._changeStyle(percent)}`,
            entry.stale ? Widgets.STALE_OPACITY : 255];
    }

    _updateMenu() {
        this._quoteSection.removeAll();

        const symbols = this._symbols();
        if (symbols.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                _('Add symbols in Preferences'), {reactive: false});
            this._quoteSection.addMenuItem(empty);
            return;
        }

        const positions = this._positions();
        for (const symbol of symbols)
            this._quoteSection.addMenuItem(this._createQuoteItem(symbol, positions.get(symbol)));

        const portfolio = this._portfolio(positions);
        if (portfolio)
            this._quoteSection.addMenuItem(this._createPortfolioItem(portfolio));
    }

    _createQuoteItem(symbol, position) {
        const entry = this._quotes.get(symbol);
        const item = new PopupMenu.PopupBaseMenuItem({style_class: 'toprates-quote'});
        item.set_style(this._fontStyle());

        // Header row on top, price history underneath it.
        const column = new St.BoxLayout({vertical: true, x_expand: true});
        const header = new St.BoxLayout({x_expand: true, style_class: 'toprates-quote-header'});

        const nameBox = new St.BoxLayout({vertical: true, x_expand: true});
        nameBox.add_child(new St.Label({
            text: symbol,
            style_class: 'toprates-symbol',
        }));
        // What is held, where the eye is already reading the symbol: "10 @
        // 142.30" is the position, not another number about the instrument.
        if (position && this._settings.get_boolean('show-portfolio')) {
            const cost = Number.isFinite(position.cost)
                ? ` @ ${Finance.formatBare(position.cost)}` : '';
            nameBox.add_child(new St.Label({
                text: `${Finance.formatQuantity(position.quantity)}${cost}`,
                style_class: 'toprates-holding',
                opacity: Widgets.FAINT_OPACITY,
            }));
        }

        const subtitle = entry?.quote?.name || entry?.quote?.exchange || '';
        if (subtitle) {
            nameBox.add_child(new St.Label({
                text: subtitle,
                style_class: 'toprates-subtitle',
                opacity: Widgets.MUTED_OPACITY,
            }));
        }

        // Only worth saying when the exchange is not trading normally.
        const badge = Finance.marketLabel(entry?.quote?.market);
        if (badge) {
            nameBox.add_child(new St.Label({
                text: badge,
                style_class: 'toprates-market',
                opacity: Widgets.MUTED_OPACITY,
            }));
        }
        header.add_child(nameBox);

        const valueBox = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.END});
        if (entry?.stale)
            valueBox.opacity = Widgets.STALE_OPACITY;

        if (!entry) {
            valueBox.add_child(new St.Label({text: '…', style_class: 'toprates-price'}));
        } else if (!entry.quote) {
            valueBox.add_child(new St.Label({
                text: entry.error,
                style_class: 'toprates-price toprates-error',
            }));
        } else {
            const {price, currency, change, percent} = entry.quote;
            valueBox.add_child(new St.Label({
                text: Finance.formatPrice(price, currency),
                style_class: 'toprates-price',
            }));
            const moved = Finance.formatChange(change);
            const delta = moved ? `${moved} (${Finance.formatPercent(percent)})` : '';
            if (delta) {
                valueBox.add_child(new St.Label({
                    text: delta,
                    style_class: `toprates-change ${this._changeStyle(percent)}`,
                }));
            }

            if (position && this._settings.get_boolean('show-portfolio')) {
                const gain = Finance.formatPercent(position.gainPercent);
                valueBox.add_child(new St.Label({
                    text: `${Finance.formatPrice(position.value, currency)}` +
                        (gain ? `  ·  ${gain}` : ''),
                    style_class: `toprates-position ${
                        Number.isFinite(position.gainPercent)
                            ? this._changeStyle(position.gainPercent) : ''}`,
                    opacity: Widgets.MUTED_OPACITY,
                }));
            }
        }
        header.add_child(valueBox);
        column.add_child(header);

        const graph = this._createGraph(entry);
        if (graph)
            column.add_child(graph);

        item.add_child(column);

        item.connect('activate', () => this._openDetails(symbol));

        return item;
    }

    /** The portfolio line under the symbols: what the whole lot is worth. */
    _createPortfolioItem(portfolio) {
        const item = new PopupMenu.PopupBaseMenuItem({
            style_class: 'toprates-portfolio',
            reactive: false,
        });
        item.set_style(this._fontStyle());

        const row = new St.BoxLayout({x_expand: true});
        const left = new St.BoxLayout({vertical: true, x_expand: true});
        left.add_child(new St.Label({
            text: _('Portfolio'),
            style_class: 'toprates-symbol',
        }));

        // A total that had to leave positions out says so: silently short is
        // worse than visibly incomplete.
        const counted = portfolio.missing > 0
            ? `${portfolio.counted}/${portfolio.counted + portfolio.missing} ${_('positions')}`
            : `${portfolio.counted} ${_('positions')}`;
        left.add_child(new St.Label({
            text: portfolio.missing > 0
                ? `${counted}  ·  ${_('no rate for the rest')}` : counted,
            style_class: 'toprates-subtitle',
            opacity: Widgets.MUTED_OPACITY,
        }));
        row.add_child(left);

        const right = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.END});
        right.add_child(new St.Label({
            text: Finance.formatPrice(portfolio.value, portfolio.currency),
            style_class: 'toprates-price',
        }));

        const day = Finance.formatChange(portfolio.dayChange);
        const dayPercent = Finance.formatPercent(portfolio.dayPercent);
        if (day) {
            right.add_child(new St.Label({
                text: `${day}${dayPercent ? ` (${dayPercent})` : ''} ${_('today')}`,
                style_class: `toprates-change ${this._changeStyle(portfolio.dayPercent)}`,
            }));
        }

        // Only the positions carrying a cost basis have an unrealised gain,
        // so the row is left off entirely rather than shown as zero.
        if (portfolio.priced > 0 && Number.isFinite(portfolio.gain)) {
            const gain = Finance.formatChange(portfolio.gain);
            const gainPercent = Finance.formatPercent(portfolio.gainPercent);
            right.add_child(new St.Label({
                text: `${gain}${gainPercent ? ` (${gainPercent})` : ''} ${_('total')}`,
                style_class: `toprates-position ${this._changeStyle(portfolio.gainPercent)}`,
                opacity: Widgets.MUTED_OPACITY,
            }));
        }
        row.add_child(right);

        item.add_child(row);
        return item;
    }

    /** Sparkline plus a range caption, or null when there is nothing to draw. */
    _createGraph(entry) {
        if (!this._settings.get_boolean('show-graph'))
            return null;

        const history = entry?.quote?.history ?? [];
        if (history.length < 2)
            return null;

        const {percent} = entry.quote;
        const trend = this._settings.get_boolean('colorize')
            ? this._trend(percent) : 'flat';

        const box = new St.BoxLayout({vertical: true, x_expand: true});
        box.add_child(Widgets.createSparkline(
            history, trend, this._settings.get_int('graph-height')));

        const first = history[0];
        const last = history[history.length - 1];
        const move = first ? ((last - first) / first) * 100 : NaN;
        const caption = new St.BoxLayout({x_expand: true, style_class: 'toprates-graph-caption'});
        caption.add_child(new St.Label({
            text: this._historyRange(),
            style_class: 'toprates-range',
            opacity: Widgets.FAINT_OPACITY,
            x_expand: true,
        }));
        caption.add_child(new St.Label({
            text: Finance.formatPercent(move),
            style_class: `toprates-range ${this._changeStyle(move)}`,
            x_align: Clutter.ActorAlign.END,
        }));
        box.add_child(caption);

        return box;
    }

    _setStatus(text) {
        if (!this._destroyed)
            this._statusItem.label.text = text;
    }

    /** Seconds since the last successful refresh, as a compact "3s ago". */
    _ageText() {
        const seconds = Math.max(0, Math.floor(
            GLib.DateTime.new_now_local().difference(this._lastUpdate) /
            GLib.TIME_SPAN_SECOND));
        if (seconds < 60)
            return `${seconds}s ${_('ago')}`;
        if (seconds < 3600)
            return `${Math.floor(seconds / 60)}m ${_('ago')}`;
        return `${Math.floor(seconds / 3600)}h ${_('ago')}`;
    }

    _updateStatus() {
        if (!this._lastUpdate) {
            // Nothing fetched yet this session, but the cache had something.
            if (this._cachedAt)
                this._setStatus(`${_('Cached')} ${this._cachedAt.format('%H:%M')}`);
            return;
        }

        const stamp = this._lastUpdate.format('%H:%M:%S');
        const parts = [`${_('Updated')} ${stamp} (${this._ageText()})`];
        if (this._failures)
            parts.push(`${this._failures} ${_('failed')}`);
        if (this._marketsClosed)
            parts.push(_('markets closed'));
        if (this._paused())
            parts.push(_('paused while idle'));
        this._setStatus(parts.join(' · '));
    }

    _startAgeTicker() {
        this._stopAgeTicker();
        this._updateStatus();
        this._ageTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this._updateStatus();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopAgeTicker() {
        if (this._ageTimeoutId) {
            GLib.Source.remove(this._ageTimeoutId);
            this._ageTimeoutId = 0;
        }
    }

    // --- Cache -----------------------------------------------------------

    _cacheFile() {
        return Gio.File.new_for_path(GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'toprates', 'quotes.json']));
    }

    /**
     * Seed the panel from the previous session, so it opens on real numbers
     * instead of an ellipsis while the first request is still in flight.
     *
     * The read is asynchronous, so the first round may well beat it home. What
     * it finds therefore only ever fills gaps: a quote or a rate that has
     * already arrived is left alone.
     */
    async _loadCache() {
        let payload;
        try {
            // Promisified, so the success boolean is stripped: contents first.
            const [contents] = await this._cacheFile()
                .load_contents_async(this._cacheCancellable);
            payload = JSON.parse(new TextDecoder().decode(contents));
        } catch {
            return;     // no cache yet, or unreadable: nothing worth reporting
        }

        if (this._destroyed || payload?.version !== CACHE_VERSION)
            return;

        // The stored history only matches the range it was fetched for.
        const sameRange = payload.range === this._historyRange();
        for (const symbol of this._symbols()) {
            const quote = payload.quotes?.[symbol];
            if (!quote || this._quotes.has(symbol))
                continue;
            this._quotes.set(symbol, {
                quote: sameRange ? quote : {...quote, history: []},
                stale: true,
            });
        }

        // Rates move slowly enough that yesterday's are a better opening
        // total than none at all; the next round replaces them.
        if (payload.rates && typeof payload.rates === 'object')
            this._rates = {...payload.rates, ...this._rates};

        if (!this._lastUpdate && Number.isFinite(payload.savedAt))
            this._cachedAt = GLib.DateTime.new_from_unix_local(payload.savedAt);

        this._sync();
    }

    _saveCache() {
        const quotes = {};
        for (const [symbol, entry] of this._quotes) {
            if (entry.quote)
                quotes[symbol] = entry.quote;
        }
        if (Object.keys(quotes).length === 0)
            return;

        const payload = JSON.stringify({
            version: CACHE_VERSION,
            savedAt: Math.floor(Date.now() / 1000),
            range: this._historyRange(),
            rates: this._rates,
            quotes,
        });

        const file = this._cacheFile();
        try {
            GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
            file.replace_contents_bytes_async(
                new GLib.Bytes(new TextEncoder().encode(payload)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null)
                .catch(e => console.debug(`TopRates: cache write failed: ${e.message}`));
        } catch (e) {
            console.debug(`TopRates: cache write failed: ${e.message}`);
        }
    }

    async _refresh() {
        if (this._destroyed)
            return;

        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        const symbols = this._symbols();
        if (symbols.length === 0) {
            this._quotes.clear();
            this._setStatus(_('No symbols configured'));
            this._sync();
            return;
        }

        this._setStatus(_('Updating…'));
        this._refreshing = true;

        const range = this._historyRange();

        const results = await Promise.allSettled(
            symbols.map(symbol => this._finance.fetchQuote(symbol, range, cancellable)));

        this._refreshing = false;

        // A newer refresh (or teardown) started while we were waiting.
        if (this._destroyed || cancellable.is_cancelled() || cancellable !== this._cancellable)
            return;

        let failures = 0;
        let closed = 0;
        symbols.forEach((symbol, i) => {
            const result = results[i];
            if (result.status === 'fulfilled') {
                this._quotes.set(symbol, {quote: result.value});
                if (result.value.market === 'closed')
                    closed += 1;
                return;
            }

            failures += 1;
            // A symbol that failed keeps its last known price, marked stale,
            // rather than trading a real number for an error string.
            const error = result.reason?.message ?? _('error');
            const previous = this._quotes.get(symbol)?.quote;
            this._quotes.set(symbol, previous
                ? {quote: previous, stale: true, error}
                : {error});
        });

        // Drop quotes for symbols that are no longer followed.
        for (const symbol of [...this._quotes.keys()]) {
            if (!symbols.includes(symbol))
                this._quotes.delete(symbol);
        }

        const succeeded = symbols.length - failures;
        this._marketsClosed = succeeded > 0 && closed === succeeded;
        this._retries = failures === symbols.length ? this._retries + 1 : 0;

        if (succeeded > 0) {
            this._lastUpdate = GLib.DateTime.new_now_local();
            this._cachedAt = null;
            this._saveCache();
        }

        this._failures = failures;
        this._updateStatus();

        this._sync();
        this._scheduleRefresh();

        // Deliberately not awaited: the panel is already up to date, and the
        // rates only decide what the portfolio total says. It syncs again by
        // itself when they land.
        this._refreshRates(cancellable);
    }

    /**
     * The FX pairs the held positions need to reach the base currency, fetched
     * through the same endpoint as everything else. Nothing is requested when
     * no holding is quoted in a foreign currency, which is the common case.
     */
    async _refreshRates(cancellable) {
        if (this._destroyed)
            return;

        const holdings = this._holdings();
        const currencies = new Set();
        for (const symbol of this._symbols()) {
            if (!holdings.has(symbol.toUpperCase()))
                continue;
            const currency = this._quotes.get(symbol)?.quote?.currency;
            if (currency)
                currencies.add(currency);
        }

        const pairs = Finance.fxSymbolsFor(currencies, this._baseCurrency());
        if (pairs.length === 0) {
            if (Object.keys(this._rates).length > 0) {
                this._rates = {};
                this._sync();
            }
            return;
        }

        const results = await Promise.allSettled(pairs.map(
            pair => this._finance.fetchQuote(pair, '1d', cancellable)));

        if (this._destroyed || cancellable?.is_cancelled() ||
            (cancellable && cancellable !== this._cancellable))
            return;

        // A pair that failed keeps whatever rate it had: an old rate converts
        // better than no rate, and the position would otherwise leave the
        // total on the next round.
        const rates = {...this._rates};
        let landed = 0;
        pairs.forEach((pair, i) => {
            const result = results[i];
            if (result.status === 'fulfilled' && Number.isFinite(result.value.price)) {
                rates[pair] = result.value.price;
                landed += 1;
            }
        });

        if (landed === 0)
            return;

        this._rates = rates;
        this._saveCache();
        this._sync();
    }

    /**
     * Seconds until the next automatic refresh: sooner after a failed round,
     * later when every followed market is shut, the configured interval
     * otherwise.
     */
    _nextDelay() {
        const interval = this._settings.get_int('refresh-interval');
        if (this._retries > 0) {
            const backoff = RETRY_DELAYS[
                Math.min(this._retries, RETRY_DELAYS.length) - 1];
            return Math.min(backoff, interval);
        }
        return this._marketsClosed
            ? Math.max(interval, CLOSED_REFRESH_INTERVAL)
            : interval;
    }

    /** One-shot: every refresh books the next one, so the delay can vary. */
    _scheduleRefresh() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        // Booking nothing is what pauses the polling; _applyPause books the
        // next round again when the session comes back.
        if (this._destroyed || this._paused())
            return;

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, this._nextDelay(), () => {
                this._timeoutId = 0;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    destroy() {
        this._destroyed = true;

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        this._stopAgeTicker();

        this._cancellable?.cancel();
        this._cancellable = null;

        this._cacheCancellable.cancel();

        if (this._menuStateId) {
            this.menu.disconnect(this._menuStateId);
            this._menuStateId = 0;
        }

        if (this._networkId) {
            this._network.disconnect(this._networkId);
            this._networkId = 0;
        }
        this._network = null;

        if (this._presenceId) {
            this._presence.disconnect(this._presenceId);
            this._presenceId = 0;
        }
        this._presence = null;

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];

        // Before the session they share is aborted.
        for (const [dialog, destroyId] of [...this._dialogs]) {
            // The handler only drops the dialog from the map, which clear()
            // below does for all of them at once.
            dialog.disconnect(destroyId);
            // popModal first: destroying an actor that still holds the grab
            // would leave the session modal with nothing on screen.
            dialog.popModal();
            dialog.destroy();
        }
        this._dialogs.clear();

        this._finance.destroy();
        this._finance = null;
        this._labels = [];
        this._icon = null;
        this._quotes.clear();
        this._settings = null;
        this._extension = null;

        super.destroy();
    }
});

export default class TopRatesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._migratePanelSymbol();
        this._placementIds = ['panel-position', 'panel-index'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._rebuild()));
        this._addIndicator();
    }

    /** Carry a pre-2.1 single panel symbol over to the list, once. */
    _migratePanelSymbol() {
        const legacy = this._settings.get_string('panel-symbol').trim();
        if (!legacy || this._settings.get_strv('panel-symbols').length > 0)
            return;
        this._settings.set_strv('panel-symbols', [legacy]);
        this._settings.reset('panel-symbol');
    }

    disable() {
        for (const id of this._placementIds ?? [])
            this._settings.disconnect(id);
        this._placementIds = [];

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _addIndicator() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }

    _rebuild() {
        this._indicator?.destroy();
        this._addIndicator();
    }
}
