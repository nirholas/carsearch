import type { Listing } from '../core/types.js';
import { parseTitleStatus, parseOwners, parseAccidents, parseUsage, parseTransmission, parseDrivetrain } from '../core/facets.js';

/**
 * Facets recoverable from text a source already gave us.
 *
 * Enthusiast auction sites in particular put the whole disclosure in the title
 * and the card copy: "48k-Mile 2017 Porsche Macan S", "Salvage-Title 2012 911",
 * "One-Owner 1988 Carrera". None of that arrives as a structured field, but it
 * is the seller's own statement, which makes it better evidence than an
 * inference. Only what was actually written is recorded; nothing is guessed.
 */

/** Text worth scanning, most authoritative first. */
function corpus(l: Listing): string {
  const raw = l.raw ?? {};
  const rawText = Object.values(raw)
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  return [l.title, l.trim, rawText].filter(Boolean).join(' ');
}

/** "48k-Mile", "12,345 Miles", "48k miles" in a title. */
export function mileageFromText(text: string): number | null {
  const k = text.match(/\b(\d{1,3}(?:\.\d)?)k[\s-]?mile/i);
  if (k?.[1]) return Math.round(Number(k[1]) * 1000);
  const plain = text.match(/\b(\d{1,3}(?:,\d{3})+|\d{4,6})[\s-]?mile/i);
  if (plain?.[1]) {
    const n = Number(plain[1].replace(/,/g, ''));
    return n > 0 && n < 1_000_000 ? n : null;
  }
  return null;
}

export function facetsFromText(l: Listing): Partial<Listing> {
  const text = corpus(l);
  if (!text) return {};

  const out: Partial<Listing> = {};
  const titleStatus = parseTitleStatus(text);
  if (titleStatus && l.titleStatus === null) out.titleStatus = titleStatus;

  const owners = parseOwners(text);
  if (owners !== null && l.owners === null) out.owners = owners;

  const accidents = parseAccidents(text);
  if (accidents !== null && l.accidents === null) {
    out.accidents = accidents;
    out.accidentFree = accidents === 0;
  }

  const usage = parseUsage(text);
  if (usage && l.usage === null) out.usage = usage;

  /**
   * Transmission and drivetrain are read from the title only, not the whole
   * corpus. A raw blob mentioning "automatic" in a features list is about
   * something else often enough to matter, and a wrong drivetrain on a filtered
   * result is a wasted trip to a dealership.
   */
  const titleOnly = l.title ?? '';
  const transmission = parseTransmission(titleOnly);
  if (transmission && l.transmission === null) out.transmission = transmission;
  const drivetrain = parseDrivetrain(titleOnly);
  if (drivetrain && l.drivetrain === null) out.drivetrain = drivetrain;

  if (l.mileage === null) {
    const miles = mileageFromText(titleOnly);
    if (miles !== null) {
      out.mileage = miles;
      // "48k-Mile" is the seller rounding, and treating it as an odometer
      // reading would make a lowest-mileage sort quietly wrong.
      out.mileageIsRounded = /\dk[\s-]?mile/i.test(titleOnly);
    }
  }

  if (l.certified === null && /\b(cpo|certified pre[\s-]?owned|manufacturer certified)\b/i.test(text)) {
    out.certified = true;
  }
  if (l.serviceRecords === null && /\b(service (records|history)|maintenance records|books and records)\b/i.test(text)) {
    out.serviceRecords = true;
  }

  return out;
}
