import type { SourceAdapter } from '../core/types.js';
import { autotempest } from './autotempest.js';
import { carmax } from './carmax.js';
import { bringatrailer } from './bringatrailer.js';
import { carsandbids } from './carsandbids.js';
import { craigslist } from './craigslist.js';
import { carvana } from './carvana.js';
import { copart } from './copart.js';
import { dupontregistry } from './dupontregistry.js';
import { hagertymarketplace } from './hagerty.js';
import { pcarmarket } from './pcarmarket.js';
import { autoscout24, finnno, blocket } from './international.js';
import { autotraderca, carandclassic, classiccars, mercadolibreautos, pakwheels } from './marketplaces.js';
/**
 * Written and typed, but deliberately NOT in ADAPTERS: the search endpoint
 * answers 401 to every request shape tried so far, so running it would fail on
 * every crawl and teach nobody anything. See the file header and the registry
 * note for exactly what is known and what the next attempt should try.
 */
import { collectingcars } from './collectingcars.js';
import { tesla } from './tesla.js';
import { carscom } from './carscom.js';
import { cargurus } from './cargurus.js';
import { kbb } from './kbb.js';
import { hemmings } from './hemmings.js';
import { pistonheads, cars24 } from './payload-marketplaces.js';

/**
 * Every adapter with a working implementation.
 *
 * The registry in registry.ts is far larger than this list on purpose: it
 * records what exists and what is reachable, while this file records what is
 * actually wired. A source moves from the registry into here when its extractor
 * has been verified against live markup, never before.
 */
export const ADAPTERS: SourceAdapter[] = [autotempest, carscom, carmax, cargurus, kbb, hemmings, bringatrailer, carsandbids, craigslist, carvana, copart, dupontregistry, hagertymarketplace, pcarmarket, autoscout24, finnno, blocket, autotraderca, carandclassic, classiccars, mercadolibreautos, pakwheels, pistonheads, cars24];

export const adapterById = new Map(ADAPTERS.map((a) => [a.source.id, a]));

export { autotempest, carscom, carmax, cargurus, kbb, bringatrailer, carsandbids, craigslist, carvana, copart, dupontregistry, hagertymarketplace, pcarmarket, autoscout24, finnno, blocket, collectingcars, tesla };
export { autotraderca, carandclassic, classiccars, mercadolibreautos, pakwheels };
export { pistonheads, cars24 };
export { SOURCES, getSource, liveSources, registryStats, sourcesByStatus } from './registry.js';
