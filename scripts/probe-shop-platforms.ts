import { fetchWithTls } from '../src/transport/tls.js';
import { extractJsonLd, vehicleNodes, offerPrice, scalar } from '../src/sources/jsonld.js';

/**
 * Identifies which storefront platform a specialist seller runs, and whether
 * its catalogue is readable without a parser.
 *
 * Specialist importers are where most kei trucks are actually sold, and they
 * are small shops on commodity platforms rather than dealer software. That is
 * good news: Shopify publishes every store's catalogue at /products.json and
 * WooCommerce at /wp-json/wc/store/v1/products, so one adapter per platform
 * covers every shop on it. This reports which door is open.
 */

const hosts = process.argv.slice(2);
const keepAlive = setInterval(() => {}, 1000);

async function tryJson(url: string): Promise<{ status: number; count: number; sample: string } | null> {
  try {
    const r = await fetchWithTls(url);
    if (r.status !== 200) return { status: r.status, count: 0, sample: '' };
    const j = JSON.parse(r.body ?? 'null');
    const list = Array.isArray(j) ? j : Array.isArray(j?.products) ? j.products : [];
    const first = list[0] ?? {};
    return { status: 200, count: list.length, sample: String(first.title ?? first.name ?? '').slice(0, 50) };
  } catch {
    return null;
  }
}

for (const raw of hosts) {
  const host = raw.replace(/\/$/, '');
  const parts: string[] = [];
  try {
    const home = await fetchWithTls(host);
    const body = home.body ?? '';
    const platform = /cdn\.shopify\.com|Shopify\.theme/i.test(body) ? 'Shopify'
      : /wp-content|woocommerce/i.test(body) ? (/woocommerce/i.test(body) ? 'WooCommerce' : 'WordPress')
      : /wix\.com|wixstatic/i.test(body) ? 'Wix'
      : /squarespace/i.test(body) ? 'Squarespace'
      : /dealercenter|dealerspike|dealerfire|carsforsale\.com|frazer|autorevo|dealer\.com/i.test(body) ? 'dealer software'
      : 'unknown';
    parts.push(`HTTP ${home.status}`, platform);
    const priced = vehicleNodes(extractJsonLd(body)).filter((n) => offerPrice(n) !== null && scalar(n.name)).length;
    if (priced) parts.push(`json-ld cars on home: ${priced}`);
  } catch (e) {
    parts.push(`ERR ${(e as Error).message.slice(0, 30)}`);
  }
  const shop = await tryJson(`${host}/products.json?limit=250`);
  if (shop && shop.count) parts.push(`products.json: ${shop.count} (e.g. ${shop.sample})`);
  const woo = await tryJson(`${host}/wp-json/wc/store/v1/products?per_page=100`);
  if (woo && woo.count) parts.push(`woo store api: ${woo.count} (e.g. ${woo.sample})`);
  console.log(`${host.padEnd(38)} ${parts.join(' | ')}`);
}
clearInterval(keepAlive);
