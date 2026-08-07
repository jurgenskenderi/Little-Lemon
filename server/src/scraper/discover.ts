/**
 * Venue discovery via OpenStreetMap's Overpass API — free, keyless, and it
 * gives us the one thing we can't scrape our way to: a list of bars and
 * restaurants near a point, with their websites.
 *
 * Overpass has no time zone data, so the caller supplies one for the area
 * being crawled. That is fine for the metro-scale crawls this runs at, but a
 * crawl spanning a time zone boundary would need a lookup instead.
 */

import { config } from "../config.ts";
import type { VenueInput } from "../db/index.ts";

const OVERPASS_ENDPOINT =
  process.env.OVERPASS_ENDPOINT ?? "https://overpass-api.de/api/interpreter";

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

function buildQuery(lat: number, lon: number, radiusM: number): string {
  const amenities = "bar|pub|restaurant|biergarten|cafe";
  const around = `around:${Math.round(radiusM)},${lat},${lon}`;
  // Ways and relations carry the same tags as nodes for larger premises, and
  // `out center` collapses their geometry to a single point for us.
  return `[out:json][timeout:60];
(
  node["amenity"~"^(${amenities})$"](${around});
  way["amenity"~"^(${amenities})$"](${around});
  relation["amenity"~"^(${amenities})$"](${around});
);
out center tags;`;
}

function normalizeWebsite(tags: Record<string, string>): string | null {
  const raw =
    tags["website"] ??
    tags["contact:website"] ??
    tags["url"] ??
    tags["contact:url"] ??
    null;
  if (!raw) return null;

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function addressFrom(tags: Record<string, string>): string | null {
  const parts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:unit"],
  ].filter((part) => part && part.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

export interface DiscoverOptions {
  lat: number;
  lon: number;
  radiusM: number;
  /** IANA zone applied to every venue found in this area. */
  timeZone: string;
  /** Skip venues with no website — there would be nothing to scrape. */
  requireWebsite?: boolean;
  limit?: number;
}

export async function discoverVenues(options: DiscoverOptions): Promise<VenueInput[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  let payload: OverpassResponse;
  try {
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": config.scraper.userAgent,
      },
      body: new URLSearchParams({
        data: buildQuery(options.lat, options.lon, options.radiusM),
      }),
    });

    if (!response.ok) {
      throw new Error(`Overpass returned ${response.status} ${response.statusText}`);
    }
    payload = (await response.json()) as OverpassResponse;
  } finally {
    clearTimeout(timer);
  }

  const requireWebsite = options.requireWebsite ?? true;
  const venues: VenueInput[] = [];

  for (const element of payload.elements ?? []) {
    const tags = element.tags;
    const name = tags?.["name"];
    if (!tags || !name) continue;

    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (lat === undefined || lon === undefined) continue;

    const website = normalizeWebsite(tags);
    if (requireWebsite && !website) continue;

    venues.push({
      id: `osm_${element.type}_${element.id}`,
      name,
      address: addressFrom(tags),
      city: tags["addr:city"] ?? null,
      region: tags["addr:state"] ?? null,
      country: tags["addr:country"] ?? null,
      lat,
      lon,
      timeZone: options.timeZone,
      website,
      phone: tags["phone"] ?? tags["contact:phone"] ?? null,
      source: "openstreetmap",
      sourceId: `${element.type}/${element.id}`,
    });

    if (options.limit && venues.length >= options.limit) break;
  }

  return venues;
}
