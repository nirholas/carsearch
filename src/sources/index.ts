import type { SourceAdapter } from '../core/types.js';
import { autotempest } from './autotempest.js';
import { carmax } from './carmax.js';
import { bringatrailer } from './bringatrailer.js';
import { carsandbids } from './carsandbids.js';
import { tesla } from './tesla.js';
import { carscom } from './carscom.js';

/**
 * Every adapter with a working implementation.
 *
 * The registry in registry.ts is far larger than this list on purpose: it
 * records what exists and what is reachable, while this file records what is
 * actually wired. A source moves from the registry into here when its extractor
 * has been verified against live markup, never before.
 */
export const ADAPTERS: SourceAdapter[] = [autotempest, carscom, carmax, bringatrailer, carsandbids];

export const adapterById = new Map(ADAPTERS.map((a) => [a.source.id, a]));

export { autotempest, carscom, carmax, bringatrailer, carsandbids, tesla };
export { SOURCES, getSource, liveSources, registryStats, sourcesByStatus } from './registry.js';
