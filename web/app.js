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

const VIEWS = { home: '#view-home', results: '#view-results', auctions: '#view-auctions', sources: '#view-sources' };

function show(route) {
  for (const [name, sel] of Object.entries(VIEWS)) $(sel).hidden = name !== route;
  for (const a of document.querySelectorAll('.topnav a')) a.classList.toggle('active', a.dataset.route === route);
  if (route === 'sources') loadSources();
  if (route === 'auctions') loadAuctions();
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
  const f = {};
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
        body: JSON.stringify({ q: question, limit: 300 }),
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
    $('#summary').hidden = false;
    $('#summary').innerHTML =
      `<strong>${s.uniqueVehicles ?? lastResults.length}</strong> unique vehicles from <strong>${s.rawListings ?? lastResults.length}</strong> listings. ` +
      `${s.duplicatesRemoved ?? 0} duplicates collapsed, ${s.crossSourceGroups ?? 0} of them listed on more than one site.`;

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
    loadComps(q.make || lastResults[0]?.make, (q.models && q.models[0]) || q.model || lastResults[0]?.model, q.yearMin, q.yearMax);
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

/* ------------------------------------------------------- saved searches */

const SAVED_KEY = 'carsearch.saved';

function readSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]'); } catch { return []; }
}

function renderSaved() {
  const saved = readSaved();
  $('#saved').innerHTML = saved.length
    ? '<div class="hint" style="margin-bottom:2px">Saved</div>' +
      saved.map((s, i) => `<a href="#" data-i="${i}">${esc(s.label)}</a>`).join('')
    : '';
  for (const a of $('#saved').querySelectorAll('a')) {
    a.addEventListener('click', (e) => { e.preventDefault(); $('#q').value = readSaved()[a.dataset.i].q; runSearch(readSaved()[a.dataset.i].q); });
  }
}

/* --------------------------------------------------------------------- wire */

$('#examples').innerHTML = EXAMPLES.map((e) => `<button class="example" type="button">${esc(e)}</button>`).join('');
for (const b of $('#examples').querySelectorAll('.example')) {
  b.addEventListener('click', () => { $('#q').value = b.textContent; runSearch(b.textContent); });
}
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
  $('#q').value = '';
  runSearch('');
});
$('#save-search').addEventListener('click', () => {
  const q = $('#q').value.trim();
  if (!q) return;
  const saved = readSaved();
  if (!saved.some((s) => s.q === q)) saved.unshift({ q, label: q.slice(0, 40) });
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved.slice(0, 12))); } catch { /* private mode */ }
  renderSaved();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#q') && document.activeElement !== $('#hero-q')) {
    e.preventDefault();
    ($('#view-home').hidden ? $('#q') : $('#hero-q')).focus();
  }
});

renderSaved();
loadSourceChips();
show(routeFromHash());
