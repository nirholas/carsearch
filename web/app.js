/**
 * carsearch UI.
 *
 * Two ideas drive the layout. First, one car shown once: the same vehicle is
 * listed on several sites at once, so results arrive grouped and carry a badge
 * for every site they appear on rather than being repeated. Second, asking
 * prices are not the market: the strip above the results shows what comparable
 * cars actually sold for, and the gap between that and what sellers are asking.
 */

const $ = (sel) => document.querySelector(sel);
const money = (n) => (n === null || n === undefined ? '-' : '$' + Number(n).toLocaleString('en-US'));
const num = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));

const FILTER_IDS = ['make', 'model', 'yearMin', 'yearMax', 'priceMin', 'priceMax', 'mileageMax', 'sort'];

function readFilters() {
  const f = {};
  for (const id of FILTER_IDS) {
    const v = $('#f-' + id)?.value.trim();
    if (v) f[id] = v;
  }
  const kinds = [];
  if ($('#k-ask').checked) kinds.push('ask');
  if ($('#k-sold').checked) kinds.push('sold');
  if ($('#k-bid').checked) kinds.push('bid');
  f.priceKinds = kinds.join(',') || 'ask';
  const q = $('#q').value.trim();
  if (q) f.q = q;
  f.limit = 200;
  return f;
}

/**
 * Parses the kind of thing people actually type into a search box.
 *
 * This is deliberately small and local. It handles the obvious shapes so the
 * box is useful immediately; anything it cannot parse is passed through as a
 * text match rather than silently dropped.
 */
function parseFreeText(text) {
  const out = {};
  const t = text.toLowerCase();
  const under = t.match(/under\s+\$?(\d+)\s*k?/);
  if (under) out.priceMax = under[1].length <= 3 ? Number(under[1]) * 1000 : Number(under[1]);
  const year = t.match(/\b(19|20)\d{2}\b/);
  if (year) out.yearMin = Number(year[0]);
  const miles = t.match(/under\s+(\d+)\s*k?\s*(?:miles|mi)\b/);
  if (miles) out.mileageMax = Number(miles[1]) * (miles[1].length <= 3 ? 1000 : 1);
  return out;
}

function badge(text, cls = '') {
  return `<span class="badge ${cls}">${text}</span>`;
}

function card(r) {
  const kindClass = r.priceKind === 'sold' ? 'sold' : r.priceKind === 'bid' ? 'bid' : '';
  const kindLabel = r.priceKind === 'sold' ? 'SOLD' : r.priceKind === 'bid' ? 'CURRENT BID' : '';
  const history = r.priceHistory ?? [];
  const dropped = history.length > 1 && history[history.length - 1].price < history[0].price;
  const dropAmount = dropped ? history[0].price - history[history.length - 1].price : 0;

  const badges = [
    badge(r.sourceId, 'src'),
    ...(r.alsoOn ?? []).map((s) => badge(s, 'src')),
    r.priceKind === 'sold' ? badge('completed sale', 'sold') : '',
    r.priceKind === 'bid' ? badge('bid, not an asking price', 'bid') : '',
    dropped ? badge(`price dropped ${money(dropAmount)}`, 'drop') : '',
    r.daysOnMarket !== null && r.daysOnMarket > 0 ? badge(`${r.daysOnMarket}d on market`) : '',
    r.mileageIsRounded ? badge('mileage is rounded by the site', 'rounded') : '',
    r.series ? badge(r.series) : '',
    r.vin ? badge('VIN matched') : '',
  ].filter(Boolean).join('');

  const img = r.imageUrl
    ? `<img src="${r.imageUrl}" alt="" loading="lazy">`
    : `<div class="noimg">no photo</div>`;
  const title = r.url ? `<a href="${r.url}" target="_blank" rel="noopener">${r.title || 'Untitled listing'}</a>` : (r.title || 'Untitled listing');

  return `<article class="card">
    ${img}
    <div>
      <h3>${title}</h3>
      <div class="meta">
        <span>${num(r.mileage)} mi</span>
        ${r.trim ? `<span>${r.trim}</span>` : ''}
        ${r.location ? `<span>${r.location}</span>` : ''}
        ${r.eventDate ? `<span>${r.eventDate}</span>` : ''}
      </div>
      <div class="badges">${badges}</div>
    </div>
    <div class="price">
      <div class="amount ${kindClass}">${money(r.price)}</div>
      ${kindLabel ? `<div class="n" style="font-size:10.5px;color:var(--muted)">${kindLabel}</div>` : ''}
    </div>
  </article>`;
}

function stat(k, v, n, cls = '') {
  return `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="n">${n ?? ''}</div></div>`;
}

async function loadComps(make, model, yearMin, yearMax) {
  const strip = $('#comps-strip');
  if (!make || !model) { strip.hidden = true; return; }
  const p = new URLSearchParams({ make, model });
  if (yearMin) p.set('yearMin', yearMin);
  if (yearMax) p.set('yearMax', yearMax);
  try {
    const c = await (await fetch('/api/comps?' + p)).json();
    if (!c || c.sold?.count === 0) {
      strip.hidden = false;
      strip.innerHTML = stat('Completed sales', '-', 'No sold records indexed yet for this vehicle. Crawl an auction source to populate it.');
      return;
    }
    strip.hidden = false;
    strip.innerHTML = [
      stat('Median asking price', money(c.asking.median), `${c.asking.count} listings`),
      stat('Median sold price', money(c.sold.median), `${c.sold.count} completed sales`, 'sold'),
      stat('Sellers ask above market', c.spread === null ? '-' : money(c.spread), 'the number no other site shows', 'spread'),
      stat('Sold range', `${money(c.sold.low)} to ${money(c.sold.high)}`, 'actual transactions'),
    ].join('');
  } catch {
    strip.hidden = true;
  }
}

async function search() {
  const list = $('#list');
  list.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
  $('#summary').hidden = true;

  const f = readFilters();
  if (f.q) Object.assign(f, { ...parseFreeText(f.q), ...f.priceMax ? {} : {} });
  const parsed = f.q ? parseFreeText(f.q) : {};
  for (const [k, v] of Object.entries(parsed)) if (!f[k]) f[k] = v;

  try {
    const res = await fetch('/api/search?' + new URLSearchParams(f));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const s = data.stats;
    $('#summary').hidden = false;
    $('#summary').innerHTML =
      `<strong>${s.uniqueVehicles}</strong> unique vehicles from <strong>${s.rawListings}</strong> listings. ` +
      `${s.duplicatesRemoved} duplicates collapsed, ${s.crossSourceGroups} of them listed on more than one site.`;

    if (data.results.length === 0) {
      list.innerHTML = `<div class="state">
        <h3>Nothing indexed for that search yet</h3>
        <p>The index only holds what has been crawled. Populate it with:</p>
        <p><code>npx tsx src/cli.ts search --make porsche --model macan --max-price 40000</code></p>
      </div>`;
      $('#comps-strip').hidden = true;
      return;
    }

    list.innerHTML = data.results.map(card).join('');
    loadComps(f.make || data.results[0]?.make, f.model || data.results[0]?.model, f.yearMin, f.yearMax);
  } catch (e) {
    list.innerHTML = `<div class="state">
      <h3>Could not reach the API</h3>
      <p>${e.message}</p>
      <p>Start it with <code>npm run serve</code>.</p>
    </div>`;
  }
}

async function showSources() {
  const el = $('#sources-view');
  el.innerHTML = '<div class="skeleton"></div>';
  const d = await (await fetch('/api/sources')).json();
  const st = d.stats;
  const rows = d.sources.map((s) => `<tr>
      <td>${s.id}</td><td>${s.name}</td><td>${s.status}</td><td>${s.transport}</td>
      <td>${s.category}</td><td>${s.countries.join(', ')}</td>
      <td>${d.wired.includes(s.id) ? 'yes' : ''}</td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="comps-strip" style="margin-bottom:16px">
      ${stat('Sources tracked', st.total, `${st.countries.length} countries`)}
      ${stat('Adapters wired', d.wired.length, d.wired.join(', '))}
      ${stat('Reachable', (st.byStatus.live ?? 0) + (st.byStatus.planned ?? 0), 'live or verified reachable')}
      ${stat('Blocked', st.byStatus.blocked ?? 0, 'recorded so nobody retests blindly')}
    </div>
    <div class="scroll"><table>
      <thead><tr><th>id</th><th>name</th><th>status</th><th>transport</th><th>category</th><th>countries</th><th>wired</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

async function showComps() {
  const el = $('#comps-detail');
  const make = $('#f-make').value.trim();
  const model = $('#f-model').value.trim();
  if (!make || !model) {
    el.innerHTML = `<div class="state"><h3>Pick a make and model</h3><p>Sold prices are per vehicle. Set a make and model in the filters, then come back.</p></div>`;
    return;
  }
  el.innerHTML = '<div class="skeleton"></div>';
  const c = await (await fetch(`/api/comps?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}`)).json();
  if (!c.sold.count) {
    el.innerHTML = `<div class="state"><h3>No completed sales indexed</h3>
      <p>Run a crawl that includes an auction source:</p>
      <p><code>npx tsx src/cli.ts search --make ${make} --model ${model} --sources bringatrailer,carsandbids</code></p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="comps-strip">
      ${stat('Median sold', money(c.sold.median), `${c.sold.count} sales`, 'sold')}
      ${stat('Median ask', money(c.asking.median), `${c.asking.count} listings`)}
      ${stat('Spread', money(c.spread), 'asking above market', 'spread')}
      ${stat('Range', `${money(c.sold.low)} to ${money(c.sold.high)}`, 'actual transactions')}
    </div>
    <div class="scroll"><table>
      <thead><tr><th>sold for</th><th>date</th><th>year</th><th>vehicle</th><th>source</th></tr></thead>
      <tbody>${c.sold.sales.map((s) => `<tr>
        <td><strong>${money(s.price)}</strong></td><td>${s.event_date ?? ''}</td><td>${s.year ?? ''}</td>
        <td>${s.url ? `<a href="${s.url}" target="_blank" rel="noopener">${s.title}</a>` : s.title}</td>
        <td>${s.source_id}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

function switchTab(name) {
  for (const a of document.querySelectorAll('.topnav a')) a.classList.toggle('active', a.dataset.tab === name);
  $('#panel-listings').hidden = name !== 'listings';
  $('#panel-comps').hidden = name !== 'comps';
  $('#panel-sources').hidden = name !== 'sources';
  if (name === 'sources') showSources();
  if (name === 'comps') showComps();
}

document.querySelectorAll('.topnav a').forEach((a) =>
  a.addEventListener('click', (e) => { e.preventDefault(); switchTab(a.dataset.tab); }),
);
$('#search').addEventListener('submit', (e) => { e.preventDefault(); switchTab('listings'); search(); });
$('#apply').addEventListener('click', () => { switchTab('listings'); search(); });
$('#reset').addEventListener('click', () => {
  for (const id of FILTER_IDS) { const el = $('#f-' + id); if (el) el.value = ''; }
  $('#q').value = '';
  search();
});
// A search box you can reach without touching the mouse.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
});

search();
