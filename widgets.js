/*
 * Everything drawn with Cairo: the popup sparkline, the big chart in the
 * details window, and the small meters and bars that go with it.
 *
 * None of these know about settings or the network. They take numbers and
 * hand back an actor.
 */

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Cairo from 'cairo';

import {formatBare, formatStamp, formatVolume} from './finance.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// St has no opacity property in CSS, and a hardcoded rgba() only suits one
// theme, so muted text is faded on the actor and keeps the theme's colour.
export const MUTED_OPACITY = 155;
export const FAINT_OPACITY = 115;
export const STALE_OPACITY = 130;

export const GRAPH_COLORS = {
    up: [0.18, 0.76, 0.49],
    down: [0.88, 0.11, 0.14],
    flat: [0.60, 0.60, 0.62],
};

/**
 * A theme colour as 0-1 floats. Clutter hands colours back as bytes on some
 * versions and floats on others, so the scale is inferred from the values
 * rather than assumed.
 */
export function inkFrom(color) {
    const scale = Math.max(color.red, color.green, color.blue) > 1 ? 255 : 1;
    return [color.red / scale, color.green / scale, color.blue / scale];
}

/** Hairlines land on a half-pixel so they stay crisp. */
function crisp(v) {
    return Math.round(v) + 0.5;
}

/**
 * A price sparkline drawn with Cairo on an St.DrawingArea: a faint grid, a
 * dashed line at the opening value, a gradient area fill under the series and
 * a marker on the latest point.
 */
export function createSparkline(history, trend, height) {
    const area = new St.DrawingArea({
        style_class: 'toprates-graph',
        height,
        x_expand: true,
    });

    area.connect('repaint', () => {
        const cr = area.get_context();
        const [width, h] = area.get_surface_size();
        const [r, g, b] = GRAPH_COLORS[trend] ?? GRAPH_COLORS.flat;
        // Grid and guide borrow the theme's own text colour, so they stay
        // visible on a light shell instead of being white on white.
        const [ir, ig, ib] = inkFrom(area.get_theme_node().get_foreground_color());

        const min = Math.min(...history);
        const max = Math.max(...history);
        const span = max - min;
        const pad = 4;
        const usable = Math.max(1, h - pad * 2);
        // A flat series would divide by zero; centre it instead.
        const y = value => span > 0
            ? pad + usable * (1 - (value - min) / span)
            : pad + usable / 2;
        const x = i => history.length > 1
            ? (width * i) / (history.length - 1) : width / 2;

        // --- Grid ----------------------------------------------------------
        // Roughly one column every 55px, kept within a sane range so narrow
        // and wide popups both get a readable number of divisions.
        const columns = Math.max(3, Math.min(8, Math.round(width / 55)));
        const rows = 4;

        cr.setLineWidth(1);
        cr.setDash([], 0);
        cr.setSourceRGBA(ir, ig, ib, 0.09);
        for (let i = 1; i < columns; i++) {
            const gx = crisp((width * i) / columns);
            cr.moveTo(gx, 0);
            cr.lineTo(gx, h);
        }
        for (let i = 1; i < rows; i++) {
            const gy = crisp((h * i) / rows);
            cr.moveTo(0, gy);
            cr.lineTo(width, gy);
        }
        cr.stroke();

        const trace = () => {
            cr.moveTo(x(0), y(history[0]));
            for (let i = 1; i < history.length; i++)
                cr.lineTo(x(i), y(history[i]));
        };

        // --- Area fill -----------------------------------------------------
        // A gradient fades the fill out towards the baseline so the series
        // line stays the strongest thing on the chart.
        trace();
        cr.lineTo(x(history.length - 1), h);
        cr.lineTo(x(0), h);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, 0, 0, h);
        fill.addColorStopRGBA(0, r, g, b, 0.30);
        fill.addColorStopRGBA(1, r, g, b, 0.02);
        cr.setSource(fill);
        cr.fill();

        // --- Opening reference ---------------------------------------------
        // The dashed line is what turns the shape into a chart: everything
        // above it is a gain on the period, everything below it a loss. On a
        // flat series it would sit exactly under the trace, so skip it.
        if (span > 0) {
            const openY = crisp(y(history[0]));
            cr.setLineWidth(1);
            cr.setDash([3, 3], 0);
            cr.setSourceRGBA(ir, ig, ib, 0.28);
            cr.moveTo(0, openY);
            cr.lineTo(width, openY);
            cr.stroke();
            cr.setDash([], 0);
        }

        // --- Series --------------------------------------------------------
        trace();
        cr.setLineWidth(1.5);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(r, g, b, 1);
        cr.stroke();

        // --- Latest value ---------------------------------------------------
        // Pulled inside the right edge so the marker is not cut in half.
        const lastX = Math.min(x(history.length - 1), width - 4);
        const lastY = y(history[history.length - 1]);
        cr.setSourceRGBA(r, g, b, 0.28);
        cr.arc(lastX, lastY, 4, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(r, g, b, 1);
        cr.arc(lastX, lastY, 2, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    });

    return area;
}

/**
 * Font for the labels drawn inside a chart: the theme's own family and size,
 * scaled down the way a caption would be. Cairo's toy text API is used rather
 * than St labels because the axis has to line up with the plot to the pixel,
 * which a box layout cannot promise.
 */
function chartFont(node) {
    const fallback = {family: 'Sans', size: 11};
    try {
        const font = node.get_font();
        const size = font.get_size() / Pango.SCALE;
        const pixels = font.get_size_is_absolute() ? size : size * (96 / 72);
        return {
            family: font.get_family() || fallback.family,
            size: Math.min(16, Math.max(8, Math.round(pixels * 0.8))),
        };
    } catch {
        return fallback;
    }
}

function setFont(cr, font) {
    cr.selectFontFace(font.family, Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
    cr.setFontSize(font.size);
}

/** Text width, or an estimate when cairo cannot measure it. */
function textWidth(cr, text, font) {
    try {
        return cr.textExtents(text).width;
    } catch {
        return text.length * font.size * 0.6;
    }
}

/**
 * The details window's chart: the same series drawn large, with prices down
 * the right-hand side, dates along the bottom, volume bars under the trace,
 * optional moving averages, a reference line at the previous close, a badge on
 * the latest price and a crosshair that follows the pointer.
 */
export function createChart({
    points, trend, height, previousClose, averages = [], timezone, dateFormat,
    onHover,
}) {
    const area = new St.DrawingArea({
        style_class: 'toprates-chart',
        height,
        x_expand: true,
        reactive: true,
        track_hover: true,
    });

    const closes = points.map(p => p.close);
    const volumes = points.map(p => (Number.isFinite(p.volume) ? p.volume : 0));
    const maxVolume = Math.max(1, ...volumes);

    // The moving averages extend the vertical span when they run outside the
    // price, which they do at a turn in a long trend.
    const seen = [];
    for (const point of points) {
        seen.push(Number.isFinite(point.low) ? point.low : point.close);
        seen.push(Number.isFinite(point.high) ? point.high : point.close);
    }
    for (const average of averages)
        seen.push(...average.values.filter(v => Number.isFinite(v)));
    if (Number.isFinite(previousClose))
        seen.push(previousClose);

    let min = Math.min(...seen);
    let max = Math.max(...seen);
    if (!(max > min)) {
        // A dead-flat series: give it a nominal span so it lands mid-chart.
        const centre = Number.isFinite(max) ? max : 0;
        min = centre - 1;
        max = centre + 1;
    }

    let hovered = -1;

    // The plot is inset from the right, and that gutter carries the price
    // labels. The repaint handler records where it ended up, because the
    // surface size is only readable while painting: hit-testing has to be
    // done against the geometry that was actually drawn.
    const plotRightOf = width =>
        Math.max(1, width - Math.min(90, Math.max(46, Math.round(width * 0.09))));
    let plotted = 0;

    const indexAt = (actor, event) => {
        if (plotted <= 0 || points.length === 0)
            return -1;
        const [sx, sy] = event.get_coords();
        const [ok, lx] = actor.transform_stage_point(sx, sy);
        if (!ok || lx > plotted)
            return -1;
        const ratio = Math.min(1, Math.max(0, lx / plotted));
        return Math.round(ratio * (points.length - 1));
    };

    const setHovered = index => {
        if (index === hovered)
            return;
        hovered = index;
        onHover?.(index >= 0 ? points[index] : null, index);
        area.queue_repaint();
    };

    area.connect('motion-event', (actor, event) => {
        setHovered(indexAt(actor, event));
        return Clutter.EVENT_PROPAGATE;
    });
    area.connect('leave-event', () => {
        setHovered(-1);
        return Clutter.EVENT_PROPAGATE;
    });

    area.connect('repaint', () => {
        const cr = area.get_context();
        const [width, h] = area.get_surface_size();
        if (width <= 0 || h <= 0 || points.length === 0)
            return cr.$dispose();

        const [r, g, b] = GRAPH_COLORS[trend] ?? GRAPH_COLORS.flat;
        const node = area.get_theme_node();
        const [ir, ig, ib] = inkFrom(node.get_foreground_color());
        const font = chartFont(node);
        setFont(cr, font);

        const plotRight = plotRightOf(width);
        plotted = plotRight;
        // The date row at the bottom, then the volume strip, then the price.
        const dateBand = font.size + 8;
        const plotBottom = h - dateBand;
        const volumeBand = Math.round(plotBottom * 0.16);
        const priceTop = Math.round(font.size / 2) + 2;
        const priceBottom = Math.max(priceTop + 1, plotBottom - volumeBand - 4);
        const priceSpan = priceBottom - priceTop;

        const y = value => priceBottom - priceSpan * ((value - min) / (max - min));
        const x = i => points.length > 1
            ? (plotRight * i) / (points.length - 1) : plotRight / 2;

        const label = (text, tx, ty, alpha = 0.55, align = 'left') => {
            const w = textWidth(cr, text, font);
            const px = align === 'right' ? tx - w
                : align === 'center' ? tx - w / 2 : tx;
            cr.setSourceRGBA(ir, ig, ib, alpha);
            cr.moveTo(Math.round(px), Math.round(ty));
            cr.showText(text);
            cr.newPath();
        };

        // --- Grid and price axis --------------------------------------------
        const rows = 4;
        cr.setLineWidth(1);
        cr.setDash([], 0);
        for (let i = 0; i <= rows; i++) {
            const value = max - ((max - min) * i) / rows;
            const gy = crisp(priceTop + (priceSpan * i) / rows);
            cr.setSourceRGBA(ir, ig, ib, i === rows ? 0.16 : 0.08);
            cr.moveTo(0, gy);
            cr.lineTo(plotRight, gy);
            cr.stroke();
            label(formatBare(value), width - 4, gy + font.size / 3, 0.5, 'right');
        }

        // --- Date axis -------------------------------------------------------
        const ticks = Math.min(5, points.length);
        const baseline = h - 4;
        for (let i = 0; i < ticks; i++) {
            const index = ticks > 1
                ? Math.round((i * (points.length - 1)) / (ticks - 1)) : 0;
            const tx = x(index);
            const align = i === 0 ? 'left' : i === ticks - 1 ? 'right' : 'center';
            if (i > 0 && i < ticks - 1) {
                cr.setSourceRGBA(ir, ig, ib, 0.08);
                cr.moveTo(crisp(tx), priceTop);
                cr.lineTo(crisp(tx), plotBottom);
                cr.stroke();
            }
            label(formatStamp(points[index].time, timezone, dateFormat),
                tx, baseline, 0.5, align);
        }

        // --- Volume ----------------------------------------------------------
        if (maxVolume > 1) {
            const slot = plotRight / Math.max(1, points.length);
            const barWidth = Math.max(1, Math.min(7, slot - 1));
            cr.setSourceRGBA(r, g, b, 0.35);
            for (let i = 0; i < points.length; i++) {
                const bh = (volumes[i] / maxVolume) * (volumeBand - 2);
                if (bh <= 0)
                    continue;
                cr.rectangle(x(i) - barWidth / 2, plotBottom - bh, barWidth, bh);
            }
            cr.fill();
        }

        const trace = () => {
            cr.moveTo(x(0), y(closes[0]));
            for (let i = 1; i < closes.length; i++)
                cr.lineTo(x(i), y(closes[i]));
        };

        // --- Area fill -------------------------------------------------------
        trace();
        cr.lineTo(x(closes.length - 1), priceBottom);
        cr.lineTo(x(0), priceBottom);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, priceTop, 0, priceBottom);
        fill.addColorStopRGBA(0, r, g, b, 0.28);
        fill.addColorStopRGBA(1, r, g, b, 0.02);
        cr.setSource(fill);
        cr.fill();

        // --- Previous close --------------------------------------------------
        // Above the line is a gain on the period, below it a loss.
        if (Number.isFinite(previousClose) && previousClose >= min && previousClose <= max) {
            const refY = crisp(y(previousClose));
            cr.setLineWidth(1);
            cr.setDash([4, 4], 0);
            cr.setSourceRGBA(ir, ig, ib, 0.35);
            cr.moveTo(0, refY);
            cr.lineTo(plotRight, refY);
            cr.stroke();
            cr.setDash([], 0);
        }

        // --- Moving averages --------------------------------------------------
        for (const average of averages) {
            cr.setLineWidth(1);
            cr.setDash(average.dash ?? [], 0);
            cr.setSourceRGBA(ir, ig, ib, 0.45);
            let started = false;
            for (let i = 0; i < average.values.length; i++) {
                const value = average.values[i];
                if (!Number.isFinite(value)) {
                    started = false;
                    continue;
                }
                if (started) {
                    cr.lineTo(x(i), y(value));
                } else {
                    cr.moveTo(x(i), y(value));
                    started = true;
                }
            }
            cr.stroke();
            cr.setDash([], 0);
        }

        // --- Series ------------------------------------------------------------
        trace();
        cr.setLineWidth(1.8);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(r, g, b, 1);
        cr.stroke();

        // --- Latest value -------------------------------------------------------
        const lastX = Math.min(x(closes.length - 1), plotRight - 3);
        const lastY = y(closes[closes.length - 1]);
        cr.setSourceRGBA(r, g, b, 0.25);
        cr.arc(lastX, lastY, 5, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGBA(r, g, b, 1);
        cr.arc(lastX, lastY, 2.5, 0, 2 * Math.PI);
        cr.fill();

        // The last close is called out in the gutter, the way the quote page
        // tags the live price against its axis.
        const tag = (value, ty, alpha) => {
            const text = formatBare(value);
            const w = textWidth(cr, text, font);
            const boxHeight = font.size + 6;
            const boxY = Math.min(h - boxHeight, Math.max(0, ty - boxHeight / 2));
            cr.setSourceRGBA(r, g, b, alpha);
            cr.rectangle(plotRight + 3, boxY, Math.min(width - plotRight - 4, w + 8),
                boxHeight);
            cr.fill();
            cr.setSourceRGBA(0, 0, 0, 0.85);
            cr.moveTo(plotRight + 7, boxY + boxHeight - 5);
            cr.showText(text);
            cr.newPath();
        };
        tag(closes[closes.length - 1], lastY, 0.9);

        // --- Crosshair -----------------------------------------------------------
        if (hovered >= 0 && hovered < points.length) {
            const hx = crisp(x(hovered));
            const hy = y(closes[hovered]);
            cr.setLineWidth(1);
            cr.setDash([2, 3], 0);
            cr.setSourceRGBA(ir, ig, ib, 0.55);
            cr.moveTo(hx, priceTop);
            cr.lineTo(hx, plotBottom);
            cr.moveTo(0, crisp(hy));
            cr.lineTo(plotRight, crisp(hy));
            cr.stroke();
            cr.setDash([], 0);

            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(x(hovered), hy, 3.5, 0, 2 * Math.PI);
            cr.fill();
            tag(closes[hovered], hy, 0.55);
        }

        cr.$dispose();
    });

    return area;
}

/**
 * Where today's price sits inside a low-high band, as a track with a marker:
 * the 52-week range, read at a glance.
 */
export function createLevelMeter({low, high, value, trend, height = 10}) {
    const area = new St.DrawingArea({
        style_class: 'toprates-meter',
        height,
        x_expand: true,
    });

    area.connect('repaint', () => {
        const cr = area.get_context();
        const [width, h] = area.get_surface_size();
        const [r, g, b] = GRAPH_COLORS[trend] ?? GRAPH_COLORS.flat;
        const [ir, ig, ib] = inkFrom(area.get_theme_node().get_foreground_color());

        const track = Math.max(2, Math.round(h / 3));
        const top = (h - track) / 2;

        cr.setSourceRGBA(ir, ig, ib, 0.15);
        cr.rectangle(0, top, width, track);
        cr.fill();

        if (!(high > low) || !Number.isFinite(value))
            return cr.$dispose();

        const ratio = Math.min(1, Math.max(0, (value - low) / (high - low)));
        const fillTo = Math.max(2, width * ratio);

        const gradient = new Cairo.LinearGradient(0, 0, width, 0);
        gradient.addColorStopRGBA(0, r, g, b, 0.25);
        gradient.addColorStopRGBA(1, r, g, b, 0.75);
        cr.setSource(gradient);
        cr.rectangle(0, top, fillTo, track);
        cr.fill();

        // The marker is nudged inside both edges so a value sitting exactly on
        // the low or the high is still drawn whole.
        const markerX = Math.min(width - h / 2, Math.max(h / 2, width * ratio));
        cr.setSourceRGBA(r, g, b, 1);
        cr.arc(markerX, h / 2, h / 2 - 1, 0, 2 * Math.PI);
        cr.fill();

        cr.$dispose();
    });

    return area;
}

/**
 * A signed bar for one trailing return: it grows right from the centre for a
 * gain and left for a loss, scaled against the largest return in the table so
 * the rows can be compared with each other.
 */
export function createSignedBar({value, scale, height = 8}) {
    const area = new St.DrawingArea({
        style_class: 'toprates-bar',
        height,
        x_expand: true,
    });

    area.connect('repaint', () => {
        const cr = area.get_context();
        const [width, h] = area.get_surface_size();
        const [ir, ig, ib] = inkFrom(area.get_theme_node().get_foreground_color());

        const centre = Math.round(width / 2);
        cr.setSourceRGBA(ir, ig, ib, 0.18);
        cr.rectangle(crisp(centre) - 0.5, 0, 1, h);
        cr.fill();

        if (Number.isFinite(value) && scale > 0) {
            const [r, g, b] = value >= 0 ? GRAPH_COLORS.up : GRAPH_COLORS.down;
            const length = Math.min(centre, (Math.abs(value) / scale) * centre);
            cr.setSourceRGBA(r, g, b, 0.8);
            cr.rectangle(value >= 0 ? centre : centre - length,
                Math.round(h / 4), Math.max(1, length), Math.round(h / 2));
            cr.fill();
        }

        cr.$dispose();
    });

    return area;
}

/**
 * An indeterminate spinner: a faint ring with a bright arc sweeping around it,
 * for the stretch between asking Yahoo for a symbol and having the answer.
 *
 * It ticks only while it is on screen. Hiding the actor stops the source and
 * showing it starts it again, so a caller that flips `visible` never has to
 * think about the timer, and destroying the actor drops it for good.
 */
export function createSpinner({size = 16, period = 900} = {}) {
    const area = new St.DrawingArea({
        style_class: 'toprates-spinner',
        width: size,
        height: size,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const FPS = 30;
    let angle = 0;
    let tickId = 0;

    area.connect('repaint', () => {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const [r, g, b] = inkFrom(area.get_theme_node().get_foreground_color());
        const radius = Math.max(1, Math.min(width, height) / 2 - 1.5);

        cr.setLineWidth(2);
        cr.setLineCap(Cairo.LineCap.ROUND);

        cr.setSourceRGBA(r, g, b, 0.18);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();

        cr.setSourceRGBA(r, g, b, 0.85);
        cr.arc(width / 2, height / 2, radius, angle, angle + Math.PI * 0.6);
        cr.stroke();

        cr.$dispose();
    });

    const stop = () => {
        if (tickId) {
            GLib.Source.remove(tickId);
            tickId = 0;
        }
    };

    const start = () => {
        if (tickId)
            return;
        const step = 2 * Math.PI / (period / (1000 / FPS));
        tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 / FPS, () => {
            angle = (angle + step) % (2 * Math.PI);
            area.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    };

    area.connect('notify::mapped', () => (area.mapped ? start() : stop()));
    area.connect('destroy', stop);
    if (area.mapped)
        start();

    return area;
}

/** "Sep 2 · O 166.26 H 166.96 L 165.50 C 166.82 · Vol 191.4K" */
export function describePoint(point, timezone, format) {
    const parts = [formatStamp(point.time, timezone, format)];
    const ohlc = [];
    if (Number.isFinite(point.open))
        ohlc.push(`${_('O')} ${formatBare(point.open)}`);
    if (Number.isFinite(point.high))
        ohlc.push(`${_('H')} ${formatBare(point.high)}`);
    if (Number.isFinite(point.low))
        ohlc.push(`${_('L')} ${formatBare(point.low)}`);
    ohlc.push(`${_('C')} ${formatBare(point.close)}`);
    parts.push(ohlc.join('  '));
    if (Number.isFinite(point.volume) && point.volume > 0)
        parts.push(`${_('Vol')} ${formatVolume(point.volume)}`);
    return parts.join('   ·   ');
}
