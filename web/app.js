/**
 * carsearch UI.
 *
 * Three ideas, borrowed deliberately:
 *
 *  - AutoTempest's source attribution. Results stay labelled with the site the
 *    car actually lives on, and a tab strip shows how many came from each, so a
 *    meta-search never feels like it is hiding where anything came from.
 *  - Bring a Trailer's photo-forward auction grid, because a completed sale is
 *    something you browse, not something you scan in a dense table.
 *  - One car shown once. The same vehicle is listed on several sites at a time,
 *    so it arrives grouped with a badge per site instead of repeated.
 *
 * The part neither of those has: every asking price is rated against what
 * comparable cars actually SOLD for, not against what other sellers are asking.
 */

import { loadFacets, currentFacetParams, activeFacetCount, clearFacets } from './facets.js';
import { loadDashboard } from './dashboard.js';

const $ = (s) => document.querySelector(s);
const money = (n) => (n === null || n === undefined ? '-' : '$' + Number(n).toLocaleString('en-US'));
const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const FILTER_IDS = ['make', 'model', 'yearMin', 'yearMax', 'priceMin', 'priceMax', 'mileageMax', 'sort'];
/** The one list both sort controls read, so they cannot drift apart. */
const SORT_OPTIONS = [
  { value: 'price', label: 'Lowest price' },
  { value: 'mileage', label: 'Lowest mileage' },
  { value: 'mileage+price', label: 'Lowest mileage and price' },
  { value: 'deal', label: 'Best deal vs sold' },
  { value: 'value', label: 'Best value' },
  { value: 'best', label: 'Best overall' },
  { value: 'year', label: 'Newest year' },
  { value: 'age', label: 'Oldest year' },
  { value: 'newest', label: 'Recently listed' },
  { value: 'days-on-market', label: 'Longest listed' },
];

const EXAMPLES = [
  'an old g wagon',
  'porsche macan under 40k with low miles',
  'what did a 2017 macan sell for',
  'electric suv under 50k',
  'manual coupe 2015-2020',
];

/** Results of the last search, kept so source tabs filter without a refetch. */
let lastResults = [];
let activeSource = 'all';

/**
 * How the results are laid out.
 *
 * Grid is the default because a car is a visual purchase, and a page of
 * thumbnails beside empty space is the layout every incumbent settled for.
 * List stays available because once you know what you want, density beats
 * photography, and switching should not cost a page load.
 */
let view = readPref('carsearch:view', 'grid');

/** Cars picked for comparison, and cars kept for later. Both survive a reload. */
const compare = new Set(readPref('carsearch:compare', []));
let savedCars = readPref('carsearch:saved', []);

function readPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    // A private window, cleared site data, or storage the browser refuses.
    // None of those should cost the user their results.
    return fallback;
  }
}

function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* nothing to do */ }
}

const isSaved = (id) => savedCars.some((c) => c.id === id);

function toggleSaved(id) {
  const row = lastResults.find((r) => r.id === id);
  if (!row) return;
  savedCars = isSaved(id)
    ? savedCars.filter((c) => c.id !== id)
    // Only what a saved-list row needs to render, so the store stays small.
    : [{ id, title: row.title, price: row.price, url: row.url, imageUrl: row.imageUrl, sourceId: row.sourceId }, ...savedCars].slice(0, 60);
  writePref('carsearch:saved', savedCars);
}

function toggleCompare(id) {
  if (compare.has(id)) compare.delete(id);
  // Four is the most that fits side by side without becoming a spreadsheet.
  else if (compare.size < 4) compare.add(id);
  else return false;
  writePref('carsearch:compare', [...compare]);
  return true;
}

/* ------------------------------------------------------------------ routing */

const VIEWS = {
  home: '#view-home', results: '#view-results', dashboard: '#view-dashboard',
  auctions: '#view-auctions', sources: '#view-sources',
};

function show(route) {
  for (const [name, sel] of Object.entries(VIEWS)) $(sel).hidden = name !== route;
  for (const a of document.querySelectorAll('.topnav a')) a.classList.toggle('active', a.dataset.route === route);
  if (route === 'sources') loadSources();
  if (route === 'auctions') loadAuctions();
  if (route === 'dashboard') runDashboard();
}

function routeFromHash() {
  const r = (location.hash || '#/').replace('#/', '') || 'home';
  return VIEWS[r] ? r : 'home';
}

window.addEventListener('hashchange', () => show(routeFromHash()));

/* ---------------------------------------------------------------- rendering */

function stat(k, v, n, cls = '') {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div><div class="n">${esc(n ?? '')}</div></div>`;
}

function badge(text, cls = '') {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

/**
 * A deal grade is only rendered when it rests on enough completed sales. A
 * confident badge computed from two data points is worse than no badge, because
 * a buyer will act on it.
 */
function dealBadge(deal) {
  if (!deal || !deal.grade) return '';
  const label = { great: 'GREAT DEAL', good: 'GOOD DEAL', fair: 'FAIR PRICE', high: 'ABOVE MARKET', overpriced: 'OVERPRICED' }[deal.grade];
  return `<div><span class="deal ${deal.grade}" title="${esc(deal.explanation)}">${label}</span>
          <span class="deal-why">${esc(deal.explanation)}</span></div>`;
}

/**
 * Why this car is where it is in the list.
 *
 * A ranked list that cannot explain itself is a black box, and a buyer has no
 * reason to trust the order. Every ranked dimension reports the car's actual
 * position on it, which is checkable against the list itself.
 */
function rankBadges(r) {
  const rank = r.rank;
  if (!rank) return '';
  const parts = [];

  /**
   * The frontier badge lives on the photo, not here.
   *
   * Layer 1 means nothing in the result set beats this car on every ranked
   * dimension at once, which is the strongest claim the ranking can make, so it
   * belongs where the eye lands first. Saying it twice on one card made it read
   * as decoration rather than as a finding.
   */
  /**
   * Positions are shown only when the ranking is a trade-off.
   *
   * On a single-axis sort, "#1 lowest price" on the first card and "#2" on the
   * second restates the order the eye already has, on every card, forever. Where
   * two axes pull against each other the positions ARE the explanation for why
   * a car sits where it does, which is the whole reason they exist.
   */
  const reasons = (rank.reasons ?? []).filter((x) => x.position !== null);
  if (reasons.length > 1) {
    for (const reason of reasons) {
      parts.push(`<span class="rank-reason">#${reason.position} ${esc(reason.label)} <span class="of">of ${reason.outOf}</span></span>`);
    }
  }
  for (const key of rank.unknown ?? []) {
    parts.push(`<span class="rank-reason unknown" title="Ranked last on this because the listing never states it">no ${esc(key)} stated</span>`);
  }
  return parts.length ? `<div class="rankline">${parts.join('')}</div>` : '';
}

/**
 * A result card.
 *
 * Cars are a visual purchase, and the previous card gave a 148px thumbnail a
 * third of the width and left the middle column empty. The good ideas are
 * borrowed openly and each one earns its place:
 *
 *  - Bring a Trailer's photo-forward grid. A car you cannot see is a row of
 *    text, and people do not shop for cars by reading.
 *  - CarGurus' deal prominence, with one correction that is the whole point of
 *    this project: theirs rates a listing against other ASKING prices, ours
 *    against what comparable cars actually SOLD for.
 *  - AutoTempest's source attribution, so a meta-search never feels like it is
 *    hiding where anything came from.
 *  - The save and compare affordances every property site has had for a decade
 *    and no car site does well.
 */

const DEAL_LABEL = {
  great: 'GREAT DEAL', good: 'GOOD DEAL', fair: 'FAIR PRICE',
  high: 'ABOVE MARKET', overpriced: 'OVERPRICED',
};

/** "$20,100 below the $38,000 median of 5 sales" reduced to the number that matters. */
function dealDelta(deal) {
  if (!deal || !deal.grade) return '';
  const under = deal.dollarsVsSold < 0;
  return `<div class="delta ${under ? 'under' : 'over'}">${money(Math.abs(deal.dollarsVsSold))} ${under ? 'below' : 'above'} market
    <span class="basis">${deal.sampleSize} sold</span></div>`;
}

/** The facts a buyer scans first, in the order they scan them. */
function specRow(r) {
  const bits = [
    r.mileage !== null && r.mileage !== undefined ? `${num(r.mileage)} mi` : null,
    r.transmission ? esc(r.transmission.replace('-', ' ')) : null,
    r.drivetrain ? esc(r.drivetrain.toUpperCase()) : null,
    r.titleStatus && r.titleStatus !== 'clean' ? `<span class="warn">${esc(r.titleStatus)} title</span>` : null,
    r.location ? esc(r.location) : null,
  ].filter(Boolean);
  return bits.length ? `<div class="specs">${bits.join('<span class="dot">·</span>')}</div>` : '';
}

function card(r, view) {
  const kindClass = r.priceKind === 'sold' ? 'sold' : r.priceKind === 'bid' ? 'bid' : '';
  const kindLabel = r.priceKind === 'sold' ? 'sold for' : r.priceKind === 'bid' ? 'current bid' : '';
  const history = r.priceHistory ?? [];
  const dropped = history.length > 1 && history[history.length - 1].price < history[0].price;
  const drop = dropped ? history[0].price - history[history.length - 1].price : 0;
  const frontier = r.rank?.paretoLayer === 1;
  const deal = r.deal;
  const saved = isSaved(r.id);
  const picked = compare.has(r.id);

  /**
   * A photoless listing still has to look like a car. A blank grey block reads
   * as a broken image, so the slot carries the car's own identity instead.
   */
  const photo = r.imageUrl
    ? `<img src="${esc(r.imageUrl)}" alt="" loading="lazy" decoding="async">`
    : `<div class="noimg"><span class="noimg-y">${esc(r.year ?? '')}</span>
         <span class="noimg-m">${esc([r.make, r.model].filter(Boolean).join(' ') || 'Listing')}</span>
         <span class="noimg-n">no photo published</span></div>`;

  const title = esc(r.title || 'Untitled listing');
  const heading = r.url
    ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${title}</a>`
    : title;

  /** Small, factual notes. Anything that changes a decision, nothing that does not. */
  const notes = [
    dropped ? `<span class="note drop">price dropped ${money(drop)}</span>` : '',
    r.daysOnMarket > 0 ? `<span class="note">${r.daysOnMarket}d listed</span>` : '',
    r.mileageIsRounded ? `<span class="note">mileage rounded</span>` : '',
    (r.alsoOn ?? []).length ? `<span class="note">also on ${(r.alsoOn ?? []).map(esc).join(', ')}</span>` : '',
    r.certified ? `<span class="note good">certified</span>` : '',
  ].filter(Boolean).join('');

  return `<article class="rcard is-${view === 'grid' ? 'grid' : 'rows'}${picked ? ' picked' : ''}" data-id="${esc(r.id)}">
    <div class="ph">
      ${photo}
      ${deal && deal.grade ? `<span class="ribbon ${deal.grade}" title="${esc(deal.explanation)}">${DEAL_LABEL[deal.grade]}</span>` : ''}
      ${frontier ? `<span class="ribbon best" title="Nothing in these results beats it on every thing you ranked by">BEST OF BOTH</span>` : ''}
      <span class="src-tag">${esc(r.sourceId)}</span>
      <div class="acts">
        <button class="act save${saved ? ' on' : ''}" data-act="save" data-id="${esc(r.id)}"
                aria-label="${saved ? 'Remove from saved' : 'Save this car'}" aria-pressed="${saved}">${saved ? '♥' : '♡'}</button>
        <button class="act cmp${picked ? ' on' : ''}" data-act="compare" data-id="${esc(r.id)}"
                aria-label="${picked ? 'Remove from comparison' : 'Add to comparison'}" aria-pressed="${picked}">⇄</button>
      </div>
    </div>
    <div class="body">
      <h3>${heading}</h3>
      ${specRow(r)}
      <div class="notes">${notes}</div>
    </div>
    <div class="pricing">
      <div class="amount ${kindClass}">${money(r.price)}${r.currency && r.currency !== 'USD' ? `<span class="cur">${esc(r.currency)}</span>` : ''}</div>
      ${kindLabel ? `<div class="kind">${kindLabel}</div>` : ''}
      ${dealDelta(deal)}
      ${rankBadges(r)}
    </div>
  </article>`;
}

/** The source strip. Counts are real, so a source contributing nothing says so by being absent. */
function renderSourceTabs(results) {
  const el = $('#source-tabs');
  const counts = {};
  for (const r of results) counts[r.sourceId] = (counts[r.sourceId] ?? 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length <= 1) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML =
    `<button class="source-tab ${activeSource === 'all' ? 'active' : ''}" data-src="all" role="tab">All <span class="n">${results.length}</span></button>` +
    entries.map(([id, n]) =>
      `<button class="source-tab ${activeSource === id ? 'active' : ''}" data-src="${esc(id)}" role="tab">${esc(id)} <span class="n">${n}</span></button>`,
    ).join('');
  for (const b of el.querySelectorAll('.source-tab')) {
    b.addEventListener('click', () => { activeSource = b.dataset.src; paintList(); renderSourceTabs(lastResults); });
  }
}

function paintList() {
  const rows = activeSource === 'all' ? lastResults : lastResults.filter((r) => r.sourceId === activeSource);
  const el = $('#list');
  el.className = `list is-${view === 'grid' ? 'grid' : 'rows'}`;
  el.innerHTML = rows.length
    ? rows.map((r) => card(r, view)).join('')
    : `<div class="state"><h3>Nothing from ${esc(activeSource)}</h3><p>Pick another source, or widen the filters.</p></div>`;
  paintToolbar(rows.length);
  paintCompareTray();
}

/**
 * The bar above the results.
 *
 * Sort and view belong here rather than in the filter rail: they change how you
 * READ the answer, not what the answer is, and burying a view toggle in a
 * sidebar is why most sites only ever have one view.
 */
function paintToolbar(shown) {
  const el = $('#toolbar');
  if (!lastResults.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="tb-count"><strong>${num(shown)}</strong> ${shown === 1 ? 'car' : 'cars'}${
      activeSource === 'all' ? '' : ` from ${esc(activeSource)}`}</div>
    <div class="tb-right">
      <label class="tb-sort">Rank by
        <select id="tb-sortsel">${SORT_OPTIONS.map((o) =>
          `<option value="${esc(o.value)}"${($('#f-sort')?.value === o.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
      </label>
      <div class="tb-view" role="group" aria-label="Layout">
        <button class="vbtn${view === 'grid' ? ' on' : ''}" data-view="grid" aria-pressed="${view === 'grid'}" title="Photo grid">▦</button>
        <button class="vbtn${view === 'list' ? ' on' : ''}" data-view="list" aria-pressed="${view === 'list'}" title="Dense list">☰</button>
      </div>
    </div>`;

  $('#tb-sortsel').addEventListener('change', (e) => {
    $('#f-sort').value = e.target.value;
    runSearch($('#q').value.trim() || '');
  });
  for (const b of el.querySelectorAll('.vbtn')) {
    b.addEventListener('click', () => {
      view = b.dataset.view;
      writePref('carsearch:view', view);
      paintList();
    });
  }
}

/**
 * The comparison tray.
 *
 * Sticky at the bottom while cars are selected, because the whole value of
 * comparison is picking things from different parts of a long list, and a
 * control that scrolls away makes that impossible.
 */
function paintCompareTray() {
  const el = $('#cmp-tray');
  // The tray is fixed to the viewport, so the page has to make room for it or
  // the last card is unreachable.
  document.body.classList.toggle('has-tray', compare.size > 0);
  const picked = [...compare].map((id) => lastResults.find((r) => r.id === id)).filter(Boolean);
  if (picked.length === 0) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="tray-cars">${picked.map((r) => `
      <span class="tray-car">
        ${r.imageUrl ? `<img src="${esc(r.imageUrl)}" alt="">` : '<span class="tray-noimg"></span>'}
        <span class="tray-t">${esc((r.title || '').slice(0, 30))}</span>
        <button class="tray-x" data-act="compare" data-id="${esc(r.id)}" aria-label="Remove from comparison">×</button>
      </span>`).join('')}</div>
    <div class="tray-actions">
      <button class="ghost" id="cmp-clear">Clear</button>
      <button class="primary" id="cmp-open"${picked.length < 2 ? ' disabled' : ''}>
        Compare ${picked.length < 2 ? '(pick 2 or more)' : `these ${picked.length}`}
      </button>
    </div>`;
  $('#cmp-clear').addEventListener('click', () => { compare.clear(); writePref('carsearch:compare', []); paintList(); });
  $('#cmp-open').addEventListener('click', openCompare);
}

/**
 * Side by side, with the rows that differ marked.
 *
 * The reason no car site does this well is that a comparison of forty
 * attributes is a spreadsheet nobody reads. What a buyer wants is the short
 * list of things these particular cars do NOT agree on, so identical rows are
 * dimmed and the differing ones carry a marker.
 */
const COMPARE_ROWS = [
  { key: 'price', label: 'Price', fmt: (r) => money(r.price) },
  { key: 'priceKind', label: 'Price is', fmt: (r) => ({ ask: 'an asking price', bid: 'a current bid', sold: 'a completed sale' })[r.priceKind] ?? r.priceKind },
  { key: 'deal', label: 'Against sold prices', fmt: (r) => (r.deal && r.deal.grade ? `${DEAL_LABEL[r.deal.grade]} — ${r.deal.explanation}` : (r.deal?.reason ?? 'not rated')) },
  { key: 'year', label: 'Year', fmt: (r) => r.year ?? '-' },
  { key: 'mileage', label: 'Mileage', fmt: (r) => (r.mileage === null || r.mileage === undefined ? 'not stated' : `${num(r.mileage)} mi${r.mileageIsRounded ? ' (rounded)' : ''}`) },
  { key: 'titleStatus', label: 'Title', fmt: (r) => r.titleStatus ?? 'not stated' },
  { key: 'owners', label: 'Owners', fmt: (r) => r.owners ?? 'not stated' },
  { key: 'accidents', label: 'Accidents reported', fmt: (r) => (r.accidents === null || r.accidents === undefined ? 'not stated' : r.accidents) },
  { key: 'trim', label: 'Trim', fmt: (r) => r.trim ?? '-' },
  { key: 'series', label: 'Generation', fmt: (r) => r.series ?? 'not decoded' },
  { key: 'transmission', label: 'Transmission', fmt: (r) => r.transmission ?? 'not stated' },
  { key: 'drivetrain', label: 'Drivetrain', fmt: (r) => (r.drivetrain ? r.drivetrain.toUpperCase() : 'not stated') },
  { key: 'engine', label: 'Engine', fmt: (r) => r.engine ?? 'not stated' },
  { key: 'mpgCity', label: 'MPG city / highway', fmt: (r) => (r.mpgCity ? `${r.mpgCity} / ${r.mpgHighway ?? '-'}` : 'not stated') },
  { key: 'exteriorColor', label: 'Colour', fmt: (r) => r.exteriorColor ?? 'not stated' },
  { key: 'sellerType', label: 'Seller', fmt: (r) => r.sellerType ?? 'not stated' },
  { key: 'location', label: 'Location', fmt: (r) => r.location ?? 'not stated' },
  { key: 'daysOnMarket', label: 'Days listed', fmt: (r) => (r.daysOnMarket > 0 ? r.daysOnMarket : 'first sighting') },
  { key: 'sourceId', label: 'Listed on', fmt: (r) => [r.sourceId, ...(r.alsoOn ?? [])].join(', ') },
];

function openCompare() {
  const cars = [...compare].map((id) => lastResults.find((r) => r.id === id)).filter(Boolean);
  if (cars.length < 2) return;
  const el = $('#cmp-modal');
  el.hidden = false;
  document.body.style.overflow = 'hidden';

  const rows = COMPARE_ROWS.map((row) => {
    const values = cars.map((c) => String(row.fmt(c)));
    const differs = new Set(values).size > 1;
    return `<tr class="${differs ? 'differs' : 'same'}">
      <th scope="row">${esc(row.label)}</th>
      ${values.map((v) => `<td>${esc(v)}</td>`).join('')}
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="cmp-sheet" role="dialog" aria-modal="true" aria-label="Compare cars">
    <header>
      <h2>Comparing ${cars.length} cars</h2>
      <p>Rows these cars agree on are dimmed. What is left is the decision.</p>
      <button class="cmp-close" aria-label="Close comparison">×</button>
    </header>
    <div class="cmp-scroll">
      <table class="cmp-table">
        <thead><tr><th></th>${cars.map((c) => `<th scope="col">
          ${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="">` : '<span class="tray-noimg"></span>'}
          <span>${esc(c.title || 'Untitled')}</span>
          ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">View on ${esc(c.sourceId)}</a>` : ''}
        </th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;

  const close = () => { el.hidden = true; document.body.style.overflow = ''; };
  el.querySelector('.cmp-close').addEventListener('click', close);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  document.addEventListener('keydown', function esc2(e) {
    if (e.key !== 'Escape') return;
    close();
    document.removeEventListener('keydown', esc2);
  });
}

function renderUnderstood(data) {
  const el = $('#understood');
  const lines = data.understood ?? [];
  if (!lines.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML =
    '<span class="lead">Understood as</span>' +
    lines.map((l) => `<span class="chip">${esc(l)}</span>`).join('') +
    `<span class="parser">${esc(data.parser)}</span>`;
}

function syncFilters(q) {
  if (!q) return;
  const set = (id, v) => { const el = $('#f-' + id); if (el) el.value = v ?? ''; };
  set('make', q.make); set('model', q.models ? q.models[0] : q.model);
  // The sentence box may have asked for an ordering. Reflect it in the control,
  // so the user can see what was understood and change it.
  if (q.sort && $('#f-sort')) $('#f-sort').value = q.sort;
  set('yearMin', q.yearMin); set('yearMax', q.yearMax);
  set('priceMin', q.priceMin); set('priceMax', q.priceMax); set('mileageMax', q.mileageMax);
  const kinds = q.priceKinds ?? ['ask'];
  $('#k-ask').checked = kinds.includes('ask');
  $('#k-sold').checked = kinds.includes('sold');
  $('#k-bid').checked = kinds.includes('bid');
}

async function loadComps(make, model, yearMin, yearMax) {
  const strip = $('#comps-strip');
  if (!make || !model) { strip.hidden = true; return; }
  const p = new URLSearchParams({ make, model });
  if (yearMin) p.set('yearMin', yearMin);
  if (yearMax) p.set('yearMax', yearMax);
  try {
    const c = await (await fetch('/api/comps?' + p)).json();
    strip.hidden = false;
    if (!c.sold || c.sold.count === 0) {
      strip.innerHTML = stat('Completed sales', 'none yet', 'Crawl an auction source to populate the comparison');
      return;
    }
    strip.innerHTML = [
      stat('Median asking price', money(c.asking.median), `${c.asking.count} listings`),
      stat('Median sold price', money(c.sold.median), `${c.sold.count} completed sales`, 'sold'),
      stat('Sellers ask above market', c.spread === null ? '-' : money(c.spread), 'the number no other site shows', 'spread'),
      stat('Sold range', `${money(c.sold.low)} to ${money(c.sold.high)}`, 'actual transactions'),
    ].join('');
  } catch { strip.hidden = true; }
}

/* ------------------------------------------------------------------ actions */

function readFilters() {
  const f = { ...currentFacetParams() };
  for (const id of FILTER_IDS) { const v = $('#f-' + id)?.value.trim(); if (v) f[id] = v; }
  const kinds = [];
  if ($('#k-ask').checked) kinds.push('ask');
  if ($('#k-sold').checked) kinds.push('sold');
  if ($('#k-bid').checked) kinds.push('bid');
  f.priceKinds = kinds.join(',') || 'ask';
  f.limit = 300;
  return f;
}

async function runSearch(question) {
  if (question) recordRecent(question);
  location.hash = '#/results';
  show('results');
  activeSource = 'all';
  const listEl = $('#list');
  listEl.className = `list is-${view === 'grid' ? 'grid' : 'rows'}`;
  // Skeletons in the shape of the cards they stand in for, so the page does not
  // jump when the real results land.
  listEl.innerHTML = Array.from({ length: view === 'grid' ? 9 : 6 },
    () => `<div class="skeleton is-${view === 'grid' ? 'grid' : 'rows'}"></div>`).join('');
  $('#summary').hidden = true;
  $('#understood').hidden = true;
  $('#source-tabs').hidden = true;
  $('#toolbar').hidden = true;

  try {
    let data;
    if (question) {
      const res = await fetch('/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: question, limit: 300, sort: $('#f-sort')?.value || undefined }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
      renderUnderstood(data);
      syncFilters(data.query);
    } else {
      const res = await fetch('/api/search?' + new URLSearchParams(readFilters()));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    }

    lastResults = data.results ?? [];
    const s = data.stats ?? {};
    const sortInfo = data.sort ?? {};
    $('#summary').hidden = false;
    $('#summary').innerHTML =
      `<strong>${s.uniqueVehicles ?? lastResults.length}</strong> unique vehicles from <strong>${s.rawListings ?? lastResults.length}</strong> listings. ` +
      `${s.duplicatesRemoved ?? 0} duplicates collapsed, ${s.crossSourceGroups ?? 0} of them listed on more than one site.` +
      (sortInfo.label ? ` <span class="sortline">Ranked by <strong>${esc(sortInfo.label.toLowerCase())}</strong>` +
        (sortInfo.frontierSize ? `, ${sortInfo.frontierSize} of them beaten by nothing on every axis` : '') + '.</span>' : '') +
      // Two honesty flags. Both describe results the user cannot otherwise see
      // are missing, which is the failure mode of facet search on sparse data.
      ((s.excludedForUnknown ?? []).length
        ? `<span class="warnline">${s.excludedForUnknown.map(esc).join('. ')}.</span>` : '') +
      (s.poolTruncated
        ? `<span class="warnline">More than ${s.poolCap} listings matched, so the ranking saw the first ${s.poolCap}. Narrow the search to rank the whole set.</span>` : '');

    if (lastResults.length === 0) {
      $('#list').innerHTML = `<div class="state">
        <h3>Nothing indexed for that search yet</h3>
        <p>The index only holds what has been crawled, and it never invents a listing to fill the page.</p>
        <p><code>npx tsx src/cli.ts search --make porsche --model macan --max-price 40000</code></p></div>`;
      $('#comps-strip').hidden = true;
      return;
    }

    renderSourceTabs(lastResults);
    paintList();
    const q = data.query ?? readFilters();
    const make = q.make || lastResults[0]?.make;
    const model = (q.models && q.models[0]) || q.model || lastResults[0]?.model;
    loadComps(make, model, q.yearMin, q.yearMax);
    // Coverage is scoped to what is on screen: "412 of 2,259" is a different
    // and less useful claim than "412 of the 266 Macans in these results".
    loadFacets($('#facet-panel'), { make, model, priceKinds: readFilters().priceKinds }, () => runSearch());
    // Carry the search across, so the market view opens on the car just looked at.
    if (make) $('#d-make').value = make;
    if (model) $('#d-model').value = model;
  } catch (e) {
    $('#list').innerHTML = `<div class="state"><h3>Could not reach the API</h3>
      <p>${esc(e.message)}</p><p>Start it with <code>npm run serve</code>.</p></div>`;
  }
}

/* ----------------------------------------------------------------- auctions */

function auctionCard(r, live) {
  const img = r.imageUrl
    ? `<img src="${esc(r.imageUrl)}" alt="" loading="lazy">`
    : '<div style="width:100%;height:100%;display:grid;place-items:center;color:var(--muted);font-size:12px">no photo</div>';
  const title = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title);
  return `<article class="acard">
    <div class="ph">${img}<span class="stamp ${live ? 'live' : ''}">${live ? 'LIVE' : 'SOLD'}</span></div>
    <div class="body">
      <h4>${title}</h4>
      <div class="row2">
        <span class="amt ${live ? 'live' : ''}">${money(r.price)}</span>
        <span class="when">${esc(r.eventDate ?? r.sourceId)}</span>
      </div>
    </div>
  </article>`;
}

async function loadAuctions() {
  const liveEl = $('#auction-live');
  const soldEl = $('#auction-sold');
  soldEl.innerHTML = '<div class="skeleton"></div>';
  const p = new URLSearchParams();
  const make = $('#f-make').value.trim();
  const model = $('#f-model').value.trim();
  if (make) p.set('make', make);
  if (model) p.set('model', model);

  try {
    const d = await (await fetch('/api/auctions?' + p)).json();
    const sum = $('#auction-summary');
    if (d.summary.soldCount) {
      sum.hidden = false;
      sum.innerHTML = [
        stat('Completed sales', d.summary.soldCount, 'in the index', 'sold'),
        stat('Median sold', money(d.summary.median), 'what buyers actually paid', 'sold'),
        stat('Range', `${money(d.summary.low)} to ${money(d.summary.high)}`, 'actual transactions'),
        stat('Live auctions', d.summary.liveCount, 'current bids, not prices paid'),
      ].join('');
    } else { sum.hidden = true; }

    liveEl.innerHTML = d.live.length
      ? `<div class="auction-section"><h3>Live now, showing the current bid</h3><div class="grid">${d.live.map((r) => auctionCard(r, true)).join('')}</div></div>`
      : '';
    soldEl.innerHTML = d.sold.length
      ? `<div class="auction-section"><h3>Recently sold</h3><div class="grid">${d.sold.map((r) => auctionCard(r, false)).join('')}</div></div>`
      : `<div class="state"><h3>No completed sales indexed yet</h3>
         <p>Crawl an auction source to populate this:</p>
         <p><code>npx tsx src/cli.ts search --make porsche --model macan --sources bringatrailer,carsandbids</code></p></div>`;
  } catch (e) {
    soldEl.innerHTML = `<div class="state"><h3>Could not reach the API</h3><p>${esc(e.message)}</p></div>`;
  }
}

/* ------------------------------------------------------------------ sources */

async function loadSources() {
  const el = $('#sources-body');
  el.innerHTML = '<div class="skeleton"></div>';
  const d = await (await fetch('/api/sources')).json();
  const st = d.stats;
  el.innerHTML = `
    <div class="comps-strip" style="margin-bottom:18px">
      ${stat('Sources tracked', st.total, `${st.countries.length} countries`)}
      ${stat('Adapters wired', d.wired.length, d.wired.join(', '))}
      ${stat('Live', st.byStatus.live ?? 0, 'verified working')}
      ${stat('Blocked', st.byStatus.blocked ?? 0, 'recorded so nobody retests blindly')}
    </div>
    <div class="scroll"><table>
      <thead><tr><th>id</th><th>name</th><th>status</th><th>transport</th><th>category</th><th>countries</th><th>wired</th></tr></thead>
      <tbody>${d.sources.map((s) => `<tr>
        <td>${esc(s.id)}</td><td>${esc(s.name)}</td>
        <td><span class="pill ${s.status === 'live' ? 'live' : s.status === 'blocked' ? 'blocked' : ''}">${esc(s.status)}</span></td>
        <td>${esc(s.transport)}</td><td>${esc(s.category)}</td><td>${esc(s.countries.join(', '))}</td>
        <td>${d.wired.includes(s.id) ? 'yes' : ''}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

async function loadSourceChips() {
  try {
    const d = await (await fetch('/api/sources')).json();
    $('#source-chips').innerHTML = d.sources
      .filter((s) => s.status === 'live' || s.status === 'via-aggregator' || s.status === 'planned')
      .slice(0, 26)
      .map((s) => `<span class="source-chip ${d.wired.includes(s.id) ? 'wired' : ''}">${esc(s.name)}</span>`)
      .join('');
  } catch { /* the landing page still works without the chip strip */ }
}

/* ------------------------------------------- recent and saved searches */

const SAVED_KEY = 'carsearch.saved';
const RECENT_KEY = 'carsearch.recent';

/** localStorage throws outright in some privacy modes, so every access is guarded. */
function readList(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; }
}
function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list.slice(0, 12))); } catch { /* private mode */ }
}

function renderPanel(sel, key, emptyText) {
  const el = $(sel);
  if (!el) return;
  const list = readList(key);
  el.innerHTML = list.length
    ? list.map((s, i) => `<a href="#" data-key="${key}" data-i="${i}">${esc(s.label)}</a>`).join('')
    : `<p class="empty">${esc(emptyText)}</p>`;
  for (const a of el.querySelectorAll('a')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const item = readList(a.dataset.key)[Number(a.dataset.i)];
      if (!item) return;
      $('#q').value = item.q;
      runSearch(item.q);
    });
  }
}

function renderPanels() {
  renderPanel('#recent-panel', RECENT_KEY, 'Your recent searches will appear here.');
  renderPanel('#saved-panel', SAVED_KEY, 'Your saved searches will appear here.');
  renderSavedSidebar();
}

function renderSavedSidebar() {
  const el = $('#saved');
  if (!el) return;
  const list = readList(SAVED_KEY);
  el.innerHTML = list.length
    ? '<div class="hint" style="margin-bottom:2px">Saved</div>' + list.map((s, i) => `<a href="#" data-i="${i}">${esc(s.label)}</a>`).join('')
    : '';
  for (const a of el.querySelectorAll('a')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const item = readList(SAVED_KEY)[Number(a.dataset.i)];
      if (item) { $('#q').value = item.q; runSearch(item.q); }
    });
  }
}

function recordRecent(q) {
  if (!q) return;
  const list = readList(RECENT_KEY).filter((s) => s.q !== q);
  list.unshift({ q, label: q.slice(0, 44) });
  writeList(RECENT_KEY, list);
  renderPanels();
}

/* ----------------------------------------------- landing form behaviour */

let VOCAB = { makes: [], models: {} };

async function loadVocabulary() {
  try {
    VOCAB = await (await fetch('/api/vocabulary')).json();
  } catch { return; }
  const makeSel = $('#h-make');
  if (!makeSel) return;
  makeSel.innerHTML = '<option value="">Any make</option>' + VOCAB.makes.map((m) => `<option>${esc(m)}</option>`).join('');
  makeSel.addEventListener('change', () => {
    const models = VOCAB.models[makeSel.value.toLowerCase()] ?? [];
    $('#h-model').innerHTML = '<option value="">Any model</option>' + models.map((m) => `<option>${esc(m)}</option>`).join('');
  });
}

/** Uses a real listing photo as the landing background rather than stock art. */
async function loadHero() {
  try {
    const h = await (await fetch('/api/hero')).json();
    if (h.imageUrl) $('#hero-bg').style.backgroundImage = `url("${h.imageUrl}")`;
  } catch { /* the flat background is a fine fallback */ }
}

/** Turns the structured form into the same sentence the description box takes. */
function formToQuestion() {
  const parts = [];
  const make = $('#h-make').value.trim();
  const model = $('#h-model').value.trim();
  const zip = $('#h-zip').value.trim();
  const yearMin = $('#h-yearMin').value.trim();
  const yearMax = $('#h-yearMax').value.trim();
  const priceMax = $('#h-priceMax').value.trim();
  const mileageMax = $('#h-mileageMax').value.trim();
  if (yearMin && yearMax) parts.push(`${yearMin}-${yearMax}`);
  else if (yearMin) parts.push(`${yearMin} or newer`);
  else if (yearMax) parts.push(`${yearMax} or older`);
  if (make) parts.push(make);
  if (model) parts.push(model);
  if (priceMax) parts.push(`under ${priceMax}`);
  if (mileageMax) parts.push(`under ${mileageMax} miles`);
  if (zip) parts.push(zip);
  const kinds = document.querySelector('.tab.active')?.dataset.kinds ?? 'ask';
  if (kinds === 'sold') parts.push('sold');
  return parts.join(' ').trim();
}

/* --------------------------------------------------------------------- wire */

$('#examples').innerHTML = EXAMPLES.map((e) => `<button class="example" type="button">${esc(e)}</button>`).join('');
for (const b of $('#examples').querySelectorAll('.example')) {
  b.addEventListener('click', () => { $('#q').value = b.textContent; runSearch(b.textContent); });
}

for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    for (const o of document.querySelectorAll('.tab')) o.classList.toggle('active', o === t);
  });
}

$('#adv-toggle').addEventListener('click', () => {
  const adv = $('#adv');
  adv.hidden = !adv.hidden;
  $('#adv-toggle').setAttribute('aria-expanded', String(!adv.hidden));
  $('#adv-toggle').textContent = adv.hidden ? 'Advanced search' : 'Hide advanced search';
});

$('#h-go').addEventListener('click', () => {
  const q = formToQuestion();
  if (!q) return;
  $('#q').value = q;
  runSearch(q);
});

$('#hero-search').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#hero-q').value.trim();
  $('#q').value = v;
  runSearch(v);
});
$('#search').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('#q').value.trim()); });
$('#apply').addEventListener('click', () => { $('#q').value = ''; runSearch(''); });
$('#reset').addEventListener('click', () => {
  for (const id of FILTER_IDS) { const el = $('#f-' + id); if (el) el.value = ''; }
  clearFacets();
  $('#q').value = '';
  runSearch('');
});
// Changing the ranking re-runs immediately. Re-ranking is not a filter change,
// so making the user press Apply for it reads as though nothing happened.
$('#f-sort').addEventListener('change', () => runSearch($('#q').value.trim() || ''));
$('#save-search').addEventListener('click', () => {
  const q = $('#q').value.trim();
  if (!q) return;
  const list = readList(SAVED_KEY).filter((s) => s.q !== q);
  list.unshift({ q, label: q.slice(0, 44) });
  writeList(SAVED_KEY, list);
  renderPanels();
});
$('#clear-saved').addEventListener('click', () => { writeList(SAVED_KEY, []); renderPanels(); });

/* ---------------------------------------------------------------- dashboard */

/**
 * The market view.
 *
 * Scoped to a make and model rather than the whole index on purpose: a
 * depreciation curve fitted across every car ever listed describes nothing. It
 * seeds itself from whatever the user last searched, so arriving here after a
 * search shows the market for that car rather than an empty form.
 */
async function runDashboard() {
  const scope = {
    make: $('#d-make').value.trim(),
    model: $('#d-model').value.trim(),
    yearMin: $('#d-yearMin').value.trim(),
    yearMax: $('#d-yearMax').value.trim(),
    mileage: $('#d-mileage').value.trim(),
  };
  const report = await loadDashboard(scope);
  // A null report means a newer load superseded this one; leave the page to it.
  if (report) renderValuation(scope, report);
}

/**
 * A price for one specific car, and what holding it is likely to cost.
 *
 * Rendered only when the fit supports it. `confidence: 'none'` means the asked
 * mileage sits far outside the range the curve was fitted over, and the answer
 * there is to say so, not to extrapolate a number a buyer might act on.
 */
function renderValuation(scope, d) {
  const el = $('#valuation');
  if (!scope.mileage) { el.hidden = true; return; }
  {
    if (!d.valuation) {
      el.hidden = false;
      el.innerHTML = `<div class="val-empty">No completed sale for this model carries a mileage, so there is
        nothing to fit a value against. This is left blank rather than estimated.</div>`;
      return;
    }
    const v = d.valuation;
    const o = d.ownership;
    el.hidden = false;
    el.innerHTML = `
      <div class="val-head">
        <div>
          <div class="val-k">A ${num(Number(scope.mileage))}-mile example is worth about</div>
          <div class="val-v ${v.confidence}">${money(v.price)}</div>
          <div class="val-n">${esc(v.basis)}</div>
        </div>
        <span class="conf ${v.confidence}">${
          v.confidence === 'good' ? 'well supported'
          : v.confidence === 'weak' ? 'thin evidence'
          : 'outside the data'}</span>
      </div>
      ${v.extrapolatedBy > 0
        ? `<p class="val-warn">That mileage is ${num(v.extrapolatedBy)} miles outside the range these sales cover.
           The curve is being extended past its evidence, so treat the figure as a shape, not a price.</p>` : ''}
      ${o ? `<div class="val-forecast">
        <div class="val-k">Depreciation from here, at ${num(o.milesPerYear)} miles a year</div>
        <div class="forecast-row">${o.years.map((y) => `<div class="fy">
          <span class="fy-y">year ${y.year}</span>
          <span class="fy-v">${money(y.value)}</span>
          <span class="fy-d">-${money(y.lostThisYear)}</span>
        </div>`).join('')}</div>
        <p class="hint">${esc(o.basis)}</p>
      </div>` : ''}`;
  }
}

$('#dash-form').addEventListener('submit', (e) => { e.preventDefault(); runDashboard(); });
window.addEventListener('carsearch:redraw', () => runDashboard());

/**
 * Card actions are delegated from the list rather than bound per card.
 *
 * Cards are re-rendered on every sort, filter and view change, and binding
 * handlers to each one leaks them on every repaint.
 */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  e.preventDefault();
  const { act, id } = btn.dataset;
  if (act === 'save') {
    toggleSaved(id);
    paintList();
  } else if (act === 'compare') {
    if (!toggleCompare(id)) {
      btn.classList.add('shake');
      setTimeout(() => btn.classList.remove('shake'), 400);
      return;
    }
    paintList();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    ($('#view-home').hidden ? $('#q') : $('#hero-q')).focus();
  }
});

renderPanels();
loadSourceChips();
loadVocabulary();
loadHero();
show(routeFromHash());

/* --------------------------------------------------------- command palette */

/**
 * Cmd-K, borrowed from Linear and every tool that respects its power users.
 *
 * A car search has a long tail of intents that a form cannot hold: switch the
 * ranking, flip the layout, jump to the market data for whatever you are
 * looking at, reopen a saved car. Putting them behind one keystroke costs a
 * beginner nothing, because the search box still does everything, and saves
 * everyone else the round trip through the sidebar.
 */
function paletteCommands() {
  const make = $('#f-make')?.value.trim();
  const model = $('#f-model')?.value.trim();
  const scope = [make, model].filter(Boolean).join(' ');

  const commands = [
    ...SORT_OPTIONS.map((o) => ({
      label: `Rank by ${o.label.toLowerCase()}`,
      hint: 'ranking',
      run: () => { $('#f-sort').value = o.value; runSearch($('#q').value.trim() || ''); },
    })),
    { label: 'Photo grid', hint: 'layout', run: () => { view = 'grid'; writePref('carsearch:view', view); paintList(); } },
    { label: 'Dense list', hint: 'layout', run: () => { view = 'list'; writePref('carsearch:view', view); paintList(); } },
    {
      label: scope ? `Market data for ${scope}` : 'Market data',
      hint: 'go',
      run: () => {
        if (make) $('#d-make').value = make;
        if (model) $('#d-model').value = model;
        location.hash = '#/dashboard';
      },
    },
    { label: 'Auctions and completed sales', hint: 'go', run: () => { location.hash = '#/auctions'; } },
    { label: 'Sources', hint: 'go', run: () => { location.hash = '#/sources'; } },
    { label: 'Clear every filter', hint: 'action', run: () => $('#reset').click() },
  ];

  if (compare.size >= 2) commands.unshift({ label: `Compare the ${compare.size} cars you picked`, hint: 'action', run: openCompare });
  for (const c of savedCars.slice(0, 8)) {
    commands.push({ label: c.title || 'Saved car', hint: 'saved', run: () => c.url && window.open(c.url, '_blank', 'noopener') });
  }
  for (const ex of EXAMPLES) {
    commands.push({ label: ex, hint: 'search', run: () => { $('#q').value = ex; runSearch(ex); } });
  }
  return commands;
}

let paletteIndex = 0;
let paletteMatches = [];

function openPalette() {
  const el = $('#palette');
  el.hidden = false;
  el.innerHTML = `<div class="pal-sheet" role="dialog" aria-modal="true" aria-label="Commands">
    <input id="pal-input" type="text" placeholder="Rank by, jump to, search…" autocomplete="off" aria-label="Command">
    <ul id="pal-list" role="listbox"></ul>
    <footer><kbd>↑</kbd><kbd>↓</kbd> to move <kbd>enter</kbd> to run <kbd>esc</kbd> to close</footer>
  </div>`;

  const input = $('#pal-input');
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    paletteMatches = paletteCommands().filter((c) => !q || c.label.toLowerCase().includes(q)).slice(0, 9);
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteMatches.length - 1));
    $('#pal-list').innerHTML = paletteMatches.length
      ? paletteMatches.map((c, i) => `<li role="option" aria-selected="${i === paletteIndex}"
          class="${i === paletteIndex ? 'on' : ''}" data-i="${i}">${esc(c.label)}<span class="pal-hint">${esc(c.hint)}</span></li>`).join('')
      : `<li class="pal-none">Nothing matches. Press escape and type it in the search box instead.</li>`;
  };
  paint();

  input.addEventListener('input', () => { paletteIndex = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteIndex = (paletteIndex + 1) % Math.max(1, paletteMatches.length); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = (paletteIndex - 1 + paletteMatches.length) % Math.max(1, paletteMatches.length); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteIndex); }
    else if (e.key === 'Escape') closePalette();
  });
  $('#pal-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) runPalette(Number(li.dataset.i));
  });
  el.addEventListener('click', (e) => { if (e.target === el) closePalette(); });
  input.focus();
}

function runPalette(i) {
  const cmd = paletteMatches[i];
  closePalette();
  cmd?.run();
}

function closePalette() {
  $('#palette').hidden = true;
  paletteIndex = 0;
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#palette').hidden ? openPalette() : closePalette();
  }
});
