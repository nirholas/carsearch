import { readFileSync, existsSync } from 'node:fs';

/**
 * Vehicle vocabulary for natural-language search.
 *
 * People do not type "Mercedes-Benz G-Class". They type "g wagon". They do not
 * type "Chevrolet Corvette", they type "vette". A search box that only matches
 * catalogue names fails on the way most people actually describe a car, so the
 * nicknames below are treated as first-class input rather than as a nicety.
 *
 * The seed lists here are hand-written because they have to work with no
 * network and no data file. `data/vehicle-vocab.json`, built by the `vocab`
 * command from the free NHTSA vPIC catalogue, supersedes the seed model list
 * when present and covers every make and model the government recognizes.
 */

export interface Vocabulary {
  /** Canonical make names, lowercased for matching. */
  makes: string[];
  /** make (lowercase) -> canonical model names. */
  models: Record<string, string[]>;
}

/** Colloquial name to the make and model it means. Ordered longest-first at match time. */
export const NICKNAMES: Record<string, { make: string; model?: string }> = {
  'g wagon': { make: 'Mercedes-Benz', model: 'G-Class' },
  'g-wagon': { make: 'Mercedes-Benz', model: 'G-Class' },
  gwagon: { make: 'Mercedes-Benz', model: 'G-Class' },
  'g wagen': { make: 'Mercedes-Benz', model: 'G-Class' },
  'g class': { make: 'Mercedes-Benz', model: 'G-Class' },
  vette: { make: 'Chevrolet', model: 'Corvette' },
  corvette: { make: 'Chevrolet', model: 'Corvette' },
  stingray: { make: 'Chevrolet', model: 'Corvette' },
  camaro: { make: 'Chevrolet', model: 'Camaro' },
  bimmer: { make: 'BMW' },
  beemer: { make: 'BMW' },
  benz: { make: 'Mercedes-Benz' },
  merc: { make: 'Mercedes-Benz' },
  amg: { make: 'Mercedes-Benz' },
  'land cruiser': { make: 'Toyota', model: 'Land Cruiser' },
  landcruiser: { make: 'Toyota', model: 'Land Cruiser' },
  '4runner': { make: 'Toyota', model: '4Runner' },
  tacoma: { make: 'Toyota', model: 'Tacoma' },
  tundra: { make: 'Toyota', model: 'Tundra' },
  supra: { make: 'Toyota', model: 'Supra' },
  miata: { make: 'Mazda', model: 'MX-5 Miata' },
  'mx-5': { make: 'Mazda', model: 'MX-5 Miata' },
  wrangler: { make: 'Jeep', model: 'Wrangler' },
  jeep: { make: 'Jeep' },
  bronco: { make: 'Ford', model: 'Bronco' },
  mustang: { make: 'Ford', model: 'Mustang' },
  raptor: { make: 'Ford', model: 'F-150' },
  'f150': { make: 'Ford', model: 'F-150' },
  'f-150': { make: 'Ford', model: 'F-150' },
  civic: { make: 'Honda', model: 'Civic' },
  'type r': { make: 'Honda', model: 'Civic' },
  accord: { make: 'Honda', model: 'Accord' },
  wrx: { make: 'Subaru', model: 'WRX' },
  sti: { make: 'Subaru', model: 'WRX' },
  brz: { make: 'Subaru', model: 'BRZ' },
  'gti': { make: 'Volkswagen', model: 'Golf GTI' },
  golf: { make: 'Volkswagen', model: 'Golf' },
  porsche: { make: 'Porsche' },
  '911': { make: 'Porsche', model: '911' },
  macan: { make: 'Porsche', model: 'Macan' },
  cayenne: { make: 'Porsche', model: 'Cayenne' },
  panamera: { make: 'Porsche', model: 'Panamera' },
  taycan: { make: 'Porsche', model: 'Taycan' },
  boxster: { make: 'Porsche', model: 'Boxster' },
  cayman: { make: 'Porsche', model: 'Cayman' },
  'model 3': { make: 'Tesla', model: 'Model 3' },
  'model y': { make: 'Tesla', model: 'Model Y' },
  'model s': { make: 'Tesla', model: 'Model S' },
  'model x': { make: 'Tesla', model: 'Model X' },
  cybertruck: { make: 'Tesla', model: 'Cybertruck' },
  tesla: { make: 'Tesla' },
  defender: { make: 'Land Rover', model: 'Defender' },
  'range rover': { make: 'Land Rover', model: 'Range Rover' },
  rover: { make: 'Land Rover' },
  'grand cherokee': { make: 'Jeep', model: 'Grand Cherokee' },
  challenger: { make: 'Dodge', model: 'Challenger' },
  charger: { make: 'Dodge', model: 'Charger' },
  hellcat: { make: 'Dodge' },
  viper: { make: 'Dodge', model: 'Viper' },
  'gt-r': { make: 'Nissan', model: 'GT-R' },
  gtr: { make: 'Nissan', model: 'GT-R' },
  '370z': { make: 'Nissan', model: '370Z' },
  '350z': { make: 'Nissan', model: '350Z' },
  rx7: { make: 'Mazda', model: 'RX-7' },
  'rx-7': { make: 'Mazda', model: 'RX-7' },
  nsx: { make: 'Acura', model: 'NSX' },
  integra: { make: 'Acura', model: 'Integra' },
  'lambo': { make: 'Lamborghini' },
  huracan: { make: 'Lamborghini', model: 'Huracan' },
  urus: { make: 'Lamborghini', model: 'Urus' },
  aventador: { make: 'Lamborghini', model: 'Aventador' },
};

/** Enough to work with no data file. `vocab` replaces this with the full vPIC catalogue. */
const SEED: Vocabulary = {
  makes: [
    'acura', 'alfa romeo', 'aston martin', 'audi', 'bentley', 'bmw', 'buick', 'cadillac', 'chevrolet',
    'daihatsu',
    'chrysler', 'dodge', 'ferrari', 'fiat', 'ford', 'genesis', 'gmc', 'honda', 'hyundai', 'infiniti',
    'jaguar', 'jeep', 'kia', 'lamborghini', 'land rover', 'lexus', 'lincoln', 'lotus', 'lucid',
    'maserati', 'mazda', 'mclaren', 'mercedes-benz', 'mini', 'mitsubishi', 'nissan', 'polestar',
    'pontiac', 'porsche', 'ram', 'rivian', 'rolls-royce', 'saab', 'subaru', 'tesla', 'toyota',
    'volkswagen', 'volvo',
  ],
  models: {
    porsche: ['911', 'Macan', 'Cayenne', 'Panamera', 'Taycan', 'Boxster', 'Cayman', '718 Cayman', '718 Boxster'],
    'mercedes-benz': ['G-Class', 'C-Class', 'E-Class', 'S-Class', 'GLE', 'GLC', 'GLS', 'CLA', 'SL', 'AMG GT'],
    bmw: ['3 Series', '5 Series', '7 Series', 'M3', 'M5', 'X3', 'X5', 'X7', 'i8', 'i4', 'iX', 'Z4'],
    toyota: ['Camry', 'Corolla', 'RAV4', 'Highlander', 'Tacoma', 'Tundra', '4Runner', 'Land Cruiser', 'Supra', 'Prius'],
    honda: ['Civic', 'Accord', 'CR-V', 'Pilot', 'Odyssey', 'HR-V', 'Ridgeline', 'Acty', 'Vamos', 'Beat'],
    ford: ['F-150', 'Mustang', 'Bronco', 'Explorer', 'Escape', 'Ranger', 'Maverick'],
    chevrolet: ['Corvette', 'Camaro', 'Silverado', 'Tahoe', 'Suburban', 'Blazer', 'Colorado'],
    tesla: ['Model 3', 'Model Y', 'Model S', 'Model X', 'Cybertruck'],
    jeep: ['Wrangler', 'Grand Cherokee', 'Cherokee', 'Gladiator', 'Compass'],
    subaru: ['WRX', 'BRZ', 'Outback', 'Forester', 'Crosstrek', 'Ascent', 'Sambar'],
    'land rover': ['Defender', 'Range Rover', 'Range Rover Sport', 'Discovery', 'Evoque'],
    nissan: ['GT-R', '370Z', '350Z', 'Altima', 'Rogue', 'Frontier', 'Titan'],
    mazda: ['MX-5 Miata', 'CX-5', 'CX-9', 'Mazda3', 'RX-7', 'RX-8', 'Scrum', 'Porter'],
    audi: ['A4', 'A6', 'Q5', 'Q7', 'RS3', 'RS5', 'R8', 'e-tron', 'TT'],
    lexus: ['RX', 'NX', 'GX', 'LX', 'IS', 'ES', 'LC', 'LS'],
    mitsubishi: ['Minicab', 'Lancer', 'Outlander', 'Eclipse', 'Delica'],

    /**
     * Kei trucks and vans, which vPIC does not carry at all.
     *
     * The government catalogue lists what was sold new in the United States,
     * and none of these were: they arrive under the twenty-five year import
     * rule, one container at a time. So a search for a Daihatsu Hijet matched
     * nothing, not because the index held none but because the vocabulary had
     * no word for it, and every listing that did come through was stored with
     * a null model. An entire and fast-growing segment was invisible.
     *
     * Daihatsu is added as a make for the same reason: it left the US market in
     * 1992, so vPIC barely knows it exists.
     */
    suzuki: ['Carry', 'Every', 'Jimny', 'Cappuccino', 'Alto', 'Wagon R'],
    daihatsu: ['Hijet', 'Midget', 'Atrai', 'Mira', 'Copen', 'Rocky'],
  },
};

let cached: Vocabulary | null = null;

/** Loads the generated catalogue when it exists, and falls back to the seed when it does not. */
export function loadVocabulary(path = 'data/vehicle-vocab.json'): Vocabulary {
  if (cached) return cached;
  if (existsSync(path)) {
    try {
      const disk = JSON.parse(readFileSync(path, 'utf8')) as Vocabulary;
      if (disk.makes?.length) {
        // The seed models stay merged in: vPIC is authoritative on catalogue
        // names but does not carry the marketing names people actually search
        // for, such as "718 Cayman".
        const models = { ...disk.models };
        for (const [make, list] of Object.entries(SEED.models)) {
          models[make] = [...new Set([...(models[make] ?? []), ...list])];
        }
        cached = { makes: [...new Set([...disk.makes, ...SEED.makes])], models };
        return cached;
      }
    } catch {
      // A corrupt cache must never take the search box down.
    }
  }
  cached = SEED;
  return cached;
}

export function resetVocabularyCache(): void {
  cached = null;
}
