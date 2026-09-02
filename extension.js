import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// Yahoo's chart endpoint needs no API key or cookie, unlike v7/finance/quote.
const CHART_API = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const QUOTE_PAGE = 'https://finance.yahoo.com/quote/';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) toprates-gnome-extension';
const HTTP_TIMEOUT = 15;

// Yahoo rejects some range/interval pairs, so each range gets a sane granularity.
const HISTORY_INTERVALS = {
    '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d',
    '6mo': '1d', '1y': '1wk', '5y': '1mo',
};
const DEFAULT_RANGE = '1mo';

const GRAPH_COLORS = {
    up: [0.18, 0.76, 0.49],
    down: [0.88, 0.11, 0.14],
    flat: [0.60, 0.60, 0.62],
};

const CURRENCY_SYMBOLS = {
    USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'CHF ', CAD: 'CA$', AUD: 'A$',
};

function formatPrice(price, currency) {
    if (!Number.isFinite(price))
        return '—';

    const digits = Math.abs(price) < 10 ? 4 : 2;
    const value = price.toFixed(digits);
    const prefix = CURRENCY_SYMBOLS[currency];
    if (prefix)
        return `${prefix}${value}`;
    return currency ? `${value} ${currency}` : value;
}

function formatPercent(percent) {
    if (!Number.isFinite(percent))
        return '';
    const sign = percent > 0 ? '+' : percent < 0 ? '−' : '';
    return `${sign}${Math.abs(percent).toFixed(2)}%`;
}

/** Thin wrapper over the Yahoo chart endpoint. One request per symbol. */
class YahooFinance {
    constructor() {
        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: HTTP_TIMEOUT,
        });
    }

    async fetchQuote(symbol, range, cancellable) {
        const interval = HISTORY_INTERVALS[range] ?? HISTORY_INTERVALS[DEFAULT_RANGE];
        const uri = `${CHART_API}${encodeURIComponent(symbol)}` +
            `?interval=${interval}&range=${range}`;
        const message = Soup.Message.new('GET', uri);
        if (!message)
            throw new Error(`Invalid symbol: ${symbol}`);

        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);

        const status = message.get_status();
        if (status !== Soup.Status.OK)
            throw new Error(`HTTP ${status}`);

        const payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        const result = payload?.chart?.result?.[0];
        const meta = result?.meta;
        if (!meta) {
            const reason = payload?.chart?.error?.description ?? _('no data');
            throw new Error(reason);
        }

        const price = meta.regularMarketPrice;
        // chartPreviousClose is the close before the requested *range*, so it
        // only means "yesterday" for range=1d. The market's own percentage is
        // range-independent; fall back to the chart close when it is missing.
        const pct = meta.regularMarketChangePercent;
        const previous = Number.isFinite(pct) && Number.isFinite(price) && pct !== -100
            ? price / (1 + pct / 100)
            : meta.previousClose ?? meta.chartPreviousClose ?? price;
        const change = Number.isFinite(price) && Number.isFinite(previous)
            ? price - previous : NaN;
        const percent = Number.isFinite(change) && previous
            ? (change / previous) * 100 : NaN;

        // Yahoo pads the series with nulls for gaps in trading; drop them.
        const closes = (result?.indicators?.quote?.[0]?.close ?? [])
            .filter(v => Number.isFinite(v));

        return {
            symbol: meta.symbol ?? symbol,
            name: meta.shortName ?? meta.longName ?? '',
            currency: meta.currency ?? '',
            exchange: meta.exchangeName ?? '',
            price,
            change,
            percent,
            history: closes,
            previous,
        };
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}

/**
 * A minimal price sparkline: filled area plus a stroked line, scaled to the
 * min/max of the series. Drawn with Cairo on an St.DrawingArea.
 */
function createSparkline(history, trend, height) {
    const area = new St.DrawingArea({
        style_class: 'toprates-graph',
        height,
        x_expand: true,
    });

    area.connect('repaint', () => {
        const cr = area.get_context();
        const [width, h] = area.get_surface_size();
        const [r, g, b] = GRAPH_COLORS[trend] ?? GRAPH_COLORS.flat;

        const min = Math.min(...history);
        const max = Math.max(...history);
        const span = max - min;
        const pad = 2;
        const usable = Math.max(1, h - pad * 2);
        // A flat series would divide by zero; centre it instead.
        const y = value => span > 0
            ? pad + usable * (1 - (value - min) / span)
            : pad + usable / 2;
        const x = i => history.length > 1
            ? (width * i) / (history.length - 1) : width / 2;

        const trace = () => {
            cr.moveTo(x(0), y(history[0]));
            for (let i = 1; i < history.length; i++)
                cr.lineTo(x(i), y(history[i]));
        };

        // Area first, so the translucent fill cannot wash out the line.
        trace();
        cr.lineTo(x(history.length - 1), h);
        cr.lineTo(x(0), h);
        cr.closePath();
        cr.setSourceRGBA(r, g, b, 0.16);
        cr.fill();

        trace();
        cr.setLineWidth(2);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(r, g, b, 1);
        cr.stroke();

        cr.$dispose();
    });

    return area;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Top Rates', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._finance = new YahooFinance();
        this._quotes = new Map();     // symbol -> {quote} | {error}
        this._lastUpdate = null;
        this._timeoutId = 0;
        this._ageTimeoutId = 0;
        this._failures = 0;
        this._settingsIds = [];
        this._cancellable = null;
        this._destroyed = false;

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
            'show-graph', 'graph-height', 'show-icon'])
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => this._sync()));

        // Both change what has to be fetched, not just how it is drawn.
        for (const key of ['symbols', 'history-range'])
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => this._refresh()));
        this._settingsIds.push(
            this._settings.connect('changed::refresh-interval', () => this._startRefresh()));

        this._sync();
        this._refresh();
        this._startRefresh();
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

        // Refresh when the menu is opened after a long idle period.
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
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

    _historyRange() {
        const range = this._settings.get_string('history-range');
        return HISTORY_INTERVALS[range] ? range : DEFAULT_RANGE;
    }

    _trend(percent) {
        if (!Number.isFinite(percent) || percent === 0)
            return 'flat';
        return percent > 0 ? 'up' : 'down';
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

    _labelStyle() {
        return `font-size: ${this._settings.get_int('font-scale') / 100}em; ` +
            `font-weight: ${this._settings.get_int('font-weight')};`;
    }

    _addLabel(text, styleClass) {
        const label = new St.Label({
            text,
            style_class: styleClass,
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
                this._addLabel(separator, 'toprates-label toprates-separator');
            this._addLabel(...this._panelText(symbol));
        });
    }

    /** [text, style class] for one symbol in the panel. */
    _panelText(symbol) {
        const entry = this._quotes.get(symbol);
        if (!entry)
            return [`${symbol} …`, 'toprates-label'];
        if (entry.error)
            return [`${symbol} —`, 'toprates-label toprates-error'];

        const {price, currency, percent} = entry.quote;
        let text = `${symbol} ${formatPrice(price, currency)}`;
        if (this._settings.get_boolean('show-change')) {
            const change = formatPercent(percent);
            if (change)
                text += ` ${change}`;
        }
        return [text, `toprates-label ${this._changeStyle(percent)}`];
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

        for (const symbol of symbols)
            this._quoteSection.addMenuItem(this._createQuoteItem(symbol));
    }

    _createQuoteItem(symbol) {
        const entry = this._quotes.get(symbol);
        const item = new PopupMenu.PopupBaseMenuItem({style_class: 'toprates-quote'});

        // Header row on top, price history underneath it.
        const column = new St.BoxLayout({vertical: true, x_expand: true});
        const header = new St.BoxLayout({x_expand: true, style_class: 'toprates-quote-header'});

        const nameBox = new St.BoxLayout({vertical: true, x_expand: true});
        nameBox.add_child(new St.Label({
            text: symbol,
            style_class: 'toprates-symbol',
        }));
        const subtitle = entry?.quote?.name || entry?.quote?.exchange || '';
        if (subtitle) {
            nameBox.add_child(new St.Label({
                text: subtitle,
                style_class: 'toprates-subtitle',
            }));
        }
        header.add_child(nameBox);

        const valueBox = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.END});
        if (!entry) {
            valueBox.add_child(new St.Label({text: '…', style_class: 'toprates-price'}));
        } else if (entry.error) {
            valueBox.add_child(new St.Label({
                text: entry.error,
                style_class: 'toprates-price toprates-error',
            }));
        } else {
            const {price, currency, change, percent} = entry.quote;
            valueBox.add_child(new St.Label({
                text: formatPrice(price, currency),
                style_class: 'toprates-price',
            }));
            const delta = Number.isFinite(change)
                ? `${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change).toFixed(2)} (${formatPercent(percent)})`
                : '';
            if (delta) {
                valueBox.add_child(new St.Label({
                    text: delta,
                    style_class: `toprates-change ${this._changeStyle(percent)}`,
                }));
            }
        }
        header.add_child(valueBox);
        column.add_child(header);

        const graph = this._createGraph(entry);
        if (graph)
            column.add_child(graph);

        item.add_child(column);

        item.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(
                `${QUOTE_PAGE}${encodeURIComponent(symbol)}`, null);
        });

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
        box.add_child(createSparkline(
            history, trend, this._settings.get_int('graph-height')));

        const first = history[0];
        const last = history[history.length - 1];
        const move = first ? ((last - first) / first) * 100 : NaN;
        const caption = new St.BoxLayout({x_expand: true, style_class: 'toprates-graph-caption'});
        caption.add_child(new St.Label({
            text: this._historyRange(),
            style_class: 'toprates-range',
            x_expand: true,
        }));
        caption.add_child(new St.Label({
            text: formatPercent(move),
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
        if (!this._lastUpdate)
            return;

        const stamp = this._lastUpdate.format('%H:%M:%S');
        this._setStatus(this._failures
            ? `${_('Updated')} ${stamp} (${this._ageText()}) · ${this._failures} ${_('failed')}`
            : `${_('Updated')} ${stamp} (${this._ageText()})`);
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

        const range = this._historyRange();

        const results = await Promise.allSettled(
            symbols.map(symbol => this._finance.fetchQuote(symbol, range, cancellable)));

        // A newer refresh (or teardown) started while we were waiting.
        if (this._destroyed || cancellable.is_cancelled() || cancellable !== this._cancellable)
            return;

        let failures = 0;
        symbols.forEach((symbol, i) => {
            const result = results[i];
            if (result.status === 'fulfilled') {
                this._quotes.set(symbol, {quote: result.value});
            } else {
                failures += 1;
                this._quotes.set(symbol, {error: result.reason?.message ?? _('error')});
            }
        });

        // Drop quotes for symbols that are no longer followed.
        for (const symbol of [...this._quotes.keys()]) {
            if (!symbols.includes(symbol))
                this._quotes.delete(symbol);
        }

        this._lastUpdate = GLib.DateTime.new_now_local();
        this._failures = failures;
        this._updateStatus();

        this._sync();
    }

    _startRefresh() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        const interval = this._settings.get_int('refresh-interval');
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
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

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];

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
