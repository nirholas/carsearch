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
   * Layer 1 means nothing in the whole result set beats this car on every
   * ranked dimension at once. That is a stronger, weighting-free claim than any
   * score, so it gets the badge.
   */
  if (rank.paretoLayer === 1) {
    parts.push(`<span class="frontier" title="Nothing in these results beats it on every thing you ranked by">BEST OF BOTH</span>`);
  }
  for (const reason of rank.reasons ?? []) {
    if (reason.position === null) continue;
    parts.push(`<span class="rank-reason">#${reason.position} ${esc(reason.label)} <span class="of">of ${reason.outOf}</span></span>`);
  }
  for (const key of rank.unknown ?? []) {
    parts.push(`<span class="rank-reason unknown" title="Ranked last on this because the listing never states it">no ${esc(key)} stated</span>`);
  }
  return parts.length ? `<div class="rankline">${parts.join('')}</div>` : '';
}

function card(r) {
  const kindClass = r.priceKind === 'sold' ? 'sold' : r.priceKind === 'bid' ? 'bid' : '';
  const kindLabel = r.priceKind === 'sold' ? 'sold' : r.priceKind === 'bid' ? 'current bid' : '';
  const history = r.priceHistory ?? [];
  const dropped = history.length > 1 && history[history.length - 1].price < history[0].price;
  const drop = dropped ? history[0].price - history[history.length - 1].price : 0;

  const badges = [
    badge(r.sourceId, 'src'),
    ...(r.alsoOn ?? []).map((s) => badge(s, 'src')),
    r.priceKind === 'sold' ? badge('completed sale', 'sold') : '',
    r.priceKind === 'bid' ? badge('bid, not an asking price', 'sold') : '',
    dropped ? badge(`price dropped ${money(drop)}`, 'drop') : '',
    r.daysOnMarket > 0 ? badge(`${r.daysOnMarket}d on market`) : '',
    r.mileageIsRounded ? badge('mileage rounded by the site', 'rounded') : '',
    r.series ? badge(r.series) : '',
    r.vin ? badge('VIN matched') : '',
  ].filter(Boolean).join('');

  const img = r.imageUrl
    ? `<img class="thumb" src="${esc(r.imageUrl)}" alt="" loading="lazy">`
    : `<div class="noimg">no photo</div>`;
  const title = r.url
    ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || 'Untitled listing')}</a>`
    : esc(r.title || 'Untitled listing');

  return `<article class="card">
    ${img}
    <div>
      <h3>${title}</h3>
      <div class="meta">
        <span>${num(r.mileage)} mi</span>
        ${r.trim ? `<span>${esc(r.trim)}</span>` : ''}
        ${r.location ? `<span>${esc(r.location)}</span>` : ''}
        ${r.eventDate ? `<span>${esc(r.eventDate)}</span>` : ''}
      </div>
      <div class="badges">${badges}</div>
      ${rankBadges(r)}
    </div>
    <div class="price">
      <div class="amount ${kindClass}">${money(r.price)}</div>
      ${kindLabel ? `<div class="kind">${kindLabel}</div>` : ''}
      ${dealBadge(r.deal)}
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
  $('#list').innerHTML = rows.length
    ? rows.map(card).join('')
    : `<div class="state"><h3>No results from ${esc(activeSource)}</h3><p>Pick another source tab.</p></div>`;
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
  $('#list').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
  $('#summary').hidden = true;
  $('#understood').hidden = true;
  $('#source-tabs').hidden = true;

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
