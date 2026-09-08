/**
 * The market dashboard.
 *
 * Bring a Trailer shows you a model's past auction results. This shows the same
 * thing plus the half nobody publishes: what those cars are being ASKED for
 * right now, side by side with what they actually SOLD for, and the distance
 * between the two.
 *
 * Every chart here obeys one rule. A number is drawn only when the data behind
 * it supports drawing it. A trend line whose fit explains one percent of the
 * variance is not drawn as a trend, it is labelled flat. A median resting on
 * two sales is drawn with its sample size attached. The API computes those
 * judgements (see analytics/market.ts) and this file renders them rather than
 * second-guessing them, because a chart library will happily draw a confident
 * line through noise and nobody looking at the picture can tell.
 */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = (n) => (n === null || n === undefined ? '-' : '$' + Math.round(Number(n)).toLocaleString('en-US'));
const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
const pct = (n, digits = 1) => (n === null || n === undefined ? '-' : `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`);

const charts = [];

/**
 * Sequence number for dashboard loads.
 *
 * Two loads can be in flight at once: the route change fires one from whatever
 * the form happens to hold, and the user submitting a different model fires
 * another. Responses do not come back in the order they were sent, so without
 * this the slower first request paints over the newer one and the page shows
 * one model's charts beside another model's valuation. Every number on screen
 * is real; the combination is a lie.
 */
let loadSeq = 0;

function tokens() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (s.getPropertyValue(name) || fallback).trim();
  return {
    ink: v('--ink', '#12151a'),
    muted: v('--muted', '#5d6674'),
    line: v('--line', '#e0e4ea'),
    accent: v('--accent', '#0b5fff'),
    sold: v('--sold', '#6b2fbf'),
    great: v('--great', '#0a7d3f'),
    over: v('--over', '#b3261e'),
  };
}

function destroyCharts() {
  while (charts.length) charts.pop().destroy();
}

function baseOptions(t, extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      legend: { labels: { color: t.muted, boxWidth: 10, boxHeight: 10, usePointStyle: true } },
      tooltip: { backgroundColor: t.ink, titleColor: '#fff', bodyColor: '#fff', padding: 10, displayColors: false },
      ...extra.plugins,
    },
    scales: extra.scales,
  };
}

function axis(t, opts = {}) {
  return {
    ticks: { color: t.muted, font: { size: 11 }, ...opts.ticks },
    grid: { color: t.line, drawTicks: false },
    border: { color: t.line },
    ...opts,
  };
}

function card(id, title, subtitle, note = '') {
  return `<section class="chart-card">
    <header><h3>${esc(title)}</h3><p>${esc(subtitle)}</p></header>
    <div class="chart-wrap"><canvas id="${id}"></canvas></div>
    ${note ? `<footer class="chart-note">${note}</footer>` : ''}
  </section>`;
}

function stat(k, v, n, cls = '') {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div><div class="n">${esc(n ?? '')}</div></div>`;
}

/* ------------------------------------------------------------------ charts */

/**
 * Asking prices against completed sales, as two distributions.
 *
 * The gap between the two humps IS the product. A single median hides that the
 * two populations barely overlap.
 */
function drawDistribution(canvas, report, t) {
  const edges = new Set();
  for (const b of [...report.askHistogram, ...report.soldHistogram]) edges.add(b.from);
  const sorted = [...edges].sort((a, b) => a - b);
  const at = (bins, from) => bins.find((b) => b.from === from)?.n ?? 0;

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: sorted.map((e) => money(e)),
      datasets: [
        { label: `Asking (${report.ask.n})`, data: sorted.map((e) => at(report.askHistogram, e)), backgroundColor: t.accent + 'cc' },
        { label: `Sold (${report.sold.n})`, data: sorted.map((e) => at(report.soldHistogram, e)), backgroundColor: t.sold + 'cc' },
      ],
    },
    options: baseOptions(t, {
      scales: { x: axis(t, { stacked: false }), y: axis(t, { beginAtZero: true, title: { display: true, text: 'listings', color: t.muted } }) },
      plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y}` } } },
    }),
  });
}

/** Every completed sale as a point, with the fitted curve through them. */
function drawDepreciation(canvas, report, t) {
  const d = report.depreciation;
  const points = d.points.map((p) => ({ x: p.mileage, y: p.price, title: p.title }));
  const step = (d.xMax - d.xMin) / (d.priceAt.length - 1);
  const curve = d.priceAt.map((y, i) => ({ x: d.xMin + step * i, y }));

  return new Chart(canvas, {
    type: 'scatter',
    data: {
      datasets: [
        { label: `Completed sales (${d.n})`, data: points, backgroundColor: t.sold, pointRadius: 4, pointHoverRadius: 6 },
        {
          label: `Fitted curve (r2 ${d.r2.toFixed(2)})`,
          data: curve, type: 'line', borderColor: t.accent, borderWidth: 2,
          pointRadius: 0, fill: false, tension: 0.3,
        },
      ],
    },
    options: baseOptions(t, {
      scales: {
        x: axis(t, { title: { display: true, text: 'miles', color: t.muted }, ticks: { color: t.muted, callback: (v) => num(v) } }),
        y: axis(t, { title: { display: true, text: 'sold price', color: t.muted }, ticks: { color: t.muted, callback: (v) => money(v) } }),
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => (c.dataset.type === 'line'
              ? `fitted ${money(c.parsed.y)} at ${num(Math.round(c.parsed.x))} mi`
              : [c.raw.title, `${money(c.parsed.y)} at ${num(c.parsed.x)} mi`]),
          },
        },
      },
    }),
  });
}

/** Median sold price per period, with the interquartile band behind it. */
function drawTrend(canvas, report, t) {
  const pts = report.trend.points;
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: pts.map((p) => p.date),
      datasets: [
        { label: 'p75', data: pts.map((p) => p.p75), borderColor: 'transparent', backgroundColor: t.sold + '22', fill: '+1', pointRadius: 0 },
        { label: 'p25', data: pts.map((p) => p.p25), borderColor: 'transparent', backgroundColor: 'transparent', fill: false, pointRadius: 0 },
        {
          label: 'median sold', data: pts.map((p) => p.median), borderColor: t.sold, borderWidth: 2,
          // A point resting on one sale is drawn small; the size IS the caveat.
          pointRadius: pts.map((p) => Math.min(3 + p.n, 9)), pointBackgroundColor: t.sold, tension: 0.25, fill: false,
        },
      ],
    },
    options: baseOptions(t, {
      scales: { x: axis(t), y: axis(t, { ticks: { color: t.muted, callback: (v) => money(v) } }) },
      plugins: {
        legend: { labels: { color: t.muted, filter: (i) => i.text === 'median sold', usePointStyle: true, boxWidth: 10 } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const p = pts[c.dataIndex];
              return c.dataset.label === 'median sold'
                ? [`median ${money(p.median)}`, `${p.n} sale${p.n === 1 ? '' : 's'} this ${report.trend.bucket}`]
                : `${c.dataset.label} ${money(c.parsed.y)}`;
            },
          },
        },
      },
    }),
  });
}

/** Ask and sold medians side by side for every model year in the index. */
function drawByYear(canvas, report, t) {
  const rows = [...report.byYear].sort((a, b) => a.year - b.year);
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.year),
      datasets: [
        { label: 'median asking', data: rows.map((r) => r.askMedian), backgroundColor: t.accent + 'cc' },
        { label: 'median sold', data: rows.map((r) => r.soldMedian), backgroundColor: t.sold + 'cc' },
      ],
    },
    options: baseOptions(t, {
      scales: { x: axis(t), y: axis(t, { ticks: { color: t.muted, callback: (v) => money(v) } }) },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => {
              const r = rows[c.dataIndex];
              const n = c.datasetIndex === 0 ? r.askCount : r.soldCount;
              return `${c.dataset.label} ${money(c.parsed.y)} (${n} listing${n === 1 ? '' : 's'})`;
            },
          },
        },
      },
    }),
  });
}

/** What a buyer at each past period would be sitting on now, at the median. */
function drawBacktest(canvas, report, t) {
  const e = report.backtest.entries;
  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels: e.map((x) => x.date),
      datasets: [{
        label: 'change to today',
        data: e.map((x) => x.returnPercent),
        backgroundColor: e.map((x) => (x.returnPercent >= 0 ? t.great + 'cc' : t.over + 'cc')),
      }],
    },
    options: baseOptions(t, {
      scales: { x: axis(t), y: axis(t, { ticks: { color: t.muted, callback: (v) => `${v}%` } }) },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const x = e[c.dataIndex];
              return [
                `bought at the ${money(x.medianAtEntry)} median`,
                `now ${money(report.backtest.currentMedian)}: ${pct(x.returnPercent)}`,
                `${x.n} sale${x.n === 1 ? '' : 's'} set that median`,
              ];
            },
          },
        },
      },
    }),
  });
}

/* -------------------------------------------------------------- rendering */

function headline(report) {
  const dep = report.depreciation;
  const trend = report.trend;

  /**
   * The trend is stated in words the fit can support. `direction: 'flat'` means
   * the slope explains too little variance to claim one, and printing the raw
   * percent-per-month there would be the most misleading number on the page.
   */
  const trendValue =
    trend.direction === 'rising' ? `up ${pct(trend.percentPerMonth)} a month`
    : trend.direction === 'falling' ? `down ${pct(Math.abs(trend.percentPerMonth))} a month`
    : trend.direction === 'flat' ? 'no clear direction'
    : 'not enough dated sales';
  const trendNote =
    trend.direction === 'flat' ? `prices move, the trend does not (fit explains ${Math.round((trend.r2 ?? 0) * 100)}%)`
    : trend.from ? `${trend.populatedBuckets} ${trend.bucket}s, ${trend.from} to ${trend.to}`
    : 'no completed sales carry a date';

  return [
    stat('Median asking price', money(report.ask.median), `${num(report.ask.n)} listings`),
    stat('Median sold price', money(report.sold.median), `${num(report.sold.n)} completed sales`, 'sold'),
    stat(
      'Sellers ask above market',
      report.spread === null ? 'needs sold data' : money(report.spread),
      report.spreadPercent === null ? 'the number no other site shows' : `${pct(report.spreadPercent, 0)} over what buyers paid`,
      'spread',
    ),
    stat(
      'Value lost per 10,000 miles',
      dep ? money(dep.perTenThousandMiles) : 'needs sold data',
      dep ? `${dep.percentPerTenThousandMiles.toFixed(1)}% of value, fitted on ${dep.n} sales` : 'no completed sale carries a mileage',
    ),
    stat('Market direction', trendValue, trendNote),
    stat(
      'Days on market',
      report.daysOnMarket.median === null ? 'not observed yet' : `${num(report.daysOnMarket.median)} days`,
      report.daysOnMarket.n ? `median of ${num(report.daysOnMarket.n)} listings` : 'needs a second crawl to measure',
    ),
  ].join('');
}

function emptyState(scope) {
  return `<div class="state">
    <h3>Nothing indexed for ${esc([scope.make, scope.model].filter(Boolean).join(' ') || 'that search')}</h3>
    <p>The dashboard is computed from real listings and real completed sales. It does not
       generate a curve from nothing.</p>
    <p>Crawl this model first, then come back.</p>
  </div>`;
}

export async function loadDashboard(scope) {
  const mine = ++loadSeq;
  const stale = () => mine !== loadSeq;

  const root = $('#dash-body');
  destroyCharts();
  root.innerHTML = '<div class="skeleton lg"></div><div class="skeleton lg"></div>';

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(scope)) if (v) params.set(k, v);

  let report;
  try {
    const res = await fetch('/api/market?' + params);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    report = await res.json();
  } catch (e) {
    if (stale()) return null;
    root.innerHTML = `<div class="state"><h3>Could not load the market data</h3><p>${esc(e.message)}</p></div>`;
    return null;
  }

  // A newer request has already been sent, so this answer is about a car the
  // user has moved on from. Drop it rather than paint it.
  if (stale()) return null;

  if (report.counts.ask + report.counts.sold + report.counts.bid === 0) {
    root.innerHTML = emptyState(report.scope);
    return report;
  }

  const t = tokens();
  const bt = report.backtest;

  root.innerHTML = `
    <div class="dash-head">
      <h2>${esc([report.scope.make, report.scope.model].filter(Boolean).join(' ') || 'The whole index')}</h2>
      <p>${num(report.counts.ask)} asking, ${num(report.counts.sold)} completed sales, ${num(report.counts.bid)} live bids.</p>
    </div>
    <div class="comps-strip">${headline(report)}</div>

    ${card('c-dist', 'Asking prices against completed sales',
      'Two populations, not one. The distance between the humps is what sellers hope for and buyers do not pay.')}

    ${report.depreciation
      ? card('c-dep', 'What mileage is worth',
          'Every completed sale, with a curve fitted through them. Depreciation is multiplicative, so the fit is on log price.',
          `Fitted on ${report.depreciation.n} sales between ${num(Math.round(report.depreciation.xMin))} and ${num(Math.round(report.depreciation.xMax))} miles. ` +
          `The fit explains ${Math.round(report.depreciation.r2 * 100)}% of the variation` +
          (report.depreciation.n < 8 ? ', which is a thin sample: read the shape, not the number.' : '.'))
      : `<section class="chart-card empty"><header><h3>What mileage is worth</h3>
         <p>Needs completed sales that carry a mileage. None in the index for this model yet.</p></header></section>`}

    ${report.trend.points.length > 1
      ? card('c-trend', 'Sold prices over time',
          `Median per ${report.trend.bucket}, with the middle half shaded. Point size is the number of sales behind it.`,
          report.trend.direction === 'flat'
            ? `The fitted slope explains ${Math.round((report.trend.r2 ?? 0) * 100)}% of the variation, so no direction is claimed.`
            : `Covers ${report.trend.from} to ${report.trend.to}.`)
      : ''}

    ${report.byYear.length > 1 ? card('c-year', 'By model year',
      'Asking and sold medians per year. A missing sold bar means no completed sale on record for that year.') : ''}

    ${bt.entries.length
      ? card('c-backtest', 'Backtest: buying at each past median',
          `What a buyer at each ${report.trend.bucket}'s median would be sitting on at today's ${money(bt.currentMedian)} median.`,
          `${esc(bt.caveat)}${bt.annualizedPercent !== null
            ? ` Annualized over ${bt.months} months: ${pct(bt.annualizedPercent)}.`
            : ` Too short a window to annualize, so no annual figure is shown.`}`)
      : `<section class="chart-card empty"><header><h3>Backtest</h3>
         <p>${esc(bt.caveat)}</p></header></section>`}

    <section class="chart-card wide">
      <header><h3>By mileage band</h3><p>Where the asking market and the transacting market diverge most.</p></header>
      <div class="table-scroll"><table class="dash-table">
        <thead><tr><th>Miles</th><th>Asking median</th><th>n</th><th>Sold median</th><th>n</th><th>Spread</th></tr></thead>
        <tbody>${report.byMileage.map((b) => {
          const spread = b.askMedian !== null && b.soldMedian !== null && b.soldCount >= 3 ? b.askMedian - b.soldMedian : null;
          return `<tr>
            <td>${num(b.from)}${b.to === -1 ? '+' : ' to ' + num(b.to)}</td>
            <td>${money(b.askMedian)}</td><td class="n">${num(b.askCount)}</td>
            <td class="sold">${b.soldCount ? money(b.soldMedian) : '-'}</td><td class="n">${num(b.soldCount)}</td>
            <td>${spread === null ? '<span class="n">needs 3 sales</span>' : money(spread)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>`;

  if ($('#c-dist')) charts.push(drawDistribution($('#c-dist'), report, t));
  if ($('#c-dep')) charts.push(drawDepreciation($('#c-dep'), report, t));
  if ($('#c-trend')) charts.push(drawTrend($('#c-trend'), report, t));
  if ($('#c-year')) charts.push(drawByYear($('#c-year'), report, t));
  if ($('#c-backtest')) charts.push(drawBacktest($('#c-backtest'), report, t));

  // Returned so the caller renders the valuation from the SAME report the
  // charts were drawn from, rather than issuing a second request that can
  // resolve against different data.
  return report;
}

/** Repaint on a theme change, since the palette is read once at draw time. */
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.querySelector('#view-dashboard')?.hidden) window.dispatchEvent(new CustomEvent('carsearch:redraw'));
  });
}
