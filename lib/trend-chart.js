// Pure, testable trend-chart geometry for Car Watch V2 (requirement 004,
// stage 3: "the trend chart and sparklines"). No I/O, no rendering, no
// DOM — everything here operates on plain arrays already produced by
// lib/parse-tracker.js, the same shape lib/tracker-data.js reads, and
// returns plain numbers/strings for public/app.js to draw as SVG.
//
// Eligibility is lib/model.js#hasTrend, written in stage 1 and reused
// unchanged here (see eligibleVariants below): a variant gets a line only
// when it is used or CPO and has at least two readings. New never has a
// trend — its price is MSRP, which the manufacturer sets, so plotting it
// would be a flat line pretending to be information.
//
// Source of truth for layout: car-tracker/reference/05-trend-chart.html
// (its script block has the hover/crosshair logic this module's geometry
// feeds) and car-tracker/reference/Car Watch — V2 change list.md, section
// 5. The reference's pixel positions are for a fixed three-readings/
// two-months sample; this module generalizes them to any reading count
// and date range — see buildTrendChart's domain/scale comments.

import { hasTrend, orderedReadings, toUtcDay, DAY_MS } from './model.js';

export const SERIES_COLORS = ['#7EA6FF', '#F2849E', '#4FC3A1'];

const CONDITION_RANK = { cpo: 0, used: 1 };
const CONDITION_WORD = { cpo: 'CPO', used: 'used' };
const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The main chart's fixed plot box, in SVG viewBox units — matches
// car-tracker/reference/03-car-detail.html's in-page chart (viewBox
// "0 0 700 270", no height/viewBox mismatch, unlike the standalone
// 05-trend-chart.html demo artboard, which stretches its viewBox to fill
// a taller card and was not used as the pixel source for that reason).
export const PLOT = { x0: 60, x1: 672, yTop: 40, yBaseline: 200 };
const WEEK_PX = 100; // px per 7-day tick when the domain is exactly 6 weeks wide, per the reference
const PAD_DAYS = 7; // breathing room on each edge — half the standard 14-day check cadence
const TICK_LEN = 6;
const TICK_LEN_HEAVY = 8;
export const HIT_TARGET_RADIUS = 16; // requirement 004: hit target 16px against a 5px mark
export const POINT_RADIUS = 5;
export const POINT_RADIUS_LATEST = 5;
export const TOOLTIP_SIZE = { width: 210, height: 54 };
const TOOLTIP_GAP = 14;
const TOOLTIP_MIN_TOP = PLOT.yTop - 34;

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function formatDollars(value) {
  return CURRENCY.format(value);
}

// "+$786" / "−$786" (a real minus sign, not a hyphen) / "$0" — the change
// figure beside a sparkline (requirement 004, "row sparklines... the
// change in dollars beside them").
export function formatChange(delta) {
  if (delta === 0) return formatDollars(0);
  return `${delta > 0 ? '+' : '−'}${formatDollars(Math.abs(delta))}`;
}

function formatAxisValue(value) {
  return value % 1000 === 0 ? `$${value / 1000}k` : formatDollars(value);
}

export function formatLongDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAY_FULL[dt.getUTCDay()]}, ${MONTH_FULL[m - 1]} ${d}, ${y}`;
}

// --- Eligibility (reuses lib/model.js#hasTrend, doesn't rewrite it) -------

// Ordered, coloured list of a car's used/CPO configurations that qualify
// for a trend line: CPO before used within a trim, newest model year
// first — a deterministic order so the same variant always gets the same
// series colour on both the chart and its row sparkline. Only dated
// readings can be plotted on a timeline, so a variant additionally needs
// at least two of those even on the rare file where hasTrend() is true
// from a mix of dated and undated readings.
export function eligibleVariants(car, configurations, pricePoints) {
  const trimOrder = Array.isArray(car.trimsTracked) ? car.trimsTracked : [];
  const trimRank = (trim) => {
    const i = trimOrder.indexOf(trim);
    return i === -1 ? trimOrder.length : i;
  };

  // hasTrend's readingCount is every reading on file, dated or not (the
  // same count lib/tracker-data.js#trendCellInfo passes it) — reused
  // as-is per requirement 004: "you wrote it as a pure function in stage
  // 1. Use it, don't rewrite it." Actually drawing a line additionally
  // needs at least two *dated* readings, since an undated one has
  // nowhere to sit on a timeline; that's a stricter, chart-only check on
  // top of hasTrend, not a replacement for it.
  const eligible = configurations
    .filter((c) => c.car === car.id && (c.condition === 'used' || c.condition === 'cpo'))
    .map((config) => {
      const all = orderedReadings(config.id, pricePoints);
      const dated = all.filter((r) => r.observed);
      return { config, all, dated };
    })
    .filter(({ config, all, dated }) => hasTrend(config.condition, all.length) && dated.length >= 2);

  eligible.sort((a, b) =>
    Number(b.config.year) - Number(a.config.year) ||
    trimRank(a.config.trim) - trimRank(b.config.trim) ||
    a.config.trim.localeCompare(b.config.trim) ||
    (CONDITION_RANK[a.config.condition] ?? 99) - (CONDITION_RANK[b.config.condition] ?? 99)
  );

  return eligible.map(({ config, dated }, i) => ({
    configurationId: config.id,
    label: `${config.year} ${config.trim} ${CONDITION_WORD[config.condition] ?? config.condition}`,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    readings: dated.map((r) => ({ date: r.observed, value: r.value })).sort((a, b) => toUtcDay(a.date) - toUtcDay(b.date)),
  }));
}

// --- Main chart geometry ---------------------------------------------------

function domainFor(variants) {
  const days = variants.flatMap((v) => v.readings.map((r) => toUtcDay(r.date)));
  const minDay = Math.min(...days) - PAD_DAYS * DAY_MS;
  const maxDayRaw = Math.max(...days) + PAD_DAYS * DAY_MS;
  const maxDay = Math.max(maxDayRaw, minDay + DAY_MS);
  return { startDay: minDay, endDay: maxDay };
}

// The plot's fixed pixel width is shared across however much history
// exists — as history grows the window "extends" in calendar terms while
// staying inside the same box (requirement 004: "the window extends as
// history grows and always keeps month labels"). px-per-day shrinks
// accordingly; at exactly a 6-week span (the reference's three
// two-week-apart readings, padded) it lands on the reference's own
// 100px-per-week figure.
function pxPerDayFor(domain) {
  const totalDays = (domain.endDay - domain.startDay) / DAY_MS;
  return (PLOT.x1 - PLOT.x0) / totalDays;
}

function xForDay(day, domain, pxPerDay) {
  return PLOT.x0 + ((day - domain.startDay) / DAY_MS) * pxPerDay;
}

function niceStep(range, targetCount) {
  const safeRange = range > 0 ? range : 1000;
  const rough = safeRange / targetCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  let step;
  if (residual > 5) step = 10 * magnitude;
  else if (residual > 2) step = 5 * magnitude;
  else if (residual > 1) step = 2 * magnitude;
  else step = magnitude;
  return step;
}

function yAxisFor(variants) {
  const values = variants.flatMap((v) => v.readings.map((r) => r.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = niceStep(max - min, 5);
  const niceMin = Math.floor(min / step) * step;
  const niceMaxRaw = Math.ceil(max / step) * step;
  const niceMax = niceMaxRaw > niceMin ? niceMaxRaw : niceMin + step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + 1e-6; v += step) ticks.push(Math.round(v));
  return { min: niceMin, max: niceMax, ticks };
}

function yFor(value, yAxis) {
  const frac = (value - yAxis.min) / (yAxis.max - yAxis.min);
  return PLOT.yBaseline - frac * (PLOT.yBaseline - PLOT.yTop);
}

// Every calendar month the domain touches, clipped to the domain, with a
// centred label position — and a dotted divider at each month boundary
// strictly inside the domain (requirement 004: "labelled by month... with
// a dotted divider at the boundary").
function monthLayout(domain, pxPerDay) {
  const startDate = new Date(domain.startDay);
  const months = [];
  const dividers = [];
  let cursor = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1);
  let first = true;
  while (cursor <= domain.endDay) {
    const cursorDate = new Date(cursor);
    const nextCursor = Date.UTC(cursorDate.getUTCFullYear(), cursorDate.getUTCMonth() + 1, 1);
    const segStart = Math.max(cursor, domain.startDay);
    const segEnd = Math.min(nextCursor, domain.endDay);
    if (segEnd > segStart) {
      const xStart = xForDay(segStart, domain, pxPerDay);
      const xEnd = xForDay(segEnd, domain, pxPerDay);
      months.push({ name: MONTH_FULL[cursorDate.getUTCMonth()].toUpperCase(), x: (xStart + xEnd) / 2 });
      if (!first) dividers.push(xForDay(segStart, domain, pxPerDay));
    }
    first = false;
    cursor = nextCursor;
  }
  return { months, dividers };
}

// Week ticks below the baseline, every 7 days across the domain, heavier
// where a real reading falls (requirement 004: "week ticks below the
// baseline"; change list section 5: "heavier at each reading").
function weekTicksFor(domain, pxPerDay, variants) {
  const readingDays = new Set(variants.flatMap((v) => v.readings.map((r) => toUtcDay(r.date))));
  const ticks = [];
  for (let day = domain.startDay; day <= domain.endDay + DAY_MS / 2; day += 7 * DAY_MS) {
    ticks.push({ x: xForDay(day, domain, pxPerDay), heavy: readingDays.has(day) });
  }
  return ticks;
}

// The tooltip stays inside the plot even for a point right at the edge
// (requirement 004: "clamped inside the plot so edge points stay
// readable") — horizontally centred on the point when there's room,
// pushed in from whichever edge there isn't; vertically above the point,
// pushed down so it never clips the top of the SVG.
export function tooltipPosition(point) {
  const left = Math.min(Math.max(point.x - TOOLTIP_SIZE.width / 2, PLOT.x0), PLOT.x1 - TOOLTIP_SIZE.width);
  const top = Math.max(point.y - (TOOLTIP_SIZE.height + TOOLTIP_GAP), TOOLTIP_MIN_TOP);
  return { left, top };
}

// Builds the whole car-level chart: one line per eligible used/CPO
// variant (see eligibleVariants), a month-labelled x axis with week
// ticks, and a nice-numbered y axis. Returns `hasSeries: false` and no
// geometry when nothing qualifies yet — the caller must render an honest
// empty state instead of an empty chart frame (requirement 004: "don't
// render an empty chart frame, and don't draw a flat line through a
// single point").
export function buildTrendChart(car, configurations, pricePoints) {
  const variants = eligibleVariants(car, configurations, pricePoints);
  if (!variants.length) {
    return { hasSeries: false, plot: PLOT, series: [], months: [], monthDividers: [], weekTicks: [], yAxisTicks: [] };
  }

  const domain = domainFor(variants);
  const pxPerDay = pxPerDayFor(domain);
  const yAxis = yAxisFor(variants);
  const { months, dividers } = monthLayout(domain, pxPerDay);

  const series = variants.map((variant) => {
    const points = variant.readings.map((r) => ({
      x: xForDay(toUtcDay(r.date), domain, pxPerDay),
      y: yFor(r.value, yAxis),
      date: r.date,
      value: r.value,
      seriesLabel: variant.label,
      color: variant.color,
    }));
    return { ...variant, points, latest: points[points.length - 1] };
  });

  return {
    hasSeries: true,
    plot: PLOT,
    series,
    months,
    monthDividers: dividers,
    weekTicks: weekTicksFor(domain, pxPerDay, variants),
    yAxisTicks: yAxis.ticks.map((v) => ({ value: v, y: yFor(v, yAxis), label: formatAxisValue(v) })),
  };
}

// --- Row sparkline geometry (112x44, "the chart in miniature") -----------

export const SPARK_VIEWBOX = { width: 112, height: 44 };
const SPARK = { x0: 8, x1: 104, yTop: 8, yBottom: 26, baselineY: 30, dividerTop: 4 };
export const SPARK_POINT_RADIUS = 2.5;
export const SPARK_POINT_RADIUS_LATEST = 3.5;

// Readings are spaced evenly by index across the miniature, not by
// elapsed days (the 112px width is too small for a literal date scale to
// read) — but month dividers still land on the real calendar boundary by
// interpolating piecewise between the readings that straddle it, so the
// miniature stays honest about when the month actually turned over.
function xForCalendarDay(day, readings, points) {
  const firstDay = toUtcDay(readings[0].date);
  const lastDay = toUtcDay(readings[readings.length - 1].date);
  if (day <= firstDay) return points[0].x;
  if (day >= lastDay) return points[points.length - 1].x;
  for (let i = 0; i < readings.length - 1; i++) {
    const d0 = toUtcDay(readings[i].date);
    const d1 = toUtcDay(readings[i + 1].date);
    if (day >= d0 && day <= d1) {
      const frac = d1 === d0 ? 0 : (day - d0) / (d1 - d0);
      return points[i].x + frac * (points[i + 1].x - points[i].x);
    }
  }
  return points[points.length - 1].x;
}

// Requirement 004: "Row sparklines at 112×44px repeat the chart's
// structure in miniature... Same encoding, not a different one." Returns
// null when there aren't at least two dated readings — same threshold as
// the main chart, since a single point can't draw a line either.
export function buildSparkline(variant) {
  const readings = variant.readings;
  if (readings.length < 2) return null;

  const values = readings.map((r) => r.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const n = readings.length;
  const stepX = (SPARK.x1 - SPARK.x0) / (n - 1);

  const points = readings.map((r, i) => ({
    x: SPARK.x0 + stepX * i,
    y: range === 0 ? (SPARK.yTop + SPARK.yBottom) / 2 : SPARK.yBottom - ((r.value - min) / range) * (SPARK.yBottom - SPARK.yTop),
    date: r.date,
    value: r.value,
  }));

  const firstDay = toUtcDay(readings[0].date);
  const lastDay = toUtcDay(readings[n - 1].date);
  const startDate = new Date(firstDay);

  const months = [];
  const dividers = [];
  let cursor = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1);
  let first = true;
  while (cursor <= lastDay) {
    const cursorDate = new Date(cursor);
    const nextCursor = Date.UTC(cursorDate.getUTCFullYear(), cursorDate.getUTCMonth() + 1, 1);
    const segStart = Math.max(cursor, firstDay);
    const segEndExclusive = Math.min(nextCursor, lastDay + DAY_MS);
    if (segEndExclusive > segStart) {
      const xStart = xForCalendarDay(segStart, readings, points);
      const xEnd = xForCalendarDay(Math.min(segEndExclusive, lastDay), readings, points);
      months.push({ name: MONTH_ABBR[cursorDate.getUTCMonth()], x: (xStart + xEnd) / 2 });
      if (!first) dividers.push(xForCalendarDay(segStart, readings, points));
    }
    first = false;
    cursor = nextCursor;
  }

  const changeSinceFirst = readings[n - 1].value - readings[0].value;

  return {
    viewBox: SPARK_VIEWBOX,
    baselineY: SPARK.baselineY,
    dividerTop: SPARK.dividerTop,
    points,
    latest: points[points.length - 1],
    monthDividers: dividers,
    monthLabels: months,
    changeSinceFirst,
    changeLabel: formatChange(changeSinceFirst),
  };
}
