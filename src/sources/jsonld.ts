/**
 * Reading schema.org markup out of a page.
 *
 * Shared because it is the cheapest durable way to add a source. A site's
 * JSON-LD is published for search engines, which means the site has a reason to
 * keep it stable and correct, and an adapter built on it survives the redesigns
 * that break every CSS selector. Whenever a source ships it, prefer it.
 */

export interface JsonLdNode {
  '@type'?: string | string[];
  [key: string]: unknown;
}

const BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Every JSON-LD node on the page, flattened through @graph and arrays. */
export function extractJsonLd(html: string): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const push = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) push(v);
      return;
    }
    const node = value as JsonLdNode;
    out.push(node);
    if (node['@graph']) push(node['@graph']);
  };

  for (const match of html.matchAll(BLOCK)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      push(JSON.parse(raw));
    } catch {
      /**
       * A malformed block is skipped rather than failing the page. Sites embed
       * several, and one broken block must not cost the others; the caller sees
       * the shortfall as fewer listings, which the run summary already reports.
       */
    }
  }
  return out;
}

function typeOf(node: JsonLdNode): string[] {
  const t = node['@type'];
  return Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
}

export function nodesOfType(nodes: JsonLdNode[], ...types: string[]): JsonLdNode[] {
  const want = new Set(types.map((t) => t.toLowerCase()));
  return nodes.filter((n) => typeOf(n).some((t) => want.has(t.toLowerCase())));
}

/** The items of every ItemList on the page, unwrapped from their ListItem shells. */
export function itemListEntries(nodes: JsonLdNode[]): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  for (const list of nodesOfType(nodes, 'ItemList')) {
    const elements = list.itemListElement;
    if (!Array.isArray(elements)) continue;
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      const node = el as JsonLdNode;
      // A ListItem wraps the thing; some sites skip the wrapper entirely.
      out.push((node.item as JsonLdNode) ?? node);
    }
  }
  return out;
}

/** schema.org lets a value be a scalar, an array, or an object with @value. */
export function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return scalar(value[0]);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return scalar(o['@value'] ?? o.name ?? o.value);
  }
  return null;
}

export function num(value: unknown): number | null {
  const s = scalar(value);
  if (s === null) return null;
  const n = Number(String(s).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The price out of an Offer, an AggregateOffer, or a bare price field. */
export function offerPrice(node: JsonLdNode): number | null {
  const offers = node.offers ?? node.offer;
  if (offers) {
    const first = Array.isArray(offers) ? offers[0] : offers;
    const o = first as JsonLdNode | undefined;
    const p = num(o?.price ?? o?.lowPrice ?? o?.highPrice);
    if (p !== null) return p;
  }
  return num(node.price);
}

/** "Gardnerville, NV" out of a PostalAddress wherever it is nested. */
export function offerLocation(node: JsonLdNode): string | null {
  const offers = node.offers ?? node.offer;
  const first = (Array.isArray(offers) ? offers[0] : offers) as JsonLdNode | undefined;
  const place = (first?.availableAtOrFrom ?? first?.areaServed ?? node.location) as JsonLdNode | undefined;
  const address = (place?.address ?? node.address) as JsonLdNode | undefined;
  if (!address) return null;
  const city = scalar(address.addressLocality);
  const region = scalar(address.addressRegion);
  return [city, region].filter(Boolean).join(', ') || null;
}

export function firstImage(node: JsonLdNode): string | null {
  const image = node.image;
  if (Array.isArray(image)) return scalar(image[0]);
  return scalar(image);
}

/** Mileage from a Vehicle's mileageFromOdometer, which is a QuantitativeValue. */
export function odometer(node: JsonLdNode): number | null {
  const m = node.mileageFromOdometer ?? node.vehicleMileage;
  if (!m) return null;
  if (typeof m === 'object' && !Array.isArray(m)) return num((m as JsonLdNode).value ?? m);
  return num(m);
}
