/**
 * Prints every make the normalizer recognises, one per line.
 *
 * The crawl needs this list and `data/` is gitignored, so deriving it here beats
 * committing a copy that would rot the moment a marque is added to MAKES.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/core/normalize.ts', import.meta.url), 'utf8');
const start = src.indexOf('const MAKES = [');
if (start < 0) throw new Error('MAKES table not found in normalize.ts');
const body = src.slice(start, src.indexOf('];', start));
const makes = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (makes.length < 50) throw new Error(`only ${makes.length} makes parsed, the table shape probably changed`);
console.log(makes.join('\n'));
