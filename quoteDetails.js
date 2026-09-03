/*
 * The details window: what the Yahoo quote page shows, drawn in the shell.
 *
 * Clicking a symbol in the popup used to launch a browser. It opens this
 * instead — one modal per symbol, fed by the same chart endpoint the panel
 * polls, with the range tabs, the chart, the key statistics, the trailing
 * returns and the historical bars all read out of that one response.
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Finance from './finance.js';
import * as Widgets from './widgets.js';

// The long series behind the trailing returns. Five years of daily bars is
// what the shortest window (one week) and the longest (five years) both need.
const RETURNS_RANGE = '5y';
const RETURNS_INTERVAL = '1d';

// Moving averages are only drawn once the series is long enough to have
// something to say; a 200-bar average over 60 bars is a straight line.
const AVERAGES = [
    {period: 50, dash: []},
    {period: 200, dash: [4, 3]},
];

const HISTORY_ROWS = 90;
const CHART_HEIGHT = 300;

// The window's own tabs. Each names a slice of the report; the range tabs
// underneath keep applying to whichever slice is on screen, because both the
// risk figures and the historical table are cut from the selected range.
const OVERVIEW = 'overview';
const POSITION = 'position';
const PERFORMANCE = 'performance';
const HISTORY = 'history';

/*
 * Column widths for the historical table, as shares of the body.
 *
 * St hands every expanding child the same slack, so equal-weight cells drift
 * apart the moment one row's text is wider than another's — which is what a
 * volume column does on every other row. Pinning each column to a fixed share
 * puts the header and all ninety rows on one grid.
 */
const TABLE_WEIGHTS = [1.9, 1, 1, 1, 1, 1.15, 1.3];

// The window carries more numbers than the popup does, and reads better set a
// little tighter than the shell default — but only a little: below this the
// stat rows and the table stop being readable at arm's length.
const DIALOG_FONT_SCALE = 0.95;

/*
 * What the window costs outside the scroll view: the header, the two tab
 * rows, the status bar, the button box and the dialog's own padding.
 *
 * The scroll view is handed whatever is left of the monitor rather than a
 * fixed share of it, so the window still opens whole on a 14" laptop, where
 * the usable height is often 768px or less.
 */
const DIALOG_CHROME_HEIGHT = 330;

// Never poll the open dialog faster than this, whatever the panel is set to.
const MIN_DIALOG_REFRESH = 30;

/** A row of "label ......... value", the shape every stat block is built from. */
function statRow(label, value, valueClass = '') {
    const row = new St.BoxLayout({x_expand: true, style_class: 'toprates-stat'});
    row.add_child(new St.Label({
        text: label,
        style_class: 'toprates-stat-key',
        opacity: Widgets.MUTED_OPACITY,
        x_expand: true,
    }));
    row.add_child(new St.Label({
        text: value,
        style_class: `toprates-stat-value ${valueClass}`,
        x_align: Clutter.ActorAlign.END,
    }));
    return row;
}

// Full strength, unlike the labels under it: the titles are what the eye uses
// to find its way down a dense window, so they carry the weight.
function sectionTitle(text) {
    return new St.Label({
        text,
        style_class: 'toprates-section-title',
    });
}

/**
 * The row of wide-format figures that heads a tab, and one cell of it. The
 * chips carry the numbers a reader wants without scrolling, so both the
 * overview and the portfolio tab open with a row of them.
 */
function chipRow() {
    return new St.BoxLayout({x_expand: true, style_class: 'toprates-summary'});
}

function chip(row, label, value, valueClass = '') {
    const cell = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        style_class: 'toprates-chip',
    });
    cell.add_child(new St.Label({
        text: label,
        style_class: 'toprates-chip-key',
        opacity: Widgets.FAINT_OPACITY,
    }));
    cell.add_child(new St.Label({
        text: value,
        style_class: `toprates-chip-value ${valueClass}`,
    }));
    row.add_child(cell);
}

/** A titled block; the caller fills the returned box with rows. */
function section(title) {
    const box = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        style_class: 'toprates-section',
    });
    if (title)
        box.add_child(sectionTitle(title));
    return box;
}

export const QuoteDetails = GObject.registerClass(
class QuoteDetails extends ModalDialog.ModalDialog {
    _init(symbol, {settings, finance, quote, range, light, rates, portfolio}) {
        super._init({
            styleClass: 'toprates-dialog',
            destroyOnClose: true,
        });

        this._symbol = symbol;
        this._settings = settings;
        this._finance = finance;
        this._range = Finance.HISTORY_INTERVALS[range] ? range : Finance.DEFAULT_RANGE;
        // The gain/loss accents are tuned per theme variant, and the dialog is
        // its own actor tree: it has to carry the class itself.
        this._light = Boolean(light);
        // The popup's cached quote paints the header before the first request
        // comes back, so the window never opens empty.
        this._detail = quote ? {...quote, points: [], interval: ''} : null;
        // The panel fetches the FX rates and adds the positions up; the window
        // only re-prices this one holding, so it borrows both rather than
        // asking for them again. Both are snapshots: a rate that arrives after
        // the window opened moves the panel, not this.
        this._rates = rates ?? {};
        this._portfolio = portfolio ?? null;
        this._longSeries = null;
        // The benchmark for the range on screen, refetched with it: the two
        // series have to be cut the same way to be laid over one another.
        this._comparison = null;
        this._cancellable = null;
        this._timeoutId = 0;
        this._restoreId = 0;
        this._error = null;
        this._lastUpdate = null;
        this._view = OVERVIEW;
        // Until the first response lands the body holds a spinner, not a
        // report; the placeholder has to know which of the two is up.
        this._rendered = false;

        this._build();
        this._updateHeader();
        this._load(this._range);

        this.connect('destroy', () => this._onDestroy());
        this.connect('opened', () => this._startPolling());
        this.connect('closed', () => this._stopPolling());
    }

    // --- Layout ----------------------------------------------------------

    _build() {
        const monitor = Main.layoutManager.primaryMonitor;
        // Wide enough for the seven-column table and the two stat columns to
        // breathe, and still short of the monitor edge on a small screen —
        // the monitor wins over the preferred width, never the other way
        // round, or a 1366px panel gets a window it cannot show.
        const width = Math.max(600, Math.min(1120, monitor.width - 96));
        const height = Math.max(
            260, Math.min(Math.floor(monitor.height * 0.62),
                monitor.height - DIALOG_CHROME_HEIGHT));
        // The historical table lays its columns out against this.
        this._contentWidth = width;

        const content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'toprates-dialog-content',
        });
        // The popup's font preference applies here too; St inherits
        // font-family, so setting it on the container styles every label. The
        // size rides along: every class below is written in em, so one factor
        // here tightens the whole window — the chart's Cairo text included,
        // since that is measured off the theme node as well.
        const family = this._settings.get_string('font-family').trim();
        const font = family ? `font-family: "${family.replace(/"/g, '')}";` : '';
        content.set_style(`width: ${width}px; font-size: ${DIALOG_FONT_SCALE}em; ${font}`);
        if (this._light)
            content.add_style_class_name('toprates-light');
        this.contentLayout.add_child(content);

        content.add_child(this._buildHeader());
        content.add_child(this._buildViewTabs());
        content.add_child(this._buildRangeTabs());

        this._body = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'toprates-dialog-body',
        });
        this._scroll = new St.ScrollView({
            style_class: 'toprates-dialog-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._body,
        });
        this._scroll.set_style(`max-height: ${height}px;`);
        content.add_child(this._scroll);

        const status = new St.BoxLayout({
            x_expand: true,
            style_class: 'toprates-dialog-statusbar',
        });
        this._spinner = Widgets.createSpinner({size: 12});
        this._spinner.opacity = Widgets.MUTED_OPACITY;
        this._spinner.visible = false;
        status.add_child(this._spinner);
        this._statusLabel = new St.Label({
            text: _('Loading…'),
            style_class: 'toprates-dialog-status',
            opacity: Widgets.MUTED_OPACITY,
            y_align: Clutter.ActorAlign.CENTER,
        });
        status.add_child(this._statusLabel);
        content.add_child(status);

        this.addButton({
            label: _('Refresh'),
            action: () => this._load(this._range),
        });
        this.addButton({
            label: _('Open in Yahoo Finance'),
            action: () => {
                Gio.AppInfo.launch_default_for_uri(
                    `${Finance.QUOTE_PAGE}${encodeURIComponent(this._symbol)}`, null);
                this.close();
            },
        });
        this.addButton({
            label: _('Close'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
            default: true,
        });
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'toprates-dialog-header',
        });

        const left = new St.BoxLayout({vertical: true, x_expand: true});
        this._titleLabel = new St.Label({
            text: this._symbol,
            style_class: 'toprates-dialog-symbol',
        });
        left.add_child(this._titleLabel);
        this._nameLabel = new St.Label({
            text: '',
            style_class: 'toprates-dialog-name',
            opacity: Widgets.MUTED_OPACITY,
        });
        left.add_child(this._nameLabel);
        this._metaLabel = new St.Label({
            text: '',
            style_class: 'toprates-dialog-meta',
            opacity: Widgets.FAINT_OPACITY,
        });
        left.add_child(this._metaLabel);
        header.add_child(left);

        const right = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.END,
        });
        this._priceLabel = new St.Label({
            text: '—',
            style_class: 'toprates-dialog-price',
            x_align: Clutter.ActorAlign.END,
        });
        right.add_child(this._priceLabel);
        this._deltaLabel = new St.Label({
            text: '',
            style_class: 'toprates-dialog-delta',
            x_align: Clutter.ActorAlign.END,
        });
        right.add_child(this._deltaLabel);
        this._asOfLabel = new St.Label({
            text: '',
            style_class: 'toprates-dialog-asof',
            opacity: Widgets.FAINT_OPACITY,
            x_align: Clutter.ActorAlign.END,
        });
        right.add_child(this._asOfLabel);
        header.add_child(right);

        return header;
    }

    /*
     * The report's tabs. These pick what the body shows; the range tabs below
     * pick how much history it shows. Keeping them on separate rows keeps the
     * two questions from looking like one.
     */
    _buildViewTabs() {
        const tabs = new St.BoxLayout({
            x_expand: true,
            style_class: 'toprates-view-tabs',
        });

        this._views = new Map();
        for (const {view, label} of [
            {view: OVERVIEW, label: _('Overview')},
            {view: POSITION, label: _('Portfolio')},
            {view: PERFORMANCE, label: _('Performance')},
            {view: HISTORY, label: _('Historical data')},
        ]) {
            const button = new St.Button({
                label,
                style_class: 'toprates-view-tab',
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => this._showView(view));
            this._views.set(view, button);
            tabs.add_child(button);
        }
        this._updateViewTabs();
        return tabs;
    }

    /*
     * Which tabs are on offer, and which of them is open. The portfolio tab
     * only exists while the symbol is actually held, and holdings are edited
     * in a preferences window that can be open alongside this one: the check
     * is re-run on every render rather than settled once at build time. A
     * holding deleted underneath an open portfolio tab drops it to the
     * overview instead of leaving it on a tab with nothing to say.
     */
    _updateViewTabs() {
        const held = Boolean(this._holding());
        if (!held && this._view === POSITION)
            this._view = OVERVIEW;
        for (const [view, button] of this._views) {
            button.visible = view !== POSITION || held;
            if (view === this._view)
                button.add_style_class_name('toprates-view-tab-active');
            else
                button.remove_style_class_name('toprates-view-tab-active');
        }
    }

    /** Switching tabs re-reads the response already in hand; it never refetches. */
    _showView(view) {
        if (this._view === view)
            return;
        this._view = view;
        this._updateViewTabs();
        // A new tab starts at its own top rather than inheriting the last
        // tab's scroll position, which would land mid-section.
        this._scroll.vadjustment.set_value(0);
        // Before the first response there is nothing to re-cut; the request
        // in flight will draw straight into whichever tab is open by then.
        if (this._rendered)
            this._render();
    }

    _buildRangeTabs() {
        const tabs = new St.BoxLayout({
            x_expand: true,
            style_class: 'toprates-range-tabs',
        });

        this._tabs = new Map();
        for (const {range, label} of Finance.DETAIL_RANGES) {
            const button = new St.Button({
                label,
                style_class: 'toprates-range-tab',
                can_focus: true,
            });
            button.connect('clicked', () => {
                if (this._range !== range)
                    this._load(range);
            });
            this._tabs.set(range, button);
            tabs.add_child(button);
        }
        this._updateTabs();
        return tabs;
    }

    _updateTabs() {
        for (const [range, button] of this._tabs) {
            if (range === this._range)
                button.add_style_class_name('toprates-range-tab-active');
            else
                button.remove_style_class_name('toprates-range-tab-active');
        }
    }

    // --- Data ------------------------------------------------------------

    _load(range) {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._range = range;
        this._updateTabs();
        this._setLoading(true);

        const detail = this._finance.fetchDetail(this._symbol, range, cancellable);
        // The trailing-return series is fetched once per window and reused for
        // every range afterwards; a failure there costs one section, not the
        // whole dialog.
        const series = this._longSeries
            ? Promise.resolve(this._longSeries)
            : this._finance.fetchSeries(this._symbol, RETURNS_RANGE, RETURNS_INTERVAL,
                cancellable).catch(() => []);

        // A second request, and only when a benchmark is configured. It is
        // cut at the same range so the two series line up; a failure costs
        // the overlay and nothing else.
        const benchmark = this._benchmarkSymbol();
        const comparison = benchmark
            ? this._finance.fetchDetail(benchmark, range, cancellable)
                .then(loaded => ({symbol: benchmark, detail: loaded}))
                .catch(() => null)
            : Promise.resolve(null);

        Promise.all([detail, series, comparison]).then(([loaded, points, against]) => {
            if (cancellable.is_cancelled() || cancellable !== this._cancellable)
                return;
            this._detail = loaded;
            this._longSeries = points;
            this._comparison = against;
            this._error = null;
            this._lastUpdate = GLib.DateTime.new_now_local();
            this._setLoading(false);
            this._updateHeader();
            this._render();
            this._updateStatus();
        }).catch(error => {
            // A superseded request leaves the spinner to the one that
            // replaced it; only the request still in charge clears it.
            if (cancellable.is_cancelled() || cancellable !== this._cancellable)
                return;
            this._error = error.message;
            this._setLoading(false);
            // Nothing ever reached the body, so the placeholder is still
            // spinning over an empty report; it has to say what went wrong
            // rather than turn forever.
            if (!this._rendered)
                this._showBodyMessage(_('Could not load this symbol.'));
            this._updateStatus();
        });
    }

    _startPolling() {
        this._stopPolling();
        const interval = Math.max(MIN_DIALOG_REFRESH,
            this._settings.get_int('refresh-interval'));
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._load(this._range);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPolling() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    // --- Formatting helpers ----------------------------------------------

    _colorize() {
        return this._settings.get_boolean('colorize');
    }

    /** The configured benchmark, unless it is the symbol already plotted. */
    _benchmarkSymbol() {
        const benchmark = this._settings.get_string('benchmark').trim().toUpperCase();
        if (!benchmark || benchmark === this._symbol.toUpperCase())
            return '';
        return benchmark;
    }

    _baseCurrency() {
        return this._settings.get_string('base-currency').trim().toUpperCase();
    }

    /**
     * This symbol's holding, or null when it is only followed. Re-read from
     * the settings each time rather than captured at open, so a quantity
     * edited in preferences shows up here on the next render.
     */
    _holding() {
        try {
            return Finance.parseHoldings(
                this._settings.get_value('holdings').deepUnpack())
                .get(this._symbol.toUpperCase()) ?? null;
        } catch {
            return null;         // an unreadable key is an empty portfolio
        }
    }

    /**
     * The holding priced off the window's own quote rather than the panel's.
     * The two agree except in the seconds after a refresh, and it is this
     * window's price that the reader has in front of them.
     */
    _position(detail) {
        const holding = this._holding();
        if (!holding)
            return null;
        return Finance.positionOf(detail, holding, this._baseCurrency(), this._rates);
    }

    _changeStyle(percent) {
        if (!this._colorize() || !Number.isFinite(percent) || percent === 0)
            return 'toprates-flat';
        return percent > 0 ? 'toprates-up' : 'toprates-down';
    }

    _trend(percent) {
        return this._colorize() ? Finance.trendOf(percent) : 'flat';
    }

    _timezone() {
        return Finance.timeZoneOf(this._detail?.timezoneName);
    }

    /** Date formats follow the granularity: minutes intraday, years over 5y. */
    _formats() {
        const detail = this._detail;
        const intraday = Finance.isIntraday(detail?.interval);
        const points = detail?.points ?? [];
        const span = points.length > 1
            ? points[points.length - 1].time - points[0].time : 0;
        const years = span / (365 * 86400);

        if (intraday) {
            return {
                axis: '%H:%M',
                point: span > 86400 ? '%b %-d, %H:%M' : '%H:%M',
                table: span > 86400 ? '%b %-d  %H:%M' : '%H:%M',
            };
        }
        return {
            axis: years > 2 ? '%b %Y' : '%b %-d',
            point: '%a %b %-d, %Y',
            table: '%Y-%m-%d',
        };
    }

    // --- Rendering --------------------------------------------------------

    _updateHeader() {
        const detail = this._detail;
        if (!detail)
            return;

        this._titleLabel.text = detail.symbol ?? this._symbol;
        this._nameLabel.text = detail.longName || detail.name || '';
        this._nameLabel.visible = Boolean(this._nameLabel.text);

        const meta = [detail.fullExchange || detail.exchange, detail.type, detail.currency]
            .filter(part => part);
        const badge = Finance.marketLabel(detail.market);
        if (badge)
            meta.push(badge);
        this._metaLabel.text = meta.join('  ·  ');
        this._metaLabel.visible = meta.length > 0;

        this._priceLabel.text = Finance.formatPrice(detail.price, detail.currency);

        const moved = Finance.formatChange(detail.change);
        const percent = Finance.formatPercent(detail.percent);
        this._deltaLabel.text = moved ? `${moved}  (${percent})` : '';
        this._deltaLabel.visible = Boolean(this._deltaLabel.text);
        this._deltaLabel.style_class =
            `toprates-dialog-delta ${this._changeStyle(detail.percent)}`;

        if (Number.isFinite(detail.marketTime)) {
            const stamp = Finance.formatStamp(
                detail.marketTime, this._timezone(), '%b %-d, %H:%M');
            const zone = detail.timezoneAbbrev ? ` ${detail.timezoneAbbrev}` : '';
            this._asOfLabel.text = `${_('As of')} ${stamp}${zone}`;
            this._asOfLabel.visible = true;
        } else {
            this._asOfLabel.visible = false;
        }
    }

    _setStatus(text) {
        this._statusLabel.text = text;
    }

    _setLoading(loading) {
        this._spinner.visible = loading;
        if (!loading)
            return;
        this._setStatus(_('Loading…'));
        // On the first request there is nothing worth keeping on screen, so
        // the body says what it is waiting for instead of sitting blank
        // behind a twelve-pixel spinner in the corner. Later requests leave
        // the report up and let the status bar carry the news.
        if (!this._rendered)
            this._showLoadingPlaceholder();
    }

    _showLoadingPlaceholder() {
        this._showBodyMessage(_('Loading…'), true);
    }

    /** The body standing in for a report: a line, over a spinner while asked. */
    _showBodyMessage(text, spinning = false) {
        this._body.destroy_all_children();
        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'toprates-loading',
        });
        if (spinning)
            box.add_child(Widgets.createSpinner({size: 28}));
        box.add_child(new St.Label({
            text,
            style_class: 'toprates-dialog-empty',
            opacity: Widgets.MUTED_OPACITY,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._body.add_child(box);
    }

    _updateStatus() {
        const parts = [];
        if (this._lastUpdate)
            parts.push(`${_('Updated')} ${this._lastUpdate.format('%H:%M:%S')}`);
        if (this._error)
            parts.push(`${_('Last request failed')}: ${this._error}`);
        parts.push(_('Source: Yahoo Finance'));
        this._setStatus(parts.join('  ·  '));
    }

    _render() {
        const detail = this._detail;
        // A holding may have appeared or gone since the last draw, and the
        // tab strip is what says so.
        this._updateViewTabs();
        if (!detail?.points?.length) {
            this._rendered = false;
            this._body.destroy_all_children();
            this._body.add_child(new St.Label({
                text: _('No history for this range.'),
                style_class: 'toprates-dialog-empty',
                opacity: Widgets.MUTED_OPACITY,
            }));
            return;
        }

        const stats = Finance.periodStats(detail.points, detail.interval);
        // An automatic refresh should not throw the reader back to the top.
        const offset = this._scroll.vadjustment.value;

        this._body.destroy_all_children();
        for (const block of this._blocksFor(detail, stats))
            this._body.add_child(block);
        this._rendered = true;

        this._restoreOffset(offset);
    }

    /**
     * The blocks belonging to the open tab. Performance keeps the trailing
     * returns and the risk figures together — both answer "how did holding
     * this go", where the overview answers "what is it doing now".
     */
    _blocksFor(detail, stats) {
        if (this._view === POSITION)
            return this._positionBlocks(detail, stats).filter(block => block);
        if (this._view === PERFORMANCE) {
            return [
                this._performanceSection(),
                this._activitySection(detail, stats),
            ].filter(block => block);
        }
        if (this._view === HISTORY)
            return [this._historySection(detail)];

        const overlay = this._overlay(detail);
        return [
            this._chartSection(detail, stats, overlay),
            this._summarySection(detail, stats, overlay),
            this._statsSection(detail, stats),
            this._rangeMeterSection(detail),
        ];
    }

    /**
     * The benchmark rebased onto this symbol's first bar, or null when none is
     * configured, its request failed, or the two series never overlap.
     */
    _overlay(detail) {
        const against = this._comparison;
        if (!against?.detail?.points?.length)
            return null;
        const series = Finance.overlaySeries(detail.points, against.detail.points);
        if (!series)
            return null;
        return {...series, symbol: against.symbol};
    }

    _restoreOffset(offset) {
        if (offset <= 0)
            return;
        if (this._restoreId)
            GLib.Source.remove(this._restoreId);
        // The new children are allocated on the next idle; setting the value
        // before that would clamp it against a page that is still empty.
        this._restoreId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._restoreId = 0;
            this._scroll?.vadjustment.set_value(offset);
            return GLib.SOURCE_REMOVE;
        });
    }

    _chartSection(detail, stats, overlay = null) {
        const box = section(null);
        const formats = this._formats();
        const timezone = this._timezone();
        const trend = this._trend(stats.percent);

        // The readout doubles as the chart's caption: the period summary until
        // the pointer picks a bar out, that bar's own numbers while it does.
        const summary = `${detail.range.toUpperCase()}   ·   ` +
            `${Finance.formatBare(stats.low)} – ${Finance.formatBare(stats.high)}   ·   ` +
            `${stats.bars} ${_('bars')}`;
        const readout = new St.Label({
            text: summary,
            style_class: 'toprates-readout',
            opacity: Widgets.MUTED_OPACITY,
        });
        box.add_child(readout);

        const averages = [];
        for (const {period, dash} of AVERAGES) {
            if (detail.points.length < period)
                continue;
            averages.push({
                period,
                dash,
                values: Finance.movingAverage(detail.points.map(p => p.close), period),
            });
        }

        box.add_child(Widgets.createChart({
            points: detail.points,
            trend,
            height: CHART_HEIGHT,
            previousClose: detail.chartPreviousClose ?? detail.previous,
            averages,
            comparison: overlay,
            timezone,
            dateFormat: formats.axis,
            onHover: point => {
                readout.text = point
                    ? Widgets.describePoint(point, timezone, formats.point)
                    : summary;
            },
        }));

        const legend = new St.BoxLayout({x_expand: true, style_class: 'toprates-legend'});
        legend.add_child(new St.Label({
            text: `━ ${_('Close')}`,
            style_class: `toprates-legend-item ${this._changeStyle(
                this._colorize() ? stats.percent : 0)}`,
            opacity: Widgets.MUTED_OPACITY,
        }));
        legend.add_child(new St.Label({
            text: `┄ ${_('Previous close')}`,
            style_class: 'toprates-legend-item',
            opacity: Widgets.FAINT_OPACITY,
        }));
        for (const average of averages) {
            legend.add_child(new St.Label({
                text: `${average.dash.length ? '┄' : '─'} ${_('MA')}${average.period}`,
                style_class: 'toprates-legend-item',
                opacity: Widgets.FAINT_OPACITY,
            }));
        }
        if (overlay) {
            // The benchmark's own move over the range, so the dashed line is
            // readable as a number and not only as a shape.
            const move = Finance.formatPercent(overlay.percent);
            legend.add_child(new St.Label({
                text: `┄ ${overlay.symbol}${move ? ` ${move}` : ''}`,
                style_class: 'toprates-legend-item',
                opacity: Widgets.MUTED_OPACITY,
            }));
        }
        legend.add_child(new St.Label({
            text: `▁ ${_('Volume')}`,
            style_class: 'toprates-legend-item',
            opacity: Widgets.FAINT_OPACITY,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        }));
        box.add_child(legend);

        return box;
    }

    /** The chips under the chart: what the selected range actually did. */
    _summarySection(detail, stats, overlay = null) {
        const box = chipRow();

        chip(box, _('Period change'),
            `${Finance.formatChange(stats.change)} (${Finance.formatPercent(stats.percent)})`,
            this._changeStyle(stats.percent));
        chip(box, _('Period high'), Finance.formatBare(stats.high));
        chip(box, _('Period low'), Finance.formatBare(stats.low));
        chip(box, _('Period average'), Finance.formatBare(stats.average));
        if (Number.isFinite(stats.volumeAverage) && stats.volumeAverage > 0)
            chip(box, _('Avg volume'), Finance.formatVolume(stats.volumeAverage));
        // Both moves come out of the window the two series share, which on a
        // day chart of a European stock is the couple of hours New York was
        // also open: the gap between them is what holding this rather than the
        // benchmark was worth over exactly that stretch.
        if (overlay && Number.isFinite(overlay.percent) &&
            Number.isFinite(overlay.symbolPercent)) {
            const relative = overlay.symbolPercent - overlay.percent;
            chip(box, `${_('vs')} ${overlay.symbol}`,
                Finance.formatPercent(relative), this._changeStyle(relative));
        }

        return box;
    }

    /** The stat grid the quote page prints beneath its chart, in two columns. */
    _statsSection(detail, stats) {
        const box = section(_('Key statistics'));
        const columns = new St.BoxLayout({x_expand: true, style_class: 'toprates-columns'});
        const left = new St.BoxLayout({vertical: true, x_expand: true});
        const right = new St.BoxLayout({vertical: true, x_expand: true});
        columns.add_child(left);
        columns.add_child(right);
        box.add_child(columns);

        // The last bar carries today's open when the series is daily; on an
        // intraday series the first bar of the session does.
        const last = detail.points[detail.points.length - 1];
        const open = Finance.isIntraday(detail.interval)
            ? detail.points[0]?.open : last?.open;

        const fromHigh = Number.isFinite(detail.fiftyTwoWeekHigh) && detail.fiftyTwoWeekHigh
            ? ((detail.price - detail.fiftyTwoWeekHigh) / detail.fiftyTwoWeekHigh) * 100 : NaN;
        const fromLow = Number.isFinite(detail.fiftyTwoWeekLow) && detail.fiftyTwoWeekLow
            ? ((detail.price - detail.fiftyTwoWeekLow) / detail.fiftyTwoWeekLow) * 100 : NaN;

        left.add_child(statRow(_('Previous close'),
            Finance.formatBare(detail.previous)));
        left.add_child(statRow(_('Open'), Finance.formatBare(open)));
        left.add_child(statRow(_("Day's range"),
            Finance.formatSpan(detail.dayLow, detail.dayHigh)));
        left.add_child(statRow(_('52-week range'),
            Finance.formatSpan(detail.fiftyTwoWeekLow, detail.fiftyTwoWeekHigh)));
        left.add_child(statRow(_('From 52-week high'),
            Finance.formatPercent(fromHigh) || '—', this._changeStyle(fromHigh)));
        left.add_child(statRow(_('From 52-week low'),
            Finance.formatPercent(fromLow) || '—', this._changeStyle(fromLow)));
        left.add_child(statRow(_('Volume'), Finance.formatVolume(detail.volume)));
        left.add_child(statRow(_('Avg volume (period)'),
            Finance.formatVolume(stats.volumeAverage)));

        right.add_child(statRow(_('Exchange'),
            detail.fullExchange || detail.exchange || '—'));
        right.add_child(statRow(_('Type'), detail.type || '—'));
        right.add_child(statRow(_('Currency'), detail.currency || '—'));
        right.add_child(statRow(_('Market'),
            Finance.marketLabel(detail.market) || '—'));
        right.add_child(statRow(_('Exchange time'),
            Finance.formatStamp(Math.floor(Date.now() / 1000), this._timezone(),
                '%H:%M') + (detail.timezoneAbbrev ? ` ${detail.timezoneAbbrev}` : '')));
        right.add_child(statRow(_('Quote time'),
            Finance.formatStamp(detail.marketTime, this._timezone(), '%Y-%m-%d %H:%M')));
        right.add_child(statRow(_('First traded'),
            Finance.formatStamp(detail.firstTradeDate, this._timezone(), '%Y-%m-%d')));
        right.add_child(statRow(_('Granularity'),
            `${detail.interval} · ${detail.range}`));

        return box;
    }

    _rangeMeterSection(detail) {
        const box = section(_('52-week range'));
        const low = detail.fiftyTwoWeekLow;
        const high = detail.fiftyTwoWeekHigh;

        const position = Number.isFinite(low) && Number.isFinite(high) && high > low
            ? ((detail.price - low) / (high - low)) * 100 : NaN;

        box.add_child(Widgets.createLevelMeter({
            low, high,
            value: detail.price,
            trend: this._trend(detail.percent),
        }));

        const labels = new St.BoxLayout({x_expand: true, style_class: 'toprates-meter-labels'});
        labels.add_child(new St.Label({
            text: Finance.formatBare(low),
            style_class: 'toprates-axis-label',
            opacity: Widgets.MUTED_OPACITY,
            x_expand: true,
        }));
        labels.add_child(new St.Label({
            text: Number.isFinite(position)
                ? `${Finance.numberFormat('', 0).format(position)}% ${_('of range')}`
                : '',
            style_class: 'toprates-axis-label',
            opacity: Widgets.FAINT_OPACITY,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        labels.add_child(new St.Label({
            text: Finance.formatBare(high),
            style_class: 'toprates-axis-label',
            opacity: Widgets.MUTED_OPACITY,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        }));
        box.add_child(labels);

        return box;
    }

    // --- Portfolio -------------------------------------------------------

    /**
     * The portfolio tab: what holding this symbol is worth and what it has
     * done, for this symbol alone. Every figure is a quantity times a price
     * out of the same response the chart is drawn from, so the tab moves with
     * the window's own polling rather than with whatever the popup last saw.
     *
     * The range tabs keep applying here as they do everywhere else: the
     * period block re-prices the holding against the selected range's high,
     * low and change, which turns "down 4% over a year" into money.
     */
    _positionBlocks(detail, stats) {
        const position = this._position(detail);
        // The holding is there — the tab would not be — but the response came
        // back without a price to multiply it by. Say so rather than leave the
        // tab blank, which reads as a bug.
        if (!position) {
            return [new St.Label({
                text: _('No price for this symbol yet.'),
                style_class: 'toprates-dialog-empty',
                opacity: Widgets.MUTED_OPACITY,
            })];
        }

        return [
            this._positionSummary(position),
            this._positionSection(detail, position),
            this._positionPeriodSection(detail, stats, position),
            this._positionWeightSection(position),
        ];
    }

    /**
     * What share of the whole portfolio this position is, or NaN when that
     * cannot be answered honestly: the panel's total is short whenever a
     * holding could not be converted into the base currency, and a share of a
     * short total overstates itself.
     */
    _weight(position) {
        const total = this._portfolio;
        if (!total || total.missing > 0 || !(total.value > 0) ||
            !Number.isFinite(position.baseValue))
            return NaN;
        return (position.baseValue / total.value) * 100;
    }

    _positionSummary(position) {
        const row = chipRow();

        chip(row, _('Market value'),
            Finance.formatPrice(position.value, position.currency));
        chip(row, _("Day's change"),
            Finance.formatChange(position.dayChange) || '—',
            this._changeStyle(position.dayChange));
        // Only a holding entered with a cost has a gain. Without one the tab
        // says the basis is missing rather than reporting the whole position
        // as profit, which is what a zero cost would come to.
        if (Number.isFinite(position.gain)) {
            chip(row, _('Total gain/loss'),
                `${Finance.formatChange(position.gain)} ` +
                `(${Finance.formatPercent(position.gainPercent)})`,
                this._changeStyle(position.gainPercent));
        } else {
            chip(row, _('Total gain/loss'), _('No cost basis'));
        }

        const weight = this._weight(position);
        if (Number.isFinite(weight)) {
            chip(row, _('Share of portfolio'),
                `${Finance.numberFormat('', 1).format(weight)}%`);
        }

        return row;
    }

    /** The holding on the left, what it has come to on the right. */
    _positionSection(detail, position) {
        const box = section(_('Position'));
        const columns = new St.BoxLayout({x_expand: true, style_class: 'toprates-columns'});
        const left = new St.BoxLayout({vertical: true, x_expand: true});
        const right = new St.BoxLayout({vertical: true, x_expand: true});
        columns.add_child(left);
        columns.add_child(right);
        box.add_child(columns);

        const {currency} = position;
        left.add_child(statRow(_('Quantity'),
            Finance.formatQuantity(position.quantity)));
        left.add_child(statRow(_('Average cost'),
            Number.isFinite(position.cost)
                ? Finance.formatPrice(position.cost, currency) : '—'));
        left.add_child(statRow(_('Cost basis'),
            Finance.formatPrice(position.invested, currency)));
        left.add_child(statRow(_('Last price'),
            Finance.formatPrice(detail.price, currency)));
        left.add_child(statRow(_('Market value'),
            Finance.formatPrice(position.value, currency)));

        const day = Finance.formatChange(position.dayChange);
        const percent = Finance.formatPercent(detail.percent);
        right.add_child(statRow(_("Day's change"),
            day ? `${day}${percent ? ` (${percent})` : ''}` : '—',
            this._changeStyle(position.dayChange)));
        right.add_child(statRow(_('Unrealised gain'),
            Finance.formatChange(position.gain) || '—',
            this._changeStyle(position.gain)));
        right.add_child(statRow(_('Return on cost'),
            Finance.formatPercent(position.gainPercent) || '—',
            this._changeStyle(position.gainPercent)));

        // A position quoted in another currency is only half reported by its
        // own numbers: what it is worth to the holder is the converted one.
        const unit = Finance.majorUnitOf(currency);
        if (position.base && position.base !== unit.code) {
            const rate = Finance.convert(unit.factor, currency, position.base, this._rates);
            right.add_child(statRow(`${_('Value in')} ${position.base}`,
                Finance.formatPrice(position.baseValue, position.base)));
            right.add_child(statRow(_('Exchange rate'),
                Number.isFinite(rate)
                    ? `1 ${unit.code} = ${Finance.formatBare(rate)} ${position.base}`
                    : _('unavailable')));
        }

        return box;
    }

    /**
     * The holding measured over the range on screen. The same tabs that cut
     * the chart cut this, so switching to 1Y answers what a year of holding
     * this was worth without the reader multiplying anything out.
     */
    _positionPeriodSection(detail, stats, position) {
        const box = section(_('Over the selected range'));
        const {quantity, currency} = position;

        box.add_child(statRow(_('Change in value'),
            `${Finance.formatChange(quantity * stats.change)} ` +
            `(${Finance.formatPercent(stats.percent)})`,
            this._changeStyle(stats.percent)));
        box.add_child(statRow(_('Value at period open'),
            Finance.formatPrice(quantity * stats.first, currency)));
        box.add_child(statRow(_('Value at period high'),
            Finance.formatPrice(quantity * stats.high, currency)));
        box.add_child(statRow(_('Value at period low'),
            Finance.formatPrice(quantity * stats.low, currency)));
        // How far under its own high inside the range the position sat: the
        // paper loss someone watching it would have had to sit through.
        box.add_child(statRow(_('Peak-to-trough'),
            Finance.formatPercent(stats.drawdown) || '—',
            this._changeStyle(stats.drawdown)));

        return box;
    }

    /** Where this position sits in the whole: one bar, nothing to the total. */
    _positionWeightSection(position) {
        const weight = this._weight(position);
        if (!Number.isFinite(weight))
            return null;

        const total = this._portfolio;
        const box = section(_('Share of portfolio'));
        box.add_child(Widgets.createLevelMeter({
            low: 0,
            high: total.value,
            value: position.baseValue,
            trend: this._trend(position.gainPercent),
        }));

        const labels = new St.BoxLayout({x_expand: true, style_class: 'toprates-meter-labels'});
        labels.add_child(new St.Label({
            text: Finance.formatPrice(position.baseValue, position.base),
            style_class: 'toprates-axis-label',
            opacity: Widgets.MUTED_OPACITY,
            x_expand: true,
        }));
        labels.add_child(new St.Label({
            text: `${Finance.numberFormat('', 1).format(weight)}% ${_('of portfolio')}`,
            style_class: 'toprates-axis-label',
            opacity: Widgets.FAINT_OPACITY,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        labels.add_child(new St.Label({
            // The panel resolved the total's currency; without a base set it
            // is the one every position happened to share, not this one's.
            text: Finance.formatPrice(total.value, total.currency),
            style_class: 'toprates-axis-label',
            opacity: Widgets.MUTED_OPACITY,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        }));
        box.add_child(labels);

        return box;
    }

    /** Trailing returns, each with a bar scaled against the biggest of them. */
    _performanceSection() {
        const rows = Finance.trailingReturns(this._longSeries ?? []);
        if (rows.length === 0)
            return null;

        const box = section(_('Performance'));
        const scale = Math.max(...rows.map(row => Math.abs(row.percent)));

        for (const row of rows) {
            const line = new St.BoxLayout({x_expand: true, style_class: 'toprates-stat'});
            line.add_child(new St.Label({
                text: _(row.label),
                style_class: 'toprates-stat-key',
                opacity: Widgets.MUTED_OPACITY,
                width: 140,
            }));
            const bar = Widgets.createSignedBar({value: row.percent, scale});
            line.add_child(bar);
            line.add_child(new St.Label({
                text: Finance.formatPercent(row.percent),
                style_class: `toprates-stat-value ${this._changeStyle(row.percent)}`,
                x_align: Clutter.ActorAlign.END,
                width: 95,
            }));
            box.add_child(line);
        }

        return box;
    }

    /** How rough the selected range was, and how one-sided. */
    _activitySection(detail, stats) {
        const box = section(_('Risk and activity'));
        const columns = new St.BoxLayout({x_expand: true, style_class: 'toprates-columns'});
        const left = new St.BoxLayout({vertical: true, x_expand: true});
        const right = new St.BoxLayout({vertical: true, x_expand: true});
        columns.add_child(left);
        columns.add_child(right);
        box.add_child(columns);

        const formats = this._formats();
        const timezone = this._timezone();

        left.add_child(statRow(_('Volatility (annualised)'),
            Number.isFinite(stats.volatility)
                ? `${Finance.numberFormat('', 1).format(stats.volatility)}%` : '—'));
        left.add_child(statRow(_('Maximum drawdown'),
            Number.isFinite(stats.drawdown)
                ? Finance.formatPercent(stats.drawdown) : '—',
            this._changeStyle(stats.drawdown)));
        left.add_child(statRow(_('Bars up / down'),
            `${stats.advancing} / ${stats.declining}`));
        left.add_child(statRow(_('Total volume (period)'),
            Finance.formatVolume(stats.volumeTotal)));

        right.add_child(statRow(_('Best bar'),
            stats.best
                ? `${Finance.formatPercent(stats.best.percent)}  ·  ${Finance.formatStamp(stats.best.time, timezone, formats.table)}`
                : '—',
            this._changeStyle(stats.best?.percent)));
        right.add_child(statRow(_('Worst bar'),
            stats.worst
                ? `${Finance.formatPercent(stats.worst.percent)}  ·  ${Finance.formatStamp(stats.worst.time, timezone, formats.table)}`
                : '—',
            this._changeStyle(stats.worst?.percent)));
        right.add_child(statRow(_('Period high on'),
            Finance.formatStamp(stats.highAt, timezone, formats.table)));
        right.add_child(statRow(_('Period low on'),
            Finance.formatStamp(stats.lowAt, timezone, formats.table)));

        return box;
    }

    /**
     * Column widths in pixels, from the weights and the body's actual width.
     *
     * The gutter covers the scroll view's padding and the bar that appears
     * once ninety rows are in; leaving it out would let the last column slide
     * under the scrollbar the moment the table got long enough to need one.
     */
    _tableWidths() {
        const total = TABLE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
        const available = Math.max(420, this._contentWidth - 28);
        return TABLE_WEIGHTS.map(weight => Math.floor(available * weight / total));
    }

    /** The historical-data table, newest bar first, as the quote page lists it. */
    _historySection(detail) {
        const points = detail.points;
        const shown = Math.min(HISTORY_ROWS, points.length);
        const box = section(`${_('Historical data')}  ·  ${shown}/${points.length}`);
        const formats = this._formats();
        const timezone = this._timezone();
        const widths = this._tableWidths();

        // Fixed width plus text-align, rather than x_expand plus x_align: the
        // width is what holds the column, and the alignment then happens
        // inside it instead of by shoving the neighbours around.
        const cell = (text, column, extraClass = '') => new St.Label({
            text,
            style_class: `toprates-table-cell ${column === 0
                ? 'toprates-table-cell-label' : 'toprates-table-cell-number'} ${extraClass}`,
            width: widths[column],
        });

        const head = new St.BoxLayout({x_expand: true, style_class: 'toprates-table-head'});
        for (const [column, title] of [_('Date'), _('Open'), _('High'), _('Low'),
            _('Close'), _('Change'), _('Volume')].entries())
            head.add_child(cell(title, column));
        box.add_child(head);

        let stripe = 0;
        for (let i = points.length - 1; i >= points.length - shown; i--) {
            const point = points[i];
            const previous = points[i - 1]?.close;
            const move = Number.isFinite(previous) && previous
                ? ((point.close - previous) / previous) * 100 : NaN;

            const row = new St.BoxLayout({
                x_expand: true,
                style_class: `toprates-table-row${
                    stripe++ % 2 ? ' toprates-table-row-alt' : ''}`,
            });
            row.add_child(cell(
                Finance.formatStamp(point.time, timezone, formats.table), 0));
            row.add_child(cell(Finance.formatBare(point.open), 1));
            row.add_child(cell(Finance.formatBare(point.high), 2));
            row.add_child(cell(Finance.formatBare(point.low), 3));
            row.add_child(cell(Finance.formatBare(point.close), 4));
            row.add_child(cell(Finance.formatPercent(move) || '—', 5,
                this._changeStyle(move)));
            row.add_child(cell(Finance.formatVolume(point.volume), 6));
            box.add_child(row);
        }

        return box;
    }

    // --- Teardown ---------------------------------------------------------

    _onDestroy() {
        this._stopPolling();
        if (this._restoreId) {
            GLib.Source.remove(this._restoreId);
            this._restoreId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._finance = null;
        this._settings = null;
        this._detail = null;
        this._longSeries = null;
        this._comparison = null;
        this._tabs?.clear();
        this._views?.clear();
    }
});
