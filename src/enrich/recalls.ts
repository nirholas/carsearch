/**
 * NHTSA recall campaigns. Free, no key.
 *
 * The reason this is in the product and not just in the data layer: the API
 * returns `parkIt` and `parkOutSide` booleans for fire-risk campaigns. Showing
 * a buyer "this model year has an open do-not-park-indoors recall" next to the
 * listing is information no incumbent aggregator surfaces, and it is the kind
 * that changes a decision on the day it is read.
 */

const ENDPOINT = 'https://api.nhtsa.gov/recalls/recallsByVehicle';

export interface Recall {
  NHTSACampaignNumber: string;
  Component: string;
  Summary: string;
  Consequence: string;
  Remedy: string;
  ReportReceivedDate: string;
  parkIt: boolean;
  parkOutSide: boolean;
}

export interface RecallReport {
  make: string;
  model: string;
  year: number;
  count: number;
  parkIt: boolean;
  parkOutSide: boolean;
  campaigns: Recall[];
}

export async function recallsFor(make: string, model: string, year: number): Promise<RecallReport | null> {
  const url = `${ENDPOINT}?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${year}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: Recall[] };
    const campaigns = body.results ?? [];
    return {
      make,
      model,
      year,
      count: campaigns.length,
      parkIt: campaigns.some((c) => c.parkIt),
      parkOutSide: campaigns.some((c) => c.parkOutSide),
      campaigns,
    };
  } catch {
    return null;
  }
}
