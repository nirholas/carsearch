/**
 * The refine panel, generated from what the index actually knows.
 *
 * Every control here is built from `/api/facets`, never from a hardcoded list,
 * and every one shows its coverage: "412 of 2,259 state it". That number is the
 * whole point. Facet search on sparse data has one failure mode, and it is
 * silent: filtering on an attribute that most listings never publish looks like
 * a narrowing and is actually a deletion of every source that does not report
 * it. A control that admits nothing carries the data is honest; one that
 * quietly returns an empty page is not.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = (n) => Number(n).toLocaleString('en-US');

/** Facets rendered by the main form already, so the panel does not repeat them. */
const HANDLED_ELSEWHERE = new Set(['make', 'model', 'year', 'price', 'mileage']);

const state = { facets: [], groups: {}, vocabularies: {}, values: {} };

export function currentFacetParams() {
  const out = {};
  for (const [key, v] of Object.entries(state.values)) {
    if (v.in?.length) out[key] = v.in.join(',');
    if (v.min !== undefined && v.min !== '') out[`${key}.min`] = v.min;
    if (v.max !== undefined && v.max !== '') out[`${key}.max`] = v.max;
    if (v.is !== undefined) out[key] = String(v.is);
    if (v.includeUnknown !== undefined) out[`${key}.unknown`] = v.includeUnknown ? '1' : '0';
  }
  return out;
}

export function activeFacetCount() {
  return Object.values(state.values).filter(
    (v) => v.in?.length || v.min !== undefined || v.max !== undefined || v.is !== undefined,
  ).length;
}

export function clearFacets() {
  state.values = {};
}

function coverageLabel(f) {
  if (f.total === 0) return '';
  if (f.known === 0) return `<span class="cov none">nothing in the index states this yet</span>`;
  const pct = Math.round((f.known / f.total) * 100);
  const cls = pct >= 60 ? 'high' : pct >= 20 ? 'mid' : 'low';
  return `<span class="cov ${cls}">${num(f.known)} of ${num(f.total)} state it (${pct}%)</span>`;
}

function control(f) {
  const v = state.values[f.key] ?? {};
  const disabled = f.known === 0 ? ' disabled' : '';

  if (f.kind === 'boolean') {
    return `<label class="check">
      <input type="checkbox" data-facet="${esc(f.key)}" data-kind="boolean"${v.is ? ' checked' : ''}${disabled}>
      ${esc(f.label)}
    </label>`;
  }

  if (f.kind === 'number') {
    const range = f.min !== undefined && f.min !== null ? `${num(f.min)} to ${num(f.max)}${f.unit ? ' ' + esc(f.unit) : ''}` : '';
    return `<div class="facet-num">
      <span class="facet-label">${esc(f.label)}${range ? ` <em>${range}</em>` : ''}</span>
      <div class="row">
        <input type="number" inputmode="numeric" placeholder="min" aria-label="${esc(f.label)} minimum"
               data-facet="${esc(f.key)}" data-kind="min" value="${v.min ?? ''}"${disabled}>
        <input type="number" inputmode="numeric" placeholder="max" aria-label="${esc(f.label)} maximum"
               data-facet="${esc(f.key)}" data-kind="max" value="${v.max ?? ''}"${disabled}>
      </div>
    </div>`;
  }

  /**
   * Enum and text facets offer the canonical vocabulary even where coverage is
   * zero, with the observed counts merged in. Offering only the observed values
   * would hide the fact that "salvage" is a thing you can ask for at all.
   */
  const observed = new Map((f.values ?? []).map((x) => [String(x.value).toLowerCase(), x.n]));
  const canonical = state.vocabularies[f.key] ?? [];
  const options = canonical.length
    ? canonical.map((value) => ({ value, n: observed.get(String(value).toLowerCase()) ?? 0 }))
    : (f.values ?? []).map((x) => ({ value: x.value, n: x.n }));

  if (options.length === 0) {
    return `<div class="facet-num"><span class="facet-label">${esc(f.label)}</span>
      <p class="hint">No values in the index yet.</p></div>`;
  }

  const selected = new Set((v.in ?? []).map((x) => x.toLowerCase()));
  return `<div class="facet-enum">
    <span class="facet-label">${esc(f.label)}</span>
    <div class="chips">${options.map((o) => `
      <button type="button" class="fchip${selected.has(String(o.value).toLowerCase()) ? ' on' : ''}${o.n === 0 ? ' empty' : ''}"
              data-facet="${esc(f.key)}" data-kind="enum" data-value="${esc(o.value)}"
              ${o.n === 0 ? 'title="no listing in the index carries this value yet"' : ''}>
        ${esc(o.value)} <span class="n">${num(o.n)}</span>
      </button>`).join('')}</div>
  </div>`;
}

function unknownToggle(f) {
  if (!f.strict) return '';
  const v = state.values[f.key] ?? {};
  const on = v.includeUnknown === true;
  return `<label class="check subtle">
    <input type="checkbox" data-facet="${esc(f.key)}" data-kind="unknown"${on ? ' checked' : ''}>
    Also include listings that never state it
  </label>`;
}

export function renderFacets(container, onChange) {
  const byGroup = new Map();
  for (const f of state.facets) {
    if (HANDLED_ELSEWHERE.has(f.key)) continue;
    if (!byGroup.has(f.group)) byGroup.set(f.group, []);
    byGroup.get(f.group).push(f);
  }

  container.innerHTML = [...byGroup.entries()].map(([group, facets]) => {
    const anyData = facets.some((f) => f.known > 0);
    return `<details class="facet-group"${anyData ? ' open' : ''}>
      <summary>${esc(state.groups[group] ?? group)}<span class="n">${facets.filter((f) => f.known > 0).length}/${facets.length}</span></summary>
      <div class="facet-body">
        ${facets.map((f) => `<div class="facet${f.known === 0 ? ' unpopulated' : ''}">
          ${control(f)}
          ${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ''}
          ${coverageLabel(f)}
          ${unknownToggle(f)}
        </div>`).join('')}
      </div>
    </details>`;
  }).join('');

  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.fchip');
    if (!chip) return;
    const key = chip.dataset.facet;
    const value = chip.dataset.value;
    const v = (state.values[key] ??= {});
    v.in ??= [];
    const i = v.in.findIndex((x) => x.toLowerCase() === value.toLowerCase());
    if (i >= 0) v.in.splice(i, 1);
    else v.in.push(value);
    if (v.in.length === 0) delete v.in;
    chip.classList.toggle('on');
    onChange();
  });

  container.addEventListener('change', (e) => {
    const el = e.target;
    const key = el.dataset?.facet;
    if (!key) return;
    const v = (state.values[key] ??= {});
    if (el.dataset.kind === 'boolean') {
      if (el.checked) v.is = true; else delete v.is;
    } else if (el.dataset.kind === 'unknown') {
      if (el.checked) v.includeUnknown = true; else delete v.includeUnknown;
    } else if (el.dataset.kind === 'min' || el.dataset.kind === 'max') {
      if (el.value === '') delete v[el.dataset.kind];
      else v[el.dataset.kind] = Number(el.value);
    }
    onChange();
  });
}

export async function loadFacets(container, scope, onChange) {
  const params = new URLSearchParams();
  if (scope?.make) params.set('make', scope.make);
  if (scope?.model) params.set('model', scope.model);
  /**
   * Coverage must be counted over the same rows the search will return.
   *
   * Without the price kinds, the salvage chip read "19" and clicking it
   * returned nothing: those nineteen are auction lots carrying a bid, and the
   * search defaults to asking prices. A count that a click cannot reproduce is
   * worse than no count, because it reads as a broken filter.
   */
  if (scope?.priceKinds) params.set('priceKinds', scope.priceKinds);
  container.innerHTML = '<div class="skeleton sm"></div><div class="skeleton sm"></div>';
  try {
    const d = await (await fetch('/api/facets?' + params)).json();
    state.facets = d.facets ?? [];
    state.groups = d.groups ?? {};
    state.vocabularies = d.vocabularies ?? {};
    renderFacets(container, onChange);
  } catch (e) {
    container.innerHTML = `<p class="hint">Could not load the attribute list: ${esc(e.message)}</p>`;
  }
}
