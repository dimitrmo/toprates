/*
 * Unit tests for the pure half of finance.js: the formatters, the analytics
 * and the portfolio arithmetic. Everything here is deterministic and runs
 * without a shell, a network or a display.
 *
 * Number formatting goes through Intl, whose output depends on the locale the
 * runner happens to have, so the assertions below check structure -- the sign,
 * the currency code, the digits with separators stripped -- rather than a
 * string that would only hold under one locale.
 */

import GLib from 'gi://GLib';

import * as Finance from '../../finance.js';
import {test, assert, equal, near, nan, deepEqual} from './harness.js';

/** Digits only, so grouping and decimal marks cannot break an assertion. */
const digits = text => String(text).replace(/[^0-9]/g, '');

const DAY = 86400;

/** A dated bar series from closes, one bar a day, ending at `end`. */
function series(closes, end = 0) {
    const start = end - (closes.length - 1) * DAY;
    return closes.map((close, i) => ({
        time: start + i * DAY,
        open: close,
        high: close,
        low: close,
        close,
        volume: 100,
    }));
}

// --- Formatting ------------------------------------------------------------

test('formatPercent signs the move and keeps two decimals', () => {
    assert(Finance.formatPercent(1.005).startsWith('+'), 'a gain leads with +');
    equal(digits(Finance.formatPercent(1.005)), '101');
    // A typographic minus, not a hyphen: it lines up with the digits.
    assert(Finance.formatPercent(-2.5).startsWith('−'), 'a loss leads with U+2212');
    equal(Finance.formatPercent(0), '0.00%'.replace('0.00%', Finance.formatPercent(0)));
    equal(Finance.formatPercent(NaN), '');
    assert(Finance.formatPercent(3).endsWith('%'), 'the unit is kept');
});

test('formatChange signs the absolute move', () => {
    assert(Finance.formatChange(-12.5).startsWith('−'));
    equal(digits(Finance.formatChange(-12.5)), '1250');
    assert(Finance.formatChange(12.5).startsWith('+'));
    equal(Finance.formatChange(NaN), '');
});

test('priceDigits gives small prices more decimals', () => {
    equal(Finance.priceDigits(150), 2);
    equal(Finance.priceDigits(9.99), 4);
    equal(Finance.priceDigits(-9.99), 4, 'the magnitude decides, not the sign');
});

test('formatPrice renders minor units as a plain number plus the code', () => {
    const pence = Finance.formatPrice(88.5, 'GBp');
    assert(pence.endsWith('GBp'), `expected a GBp suffix, got ${pence}`);
    assert(!pence.includes('£'), 'the pound sign would misprice it by 100x');
    equal(digits(pence), '8850');
    equal(Finance.formatPrice(NaN, 'USD'), '—');
    equal(digits(Finance.formatPrice(1234.5, 'USD')), '123450');
});

test('formatPrice names the currency even when Intl has no symbol for it', () => {
    // Intl accepts any well-formed ISO code and prints the code itself when it
    // knows no symbol, which is exactly what a reader needs.
    const value = Finance.formatPrice(10, 'XYZ');
    assert(value.includes('XYZ'), `expected the code somewhere, got ${value}`);
    equal(digits(value), '1000');
});

test('formatQuantity keeps whole shares whole and fractions intact', () => {
    equal(Finance.formatQuantity(10), '10');
    equal(digits(Finance.formatQuantity(0.12345678)), '012345678');
    equal(Finance.formatQuantity(NaN), '—');
});

test('formatSpan pairs a low and a high', () => {
    equal(Finance.formatSpan(NaN, 5), '—');
    assert(Finance.formatSpan(1, 2).includes('–'), 'joined with an en dash');
});

test('trendOf reads the sign, and treats flat as flat', () => {
    equal(Finance.trendOf(1), 'up');
    equal(Finance.trendOf(-1), 'down');
    equal(Finance.trendOf(0), 'flat');
    equal(Finance.trendOf(NaN), 'flat');
});

// --- Market state ----------------------------------------------------------

const PERIODS = {
    currentTradingPeriod: {
        pre: {start: 100, end: 200},
        regular: {start: 200, end: 300},
        post: {start: 300, end: 400},
    },
};

test('marketStateOf places a moment in the exchange own sessions', () => {
    equal(Finance.marketStateOf(PERIODS, 150), 'pre');
    equal(Finance.marketStateOf(PERIODS, 250), 'regular');
    equal(Finance.marketStateOf(PERIODS, 350), 'post');
    equal(Finance.marketStateOf(PERIODS, 500), 'closed');
    equal(Finance.marketStateOf(PERIODS, 200), 'regular', 'a window includes its start');
    equal(Finance.marketStateOf(PERIODS, 300), 'post', 'and excludes its end');
    equal(Finance.marketStateOf({}, 250), 'unknown');
});

// --- Analytics -------------------------------------------------------------

test('movingAverage leaves the first period-1 slots empty', () => {
    const average = Finance.movingAverage([1, 2, 3, 4, 5], 2);
    equal(average.length, 5);
    nan(average[0], 'nothing to average yet');
    near(average[1], 1.5);
    near(average[4], 4.5);
    assert(Finance.movingAverage([1, 2], 5).every(v => !Number.isFinite(v)),
        'a series shorter than the period has no average at all');
});

test('periodStats reads the range out of the bars', () => {
    const points = [
        {time: 0, open: 10, high: 11, low: 9, close: 10, volume: 100},
        {time: DAY, open: 10, high: 13, low: 10, close: 12, volume: 200},
        {time: 2 * DAY, open: 12, high: 12, low: 8, close: 9, volume: 300},
    ];
    const stats = Finance.periodStats(points, '1d');

    near(stats.first, 10);
    near(stats.last, 9);
    near(stats.change, -1);
    near(stats.percent, -10);
    near(stats.high, 13, 1e-9, 'the high is the highest high, not the highest close');
    near(stats.low, 8);
    equal(stats.highAt, DAY);
    equal(stats.lowAt, 2 * DAY);
    near(stats.average, 31 / 3);
    near(stats.volumeAverage, 200);
    near(stats.volumeTotal, 600);
    equal(stats.bars, 3);
    equal(stats.advancing, 1);
    equal(stats.declining, 1);
    near(stats.best.percent, 20);
    near(stats.worst.percent, -25);
    near(stats.drawdown, -25, 1e-9, 'peak to trough, not first to last');
    nan(stats.volatility, 'two returns are too few to annualise');
    equal(Finance.periodStats([], '1d'), null);
});

test('periodStats annualises the volatility of a long enough series', () => {
    const points = series([100, 102, 101, 103, 105, 104, 106]);
    const stats = Finance.periodStats(points, '1d');
    assert(Number.isFinite(stats.volatility), 'six returns are enough');
    assert(stats.volatility > 0, 'a moving series is not flat');
    nan(Finance.periodStats(points, '5m').volatility,
        'an intraday interval has no bars-per-year scale');
});

test('trailingReturns skips windows the series is too short for', () => {
    const end = Math.floor(GLib.DateTime.new_now_local().to_unix() / DAY) * DAY;
    // 400 days of a straight line: long enough for a year, short of three.
    const points = series(Array.from({length: 400}, (_, i) => 100 + i), end);
    const rows = Finance.trailingReturns(points);
    const keys = rows.map(row => row.key);

    for (const key of ['1w', '1mo', '3mo', '6mo', '1y'])
        assert(keys.includes(key), `expected a ${key} row, got ${keys.join(', ')}`);
    for (const key of ['3y', '5y'])
        assert(!keys.includes(key), `${key} is longer than the series`);

    const week = rows.find(row => row.key === '1w');
    // The last close is 499 and the bar seven days back is 492.
    near(week.percent, ((499 - 492) / 492) * 100, 1e-9);
    deepEqual(Finance.trailingReturns([]), []);
});

// --- Currencies ------------------------------------------------------------

test('majorUnitOf resolves the minor units', () => {
    deepEqual(Finance.majorUnitOf('GBp'), {code: 'GBP', factor: 100});
    deepEqual(Finance.majorUnitOf('ZAc'), {code: 'ZAR', factor: 100});
    deepEqual(Finance.majorUnitOf('eur'), {code: 'EUR', factor: 1});
    deepEqual(Finance.majorUnitOf(''), {code: '', factor: 1});
});

test('fxSymbolsFor asks only for the pairs a portfolio needs', () => {
    deepEqual(
        Finance.fxSymbolsFor(['USD', 'EUR', 'GBp', 'USD'], 'EUR').sort(),
        ['GBPEUR=X', 'USDEUR=X'],
        'the base itself is skipped, duplicates collapse, pence become pounds');
    deepEqual(Finance.fxSymbolsFor(['USD'], ''), [], 'no base, no requests');
    deepEqual(Finance.fxSymbolsFor([], 'EUR'), []);
});

test('convert uses the direct pair, the inverse, or says it cannot', () => {
    near(Finance.convert(100, 'USD', 'EUR', {'USDEUR=X': 0.9}), 90);
    near(Finance.convert(100, 'USD', 'EUR', {'EURUSD=X': 1.25}), 80,
        1e-9, 'one request answers both directions');
    near(Finance.convert(100, 'EUR', 'EUR', {}), 100);
    near(Finance.convert(500, 'GBp', 'GBP', {}), 5, 1e-9, 'pence into pounds');
    near(Finance.convert(500, 'GBp', 'EUR', {'GBPEUR=X': 1.2}), 6,
        1e-9, 'the minor unit is resolved before the rate is applied');
    nan(Finance.convert(100, 'USD', 'EUR', {}), 'no rate is not a zero');
    nan(Finance.convert(NaN, 'USD', 'USD', {}));
    nan(Finance.convert(100, 'USD', '', {}));
});

// --- Portfolio -------------------------------------------------------------

test('parseHolding takes a quantity and an optional cost', () => {
    deepEqual(Finance.parseHolding('10 142.3'), {quantity: 10, cost: 142.3});
    deepEqual(Finance.parseHolding('  10  '), {quantity: 10, cost: NaN});
    deepEqual(Finance.parseHolding('-2 5'), {quantity: -2, cost: 5},
        'a short position is still a position');
    equal(Finance.parseHolding('0 5'), null, 'nothing held');
    equal(Finance.parseHolding(''), null);
    equal(Finance.parseHolding('abc'), null);
    equal(Finance.parseHolding(null), null);
});

test('parseHoldings keys the settings map in upper case', () => {
    const holdings = Finance.parseHoldings({
        aapl: '10 142.3', ' msft ': '5', BROKEN: 'abc', EMPTY: '0',
    });

    equal(holdings.size, 2, 'the unparseable entries are left out');
    deepEqual(holdings.get('AAPL'), {quantity: 10, cost: 142.3});
    deepEqual(holdings.get('MSFT'), {quantity: 5, cost: NaN},
        'the key is trimmed as well as upper-cased');
    equal(Finance.parseHoldings(null).size, 0);
    equal(Finance.parseHoldings(undefined).size, 0);
});

test('formatHolding writes back what parseHolding reads', () => {
    equal(Finance.formatHolding({quantity: 10, cost: 142.3}), '10 142.3');
    equal(Finance.formatHolding({quantity: 10, cost: NaN}), '10');
    equal(Finance.formatHolding(null), '');
    equal(Finance.formatHolding(Finance.parseHolding('10 142.3')), '10 142.3');
});

const QUOTE = {price: 10, change: 1, currency: 'USD'};

test('positionOf values a holding in its own currency and the base', () => {
    const position = Finance.positionOf(
        QUOTE, {quantity: 3, cost: 8}, 'EUR', {'USDEUR=X': 0.5});

    near(position.value, 30);
    near(position.dayChange, 3);
    near(position.invested, 24);
    near(position.gain, 6);
    near(position.gainPercent, 25);
    near(position.baseValue, 15);
    near(position.baseDayChange, 1.5);
    near(position.baseInvested, 12);
    equal(position.base, 'EUR');
});

test('positionOf leaves the gain open when no cost was given', () => {
    const position = Finance.positionOf(QUOTE, {quantity: 3, cost: NaN}, 'USD', {});
    near(position.value, 30);
    nan(position.gain);
    nan(position.gainPercent);
    nan(position.baseInvested);
});

test('positionOf reports an unconvertible holding rather than guessing', () => {
    const position = Finance.positionOf(QUOTE, {quantity: 3, cost: 8}, 'JPY', {});
    near(position.value, 30, 1e-9, 'the local figures still hold');
    nan(position.baseValue, 'the base ones do not');
    equal(Finance.positionOf(null, {quantity: 1}, 'EUR', {}), null);
    equal(Finance.positionOf(QUOTE, null, 'EUR', {}), null);
    equal(Finance.positionOf({price: NaN}, {quantity: 1}, 'EUR', {}), null);
});

test('portfolioTotals adds up what it can and counts what it could not', () => {
    const positions = [
        Finance.positionOf(QUOTE, {quantity: 3, cost: 8}, 'EUR', {'USDEUR=X': 0.5}),
        Finance.positionOf({price: 20, change: -2, currency: 'EUR'},
            {quantity: 2, cost: NaN}, 'EUR', {}),
        Finance.positionOf({price: 5, change: 0, currency: 'JPY'},
            {quantity: 1, cost: 4}, 'EUR', {}),
    ];
    const totals = Finance.portfolioTotals(positions);

    equal(totals.counted, 2);
    equal(totals.missing, 1, 'the yen holding had no rate');
    equal(totals.priced, 1, 'only one position carries a cost basis');
    near(totals.value, 55, 1e-9, '15 EUR plus 40 EUR');
    near(totals.dayChange, 1.5 - 4);
    near(totals.invested, 12);
    near(totals.gain, 3, 1e-9, 'the gain is over the priced position alone');
    near(totals.gainPercent, 25);
    near(totals.dayPercent, ((1.5 - 4) / (55 - (1.5 - 4))) * 100);
    equal(Finance.portfolioTotals([]), null);
    equal(Finance.portfolioTotals([null]), null);
});

// --- Comparison series -----------------------------------------------------

test('alignTo tolerates two exchanges dating the same day differently', () => {
    const points = series([1, 2, 3]);
    // New York opens hours after Frankfurt, so the benchmark bar for a day is
    // stamped later than the one it belongs against.
    const other = points.map((point, i) => ({time: point.time + 3600, close: 10 + i}));
    deepEqual(Finance.alignTo(points, other), [10, 11, 12]);
});

test('alignTo leaves the slots before the other series empty', () => {
    const points = series([1, 2, 3]);
    const other = [{time: points[2].time, close: 99}];
    const aligned = Finance.alignTo(points, other);
    nan(aligned[0]);
    nan(aligned[1]);
    equal(aligned[2], 99);
    deepEqual(Finance.alignTo(points, []), [NaN, NaN, NaN]);
    deepEqual(Finance.alignTo([], [{time: 0, close: 1}]), []);
});

test('overlaySeries rebases the benchmark onto the plotted prices', () => {
    const points = series([100, 110, 120]);
    const other = points.map((point, i) => ({time: point.time, close: [50, 55, 45][i]}));
    const overlay = Finance.overlaySeries(points, other);

    near(overlay.values[0], 100, 1e-9, 'both start from the same point');
    near(overlay.values[1], 110);
    near(overlay.values[2], 90, 1e-9, '-10% off the anchor');
    near(overlay.percent, -10);
    near(overlay.symbolPercent, 20, 1e-9, 'the symbol over the same window');
    equal(overlay.from, points[0].time);
    equal(overlay.to, points[2].time);
    equal(overlay.bars, 3);
});

test('overlaySeries measures both moves over the window they share', () => {
    // A day chart of a European stock against a New York benchmark: the
    // overlay only exists once New York opens, so the symbol's own move has to
    // be measured from there too, not from its own open.
    const points = series([100, 90, 95, 100]);
    const other = [
        {time: points[1].time, close: 200},
        {time: points[3].time, close: 210},
    ];
    const overlay = Finance.overlaySeries(points, other);

    nan(overlay.values[0], 'nothing to draw before the benchmark opens');
    near(overlay.values[1], 90, 1e-9, 'the overlay starts at the shared bar');
    near(overlay.percent, 5, 1e-9, '200 to 210');
    near(overlay.symbolPercent, 100 / 9, 1e-9, '90 to 100, not 100 to 100');
    equal(overlay.from, points[1].time);
    equal(overlay.bars, 3);
});

test('overlaySeries gives up when the two series never overlap', () => {
    const points = series([100, 110]);
    const other = [{time: points[0].time - 10 * DAY, close: 5}];
    // The only benchmark bar is long before the plot, so nothing lines up
    // inside it -- but the last known close still carries forward.
    assert(Finance.overlaySeries(points, []) === null, 'nothing to draw');
    assert(Finance.overlaySeries([], other) === null);
    assert(Finance.overlaySeries(points, other) !== null,
        'a bar before the plot still anchors it');
});
