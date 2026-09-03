/*
 * The Yahoo Finance client and the value formatting built on top of it.
 *
 * Kept apart from the shell widgets so the panel indicator and the details
 * window share one parser and one set of formatters rather than two that
 * drift.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// Marks a literal for extraction without translating it at module scope,
// where the gettext domain is not bound yet. Callers pass it through _().
const N_ = s => s;

// Yahoo's chart endpoint needs no API key or cookie, unlike v7/finance/quote
// and v10/finance/quoteSummary, which both answer "Unauthorized" now. Every
// number the details window shows is therefore read out of this one response.
const CHART_API = 'https://query1.finance.yahoo.com/v8/finance/chart/';
export const QUOTE_PAGE = 'https://finance.yahoo.com/quote/';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) toprates-gnome-extension';
const HTTP_TIMEOUT = 15;

// Yahoo rejects some range/interval pairs, so each range gets a sane
// granularity. These are the panel's: coarse enough that a sparkline a couple
// of hundred pixels wide is not fetching points it cannot draw.
export const HISTORY_INTERVALS = {
    '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d',
    '6mo': '1d', 'ytd': '1d', '1y': '1wk', '5y': '1mo', 'max': '3mo',
};

// The details window draws a chart ten times the size, so the longer ranges
// are worth a finer series there.
const DETAIL_INTERVALS = {
    '1y': '1d', '5y': '1wk', 'max': '1mo',
};

export const DEFAULT_RANGE = '1mo';

/** The range buttons in the details window, in the order they are drawn. */
export const DETAIL_RANGES = [
    {range: '1d', label: '1D'},
    {range: '5d', label: '5D'},
    {range: '1mo', label: '1M'},
    {range: '3mo', label: '3M'},
    {range: '6mo', label: '6M'},
    {range: 'ytd', label: 'YTD'},
    {range: '1y', label: '1Y'},
    {range: '5y', label: '5Y'},
    {range: 'max', label: 'MAX'},
];

function intervalFor(range, detailed) {
    if (detailed && DETAIL_INTERVALS[range])
        return DETAIL_INTERVALS[range];
    return HISTORY_INTERVALS[range] ?? HISTORY_INTERVALS[DEFAULT_RANGE];
}

/** True for the granularities that resolve single days or finer. */
export function isIntraday(interval) {
    return /^\d+m$/.test(interval ?? '') || /^\d+h$/.test(interval ?? '');
}

// Intl knows every currency and the user's own grouping and decimal marks;
// the formatters cost enough to build that they are worth keeping around.
const NUMBER_FORMATS = new Map();

// Some markets are quoted in minor units: London in pence, Johannesburg in
// cents, Tel Aviv in agorot. Intl accepts these codes but renders them with
// the major unit's symbol, turning 88.5 pence into "£88.50". They are shown
// as a plain number plus the raw code instead -- and converted to the major
// unit before any FX rate is applied, since the pairs quote GBP, not GBp.
const MINOR_UNITS = {
    GBp: {code: 'GBP', factor: 100},
    GBX: {code: 'GBP', factor: 100},
    ZAc: {code: 'ZAR', factor: 100},
    ILA: {code: 'ILS', factor: 100},
};

const MINOR_UNIT_CURRENCIES = new Set(Object.keys(MINOR_UNITS));

/** The major unit a price is really in, and what to divide by to get there. */
export function majorUnitOf(currency) {
    const code = (currency ?? '').trim();
    return MINOR_UNITS[code] ?? {code: code.toUpperCase(), factor: 1};
}

export function numberFormat(currency, digits) {
    const key = `${currency}/${digits}`;
    if (!NUMBER_FORMATS.has(key)) {
        const options = {minimumFractionDigits: digits, maximumFractionDigits: digits};
        let format = null;
        try {
            format = new Intl.NumberFormat(undefined,
                currency ? {...options, style: 'currency', currency} : options);
        } catch {
            // Yahoo reports a few codes Intl rejects, GBp for pence among
            // them. Those fall back to a plain number plus the raw code.
        }
        NUMBER_FORMATS.set(key, format);
    }
    return NUMBER_FORMATS.get(key);
}

/** Sub-10 prices need more decimals: pennies and small crypto live there. */
export function priceDigits(price) {
    return Math.abs(price) < 10 ? 4 : 2;
}

function signOf(value) {
    return value > 0 ? '+' : value < 0 ? '−' : '';
}

export function formatPrice(price, currency) {
    if (!Number.isFinite(price))
        return '—';

    const digits = priceDigits(price);
    const format = MINOR_UNIT_CURRENCIES.has(currency)
        ? null : numberFormat(currency, digits);
    if (format)
        return format.format(price);

    const value = numberFormat('', digits).format(price);
    return currency ? `${value} ${currency}` : value;
}

/** A price without its currency: for axes and tables, where it repeats. */
export function formatBare(price) {
    if (!Number.isFinite(price))
        return '—';
    return numberFormat('', priceDigits(price)).format(price);
}

/** The absolute move, signed and grouped: "+1,234.56". */
export function formatChange(change) {
    if (!Number.isFinite(change))
        return '';
    return `${signOf(change)}${numberFormat('', 2).format(Math.abs(change))}`;
}

export function formatPercent(percent) {
    if (!Number.isFinite(percent))
        return '';
    return `${signOf(percent)}${numberFormat('', 2).format(Math.abs(percent))}%`;
}

/**
 * A held quantity: whole shares plain, fractions to as many places as they
 * were entered with. A price format would print "10.00" for ten shares, or
 * round a fraction of a bitcoin away entirely.
 */
export function formatQuantity(quantity) {
    if (!Number.isFinite(quantity))
        return '—';
    try {
        return new Intl.NumberFormat(undefined, {
            minimumFractionDigits: 0, maximumFractionDigits: 8,
        }).format(quantity);
    } catch {
        return String(quantity);
    }
}

/** "1.23M" — share counts run to nine digits and would swamp a stat row. */
export function formatVolume(volume) {
    if (!Number.isFinite(volume))
        return '—';
    try {
        return new Intl.NumberFormat(undefined, {
            notation: 'compact', maximumFractionDigits: 2,
        }).format(volume);
    } catch {
        // Compact notation is ES2020; a very old ICU would reject it.
        return numberFormat('', 0).format(volume);
    }
}

/** "165.50 – 166.96": a low-high pair, as Yahoo prints its day range. */
export function formatSpan(low, high) {
    if (!Number.isFinite(low) || !Number.isFinite(high))
        return '—';
    return `${formatBare(low)} – ${formatBare(high)}`;
}

/**
 * The exchange's own clock. Prices are stamped in it, and reading "at close
 * 17:36" in Berlin time is what the quote page shows too.
 */
export function timeZoneOf(name) {
    try {
        return GLib.TimeZone.new_identifier(name) ?? GLib.TimeZone.new_local();
    } catch {
        return GLib.TimeZone.new_local();
    }
}

export function formatStamp(unix, timezone, format) {
    if (!Number.isFinite(unix))
        return '—';
    const when = GLib.DateTime.new_from_unix_utc(unix).to_timezone(
        timezone ?? GLib.TimeZone.new_local());
    return when?.format(format) ?? '—';
}

/**
 * Which session the exchange is in. The chart endpoint carries no marketState,
 * but currentTradingPeriod gives the pre/regular/post windows in epoch seconds
 * for the symbol's own exchange, which answers the same question.
 */
export function marketStateOf(meta, now) {
    const periods = meta?.currentTradingPeriod;
    if (!periods)
        return 'unknown';

    const within = w => Number.isFinite(w?.start) && now >= w.start && now < w.end;
    if (within(periods.regular))
        return 'regular';
    if (within(periods.pre))
        return 'pre';
    if (within(periods.post))
        return 'post';
    return 'closed';
}

export function marketLabel(state) {
    switch (state) {
    case 'pre':
        return _('Pre-market');
    case 'post':
        return _('After hours');
    case 'closed':
        return _('Closed');
    case 'regular':
        return _('Open');
    default:
        return '';
    }
}

export function trendOf(percent) {
    if (!Number.isFinite(percent) || percent === 0)
        return 'flat';
    return percent > 0 ? 'up' : 'down';
}

/**
 * The scalars every caller needs, pulled out of one chart response.
 *
 * chartPreviousClose is the close before the requested *range*, so it only
 * means "yesterday" for range=1d. The market's own percentage is
 * range-independent; fall back to the chart close when it is missing.
 */
function parseMeta(meta, symbol) {
    const price = meta.regularMarketPrice;
    const pct = meta.regularMarketChangePercent;
    const previous = Number.isFinite(pct) && Number.isFinite(price) && pct !== -100
        ? price / (1 + pct / 100)
        : meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = Number.isFinite(price) && Number.isFinite(previous)
        ? price - previous : NaN;
    const percent = Number.isFinite(change) && previous
        ? (change / previous) * 100 : NaN;

    return {
        symbol: meta.symbol ?? symbol,
        market: marketStateOf(meta, Math.floor(Date.now() / 1000)),
        name: meta.shortName ?? meta.longName ?? '',
        longName: meta.longName ?? meta.shortName ?? '',
        currency: meta.currency ?? '',
        exchange: meta.exchangeName ?? '',
        fullExchange: meta.fullExchangeName ?? meta.exchangeName ?? '',
        type: meta.instrumentType ?? '',
        timezoneName: meta.exchangeTimezoneName ?? '',
        timezoneAbbrev: meta.timezone ?? '',
        marketTime: meta.regularMarketTime,
        firstTradeDate: meta.firstTradeDate,
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
        volume: meta.regularMarketVolume,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        price,
        change,
        percent,
        previous,
    };
}

/** The dated OHLC bars of a chart response, holes dropped. */
function pointsOf(result) {
    const stamps = result.timestamp ?? [];
    const bars = result.indicators?.quote?.[0] ?? {};
    const points = [];
    for (let i = 0; i < stamps.length; i++) {
        const close = bars.close?.[i];
        // A bar with no close is a hole in the series, not a zero.
        if (!Number.isFinite(close))
            continue;
        points.push({
            time: stamps[i],
            open: bars.open?.[i],
            high: bars.high?.[i],
            low: bars.low?.[i],
            close,
            volume: bars.volume?.[i],
        });
    }
    return points;
}

/** Thin wrapper over the Yahoo chart endpoint. One request per symbol. */
export class YahooFinance {
    constructor() {
        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: HTTP_TIMEOUT,
        });
    }

    async _fetchChart(symbol, range, interval, cancellable) {
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
        if (!result?.meta) {
            const reason = payload?.chart?.error?.description ?? _('no data');
            throw new Error(reason);
        }
        return result;
    }

    /** What the panel and the popup need: scalars plus a closing series. */
    async fetchQuote(symbol, range, cancellable) {
        const result = await this._fetchChart(
            symbol, range, intervalFor(range, false), cancellable);

        // Yahoo pads the series with nulls for gaps in trading; drop them.
        const closes = (result.indicators?.quote?.[0]?.close ?? [])
            .filter(v => Number.isFinite(v));

        return {...parseMeta(result.meta, symbol), history: closes};
    }

    /**
     * A dated series at an explicit granularity. The details window pulls five
     * years of daily bars this way to work its trailing returns out, which no
     * single chart range gives at the resolution the shortest window needs.
     */
    async fetchSeries(symbol, range, interval, cancellable) {
        const result = await this._fetchChart(symbol, range, interval, cancellable);
        return pointsOf(result);
    }

    /** The same, plus the dated OHLC bars the details window tabulates. */
    async fetchDetail(symbol, range, cancellable) {
        const interval = intervalFor(range, true);
        const result = await this._fetchChart(symbol, range, interval, cancellable);

        const points = pointsOf(result);

        return {
            ...parseMeta(result.meta, symbol),
            range,
            interval,
            points,
            history: points.map(p => p.close),
            chartPreviousClose: result.meta.chartPreviousClose,
        };
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}

// --- Analytics ------------------------------------------------------------
//
// Everything below is derived from a series the client already fetched. Yahoo
// publishes the same figures behind endpoints that now demand a crumb, so the
// details window computes them instead of asking for them.

/** Simple moving average; the first period-1 slots stay empty. */
export function movingAverage(values, period) {
    const out = new Array(values.length).fill(NaN);
    if (values.length < period)
        return out;

    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i];
        if (i >= period)
            sum -= values[i - period];
        if (i >= period - 1)
            out[i] = sum / period;
    }
    return out;
}

/** Bars in a trading year, for annualising a standard deviation. */
const BARS_PER_YEAR = {'1d': 252, '1wk': 52, '1mo': 12, '3mo': 4};

/**
 * The summary strip under the chart: what the selected range did, how busy it
 * was, and how rough the ride was.
 */
export function periodStats(points, interval) {
    if (!points || points.length === 0)
        return null;

    const closes = points.map(p => p.close);
    const first = closes[0];
    const last = closes[closes.length - 1];

    let high = -Infinity, low = Infinity, highAt = null, lowAt = null;
    let volumeTotal = 0, volumeBars = 0;
    for (const point of points) {
        const top = Number.isFinite(point.high) ? point.high : point.close;
        const bottom = Number.isFinite(point.low) ? point.low : point.close;
        if (top > high) {
            high = top;
            highAt = point.time;
        }
        if (bottom < low) {
            low = bottom;
            lowAt = point.time;
        }
        if (Number.isFinite(point.volume)) {
            volumeTotal += point.volume;
            volumeBars += 1;
        }
    }

    // Bar-to-bar returns drive the volatility, the best and worst bars and the
    // share of bars that closed up.
    const returns = [];
    let best = null, worst = null, advancing = 0;
    for (let i = 1; i < points.length; i++) {
        const previous = closes[i - 1];
        if (!previous)
            continue;
        const move = ((closes[i] - previous) / previous) * 100;
        returns.push(move);
        if (move > 0)
            advancing += 1;
        if (!best || move > best.percent)
            best = {percent: move, time: points[i].time};
        if (!worst || move < worst.percent)
            worst = {percent: move, time: points[i].time};
    }

    let volatility = NaN;
    const scale = BARS_PER_YEAR[interval];
    if (scale && returns.length > 2) {
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) /
            (returns.length - 1);
        volatility = Math.sqrt(variance) * Math.sqrt(scale);
    }

    // Peak to trough, the worst loss someone who bought at the top of the
    // period would have sat through.
    let peak = closes[0];
    let drawdown = 0;
    for (const close of closes) {
        if (close > peak)
            peak = close;
        if (peak > 0)
            drawdown = Math.min(drawdown, ((close - peak) / peak) * 100);
    }

    return {
        first, last, high, low, highAt, lowAt,
        change: last - first,
        percent: first ? ((last - first) / first) * 100 : NaN,
        average: closes.reduce((a, b) => a + b, 0) / closes.length,
        volumeAverage: volumeBars ? volumeTotal / volumeBars : NaN,
        volumeTotal: volumeBars ? volumeTotal : NaN,
        volatility,
        drawdown,
        best, worst,
        bars: points.length,
        advancing,
        declining: returns.length - advancing,
    };
}

// Trailing windows, in days back from the last bar. YTD is handled apart,
// since its length depends on the date.
const TRAILING_WINDOWS = [
    {key: '1w', label: N_('1 week'), days: 7},
    {key: '1mo', label: N_('1 month'), days: 30},
    {key: '3mo', label: N_('3 months'), days: 91},
    {key: '6mo', label: N_('6 months'), days: 182},
    {key: 'ytd', label: N_('Year to date'), days: null},
    {key: '1y', label: N_('1 year'), days: 365},
    {key: '3y', label: N_('3 years'), days: 1095},
    {key: '5y', label: N_('5 years'), days: 1826},
];

/**
 * Return over each trailing window, from a long daily series. A window that
 * starts before the series does is left out rather than reported against a
 * truncated history, which would overstate it.
 */
export function trailingReturns(points) {
    if (!points || points.length < 2)
        return [];

    const last = points[points.length - 1];
    const yearStart = GLib.DateTime.new_local(
        GLib.DateTime.new_now_local().get_year(), 1, 1, 0, 0, 0).to_unix();

    const rows = [];
    for (const window of TRAILING_WINDOWS) {
        const cutoff = window.days === null
            ? yearStart : last.time - window.days * 86400;
        // A series fetched for exactly five years starts on the five-year
        // cutoff, and a listing gap or a weekend puts its first bar just after
        // it. A grace of a tenth of the window keeps that row rather than
        // dropping it; anything later really is a short history.
        const grace = window.days ? Math.min(7, window.days * 0.15) * 86400 : 0;
        if (points[0].time > cutoff + grace)
            continue;

        // The first bar at or after the cutoff is the reference close.
        const reference = points.find(p => p.time >= cutoff);
        if (!reference || !reference.close || reference === last)
            continue;

        rows.push({
            key: window.key,
            label: window.label,
            percent: ((last.close - reference.close) / reference.close) * 100,
            from: reference.time,
        });
    }
    return rows;
}

// --- Currency conversion ---------------------------------------------------
//
// A portfolio spread over several markets only adds up once every position is
// expressed in one currency. Yahoo quotes the pairs as ordinary symbols
// ("EURUSD=X"), so the same chart endpoint answers for them too.

/** Yahoo's ticker for one currency against another. */
export function fxSymbol(from, to) {
    return `${from}${to}=X`;
}

/**
 * The pairs needed to bring every one of `currencies` into `base`, with the
 * minor units resolved first: a London holding needs GBPEUR=X, not GBpEUR=X.
 * Nothing is asked for when the currency already is the base.
 */
export function fxSymbolsFor(currencies, base) {
    const target = (base ?? '').trim().toUpperCase();
    const wanted = new Set();
    if (!target)
        return [];
    for (const currency of currencies) {
        const {code} = majorUnitOf(currency);
        if (code && code !== target)
            wanted.add(fxSymbol(code, target));
    }
    return [...wanted];
}

/**
 * `value`, quoted in `from`, expressed in `to`. `rates` is a plain map of the
 * symbols above to their price; the inverse pair is used when only it is
 * known, since one request answers both directions. NaN when the rate is
 * missing, which the caller reports rather than silently dropping.
 */
export function convert(value, from, to, rates) {
    if (!Number.isFinite(value))
        return NaN;

    const target = (to ?? '').trim().toUpperCase();
    const {code, factor} = majorUnitOf(from);
    const major = value / factor;
    if (!target || !code)
        return NaN;
    if (code === target)
        return major;

    const direct = rates?.[fxSymbol(code, target)];
    if (Number.isFinite(direct))
        return major * direct;

    const inverse = rates?.[fxSymbol(target, code)];
    if (Number.isFinite(inverse) && inverse !== 0)
        return major / inverse;

    return NaN;
}

// --- Portfolio -------------------------------------------------------------

/**
 * One holding, as the settings store it: a quantity and an optional cost per
 * share, both written with a dot as the decimal mark so the value survives a
 * change of locale. A zero quantity is not a position.
 */
export function parseHolding(value) {
    const parts = String(value ?? '').trim().split(/\s+/);
    const quantity = Number.parseFloat(parts[0]);
    if (!Number.isFinite(quantity) || quantity === 0)
        return null;
    const cost = Number.parseFloat(parts[1]);
    return {quantity, cost: Number.isFinite(cost) && cost > 0 ? cost : NaN};
}

/**
 * Every holding the settings key carries, keyed in upper case so a symbol
 * spelled either way in the followed list still finds its position. Entries
 * that do not parse are left out rather than counted as zero.
 */
export function parseHoldings(stored) {
    const holdings = new Map();
    for (const [symbol, value] of Object.entries(stored ?? {})) {
        const holding = parseHolding(value);
        if (holding)
            holdings.set(symbol.trim().toUpperCase(), holding);
    }
    return holdings;
}

/** The inverse of parseHolding, for writing the settings key back. */
export function formatHolding(holding) {
    if (!holding || !Number.isFinite(holding.quantity) || holding.quantity === 0)
        return '';
    const quantity = String(holding.quantity);
    return Number.isFinite(holding.cost) && holding.cost > 0
        ? `${quantity} ${holding.cost}` : quantity;
}

/**
 * What a holding is worth, in its own currency and in the base one.
 *
 * The base figures are NaN when no rate is available, so a total can say how
 * many positions it managed to count instead of quietly understating itself.
 */
export function positionOf(quote, holding, base, rates) {
    if (!quote || !holding || !Number.isFinite(quote.price))
        return null;

    const {quantity, cost} = holding;
    const value = quantity * quote.price;
    const dayChange = Number.isFinite(quote.change) ? quantity * quote.change : NaN;
    const invested = Number.isFinite(cost) ? quantity * cost : NaN;
    const gain = Number.isFinite(invested) ? value - invested : NaN;
    const gainPercent = Number.isFinite(gain) && invested ? (gain / invested) * 100 : NaN;

    const currency = quote.currency ?? '';
    const target = (base ?? '').trim().toUpperCase();
    // With no base currency set, a holding still counts towards a total as
    // long as every other one is quoted the same way; the caller checks that.
    const into = target || majorUnitOf(currency).code;

    return {
        quantity, cost, currency, value, dayChange, invested, gain, gainPercent,
        base: into,
        baseValue: convert(value, currency, into, rates),
        baseDayChange: convert(dayChange, currency, into, rates),
        baseInvested: convert(invested, currency, into, rates),
    };
}

/**
 * The portfolio line: every position that could be expressed in the base
 * currency, added up. `missing` counts the ones that could not be, so the
 * popup can say the total is short rather than print a wrong number.
 */
export function portfolioTotals(positions) {
    let value = 0, dayChange = 0, invested = 0, investedValue = 0;
    let counted = 0, missing = 0, priced = 0;

    for (const position of positions) {
        if (!position)
            continue;
        if (!Number.isFinite(position.baseValue)) {
            missing += 1;
            continue;
        }
        value += position.baseValue;
        counted += 1;
        if (Number.isFinite(position.baseDayChange))
            dayChange += position.baseDayChange;
        // The gain is only over the positions that carry a cost basis; mixing
        // in the ones that do not would report a loss the size of their value.
        if (Number.isFinite(position.baseInvested)) {
            invested += position.baseInvested;
            investedValue += position.baseValue;
            priced += 1;
        }
    }

    if (counted === 0)
        return null;

    const previous = value - dayChange;
    const gain = priced > 0 ? investedValue - invested : NaN;
    return {
        value, dayChange, invested, counted, missing, priced, gain,
        dayPercent: previous ? (dayChange / previous) * 100 : NaN,
        gainPercent: priced > 0 && invested ? (gain / invested) * 100 : NaN,
    };
}

// --- Comparison series -----------------------------------------------------

/** The commonest gap between bars, used as the tolerance when aligning. */
function medianStep(points) {
    const steps = [];
    for (let i = 1; i < points.length; i++)
        steps.push(points[i].time - points[i - 1].time);
    if (steps.length === 0)
        return 0;
    steps.sort((a, b) => a - b);
    return steps[Math.floor(steps.length / 2)];
}

/**
 * `other` read onto `points`' timeline: for each bar, the other series' last
 * close at that moment. Two exchanges do not stamp the same trading day
 * alike -- Yahoo dates a daily bar from the session open, so New York's bar
 * lands hours after Frankfurt's -- hence the half-bar tolerance, without
 * which every value would come from the day before. Slots before the other
 * series begins stay NaN.
 */
export function alignTo(points, other) {
    const aligned = new Array(points?.length ?? 0).fill(NaN);
    if (!points?.length || !other?.length)
        return aligned;

    const tolerance = Math.floor(medianStep(points) / 2);
    let index = 0;
    let last = NaN;
    for (let i = 0; i < points.length; i++) {
        const limit = points[i].time + tolerance;
        while (index < other.length && other[index].time <= limit) {
            last = other[index].close;
            index += 1;
        }
        aligned[i] = last;
    }
    return aligned;
}

/**
 * The benchmark drawn in the plotted symbol's own prices: what the same money
 * would have done had it tracked the benchmark from the first bar they share.
 * Null when they share none.
 *
 * The two series rarely cover the same ground. A day chart of a European stock
 * runs from 09:00 local, while New York opens six hours later, so an S&P
 * overlay exists for the last couple of hours and nothing before. Both moves
 * are therefore measured over the overlap alone -- `symbolPercent` is the
 * plotted symbol over exactly the window `percent` covers, so the difference
 * between them compares like with like rather than a session against an hour.
 */
export function overlaySeries(points, other) {
    const aligned = alignTo(points, other);
    const start = aligned.findIndex(v => Number.isFinite(v));
    if (start < 0)
        return null;

    const from = aligned[start];
    const anchor = points[start]?.close;
    if (!from || !anchor)
        return null;

    const values = aligned.map(v => (Number.isFinite(v) ? (v / from) * anchor : NaN));

    let end = -1;
    for (let i = aligned.length - 1; i > start; i--) {
        if (Number.isFinite(aligned[i])) {
            end = i;
            break;
        }
    }

    const last = end >= 0 ? aligned[end] : NaN;
    const close = end >= 0 ? points[end].close : NaN;

    return {
        values,
        from: points[start].time,
        to: end >= 0 ? points[end].time : points[start].time,
        bars: end >= 0 ? end - start + 1 : 1,
        percent: Number.isFinite(last) ? ((last - from) / from) * 100 : NaN,
        symbolPercent: Number.isFinite(close) ? ((close - anchor) / anchor) * 100 : NaN,
    };
}
