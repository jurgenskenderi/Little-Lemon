/**
 * Venue discovery via Google Places API (New).
 *
 * This is the alternative to `scraper/discover.ts`, which uses OpenStreetMap.
 * Google's coverage of chains, phone numbers and opening hours is markedly
 * better; the cost is a billed API key and terms that constrain what you may
 * keep. Both write the same `VenueInput` shape, so the rest of the app does not
 * care which one filled the venues table.
 *
 * Two constraints shape the code here:
 *
 * 1. **Nearby Search returns at most 20 places and has no page token.** A
 *    1.2 km circle over King West has far more than 20 bars, so asking once
 *    silently gives you an arbitrary 20 of them. `searchArea` detects a circle
 *    that came back full and splits it into quadrants, recursing until the
 *    results stop hitting the cap or the depth limit is reached.
 *
 * 2. **Google's terms limit caching.** The place ID may be stored indefinitely;
 *    everything else — name, address, coordinates, rating — must be refreshed
 *    at least every 30 days. So every import stamps `place_refreshed_at`, and
 *    `--max-age-days` re-fetches anything older rather than trusting the copy
 *    on disk. See the README before shipping this.
 */

import { config } from "../config.ts";
import type { VenueInput } from "../db/index.ts";

/**
 * Read per call, not once at import. A module-level constant is captured before
 * a test — or a caller loading a .env file — has had a chance to set it, and
 * the failure mode is quietly calling the real, billed API instead.
 */
const endpoint = () =>
  process.env["GOOGLE_PLACES_ENDPOINT"] ??
  "https://places.googleapis.com/v1/places:searchNearby";

/** Nearby Search (New) hard-caps a response at 20 and offers no paging. */
const RESULT_CAP = 20;

/**
 * Only what we actually use. The field mask is not a formality — it selects the
 * billing SKU, so asking for fields you will not read costs real money.
 */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryType",
  "places.types",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.businessStatus",
].join(",");

/** Place types worth a happy hour. `night_club` catches late-licence venues. */
export const DEFAULT_TYPES = [
  "restaurant",
  "bar",
  "pub",
  "cafe",
  "wine_bar",
  "night_club",
  "brewery",
] as const;

const PRICE_LEVELS: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  types?: string[];
  websiteUri?: string;
  nationalPhoneNumber?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  businessStatus?: string;
}

/** Everything the venues table keeps beyond the source-neutral `VenueInput`. */
export interface PlaceDetails {
  placeId: string;
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null;
  placeTypes: string | null;
  businessStatus: string | null;
}

export interface DiscoveredPlace {
  venue: VenueInput;
  details: PlaceDetails;
}

export class PlacesError extends Error {
  // Assigned in the body rather than declared as constructor parameter
  // properties: the server runs TypeScript through Node's type-stripping, which
  // erases annotations but never emits code, so a parameter property has
  // nowhere to come from at runtime.
  status: number;
  hint: string | null;

  constructor(message: string, status: number, hint: string | null = null) {
    super(message);
    this.name = "PlacesError";
    this.status = status;
    this.hint = hint;
  }
}

/**
 * Turn a Google error into something a person can act on. A 403 from this API
 * nearly always means one specific, fixable thing, and saying so is the
 * difference between a five-minute fix and an afternoon.
 */
function explain(status: number, body: string): PlacesError {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    /* not JSON; the raw body is the best we have */
  }

  const hints: Record<number, string> = {
    400: "Check the request — an unknown place type or a radius over 50 km will do this.",
    401: "The API key was rejected. Check GOOGLE_MAPS_API_KEY.",
    403: "Enable the Places API (New) for this project, attach a billing account, " +
      "and make sure the key has no HTTP-referrer restriction — those reject server calls.",
    429: "Rate limited. Slow the import down or raise the per-minute quota.",
  };
  return new PlacesError(`Places API returned ${status}: ${detail}`, status, hints[status] ?? null);
}

interface Circle {
  lat: number;
  lon: number;
  radiusM: number;
}

async function requestCircle(
  circle: Circle,
  types: readonly string[],
  apiKey: string,
): Promise<GooglePlace[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.scraper.requestTimeoutMs);

  try {
    const response = await fetch(endpoint(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
        "x-goog-fieldmask": FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes: types,
        maxResultCount: RESULT_CAP,
        // Distance ranking makes the 20-result cap predictable: you get the
        // nearest 20, so a split into quadrants provably fills in the rest.
        rankPreference: "DISTANCE",
        locationRestriction: {
          circle: {
            center: { latitude: circle.lat, longitude: circle.lon },
            radius: Math.min(circle.radiusM, 50_000),
          },
        },
      }),
    });

    if (!response.ok) throw explain(response.status, await response.text());
    const payload = (await response.json()) as { places?: GooglePlace[] };
    return payload.places ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** Quarter a circle into four that between them cover it. */
function quarter(circle: Circle): Circle[] {
  // Half the radius per side, offset so the four overlap slightly rather than
  // leaving diamond-shaped gaps between them at the diagonals.
  const half = circle.radiusM / 2;
  const offset = half * 0.75;
  const dLat = offset / 111_320;
  const dLon = offset / (111_320 * Math.cos((circle.lat * Math.PI) / 180));
  return [
    { lat: circle.lat + dLat, lon: circle.lon - dLon, radiusM: half },
    { lat: circle.lat + dLat, lon: circle.lon + dLon, radiusM: half },
    { lat: circle.lat - dLat, lon: circle.lon - dLon, radiusM: half },
    { lat: circle.lat - dLat, lon: circle.lon + dLon, radiusM: half },
  ];
}

export interface SearchAreaOptions {
  lat: number;
  lon: number;
  radiusM: number;
  /** IANA zone applied to every venue found here; Places does not return one. */
  timeZone: string;
  types?: readonly string[];
  apiKey?: string;
  /** How many times a full circle may be split. Each level is 4x the requests. */
  maxDepth?: number;
  /** Called once per API request, so a long import can show progress. */
  onRequest?: (circle: Circle, found: number, depth: number) => void;
}

/**
 * Every place in a circle, splitting the circle when the API caps out.
 *
 * Results are deduplicated by place ID, so the deliberate overlap between
 * quadrants costs requests but never duplicates venues.
 */
export async function searchArea(options: SearchAreaOptions): Promise<DiscoveredPlace[]> {
  const apiKey = options.apiKey ?? config.googleMapsApiKey;
  if (!apiKey) {
    throw new PlacesError(
      "No Google Maps API key. Set GOOGLE_MAPS_API_KEY.",
      0,
      "Create one in the Google Cloud console with the Places API (New) enabled.",
    );
  }

  const types = options.types ?? DEFAULT_TYPES;
  const maxDepth = options.maxDepth ?? 2;
  const seen = new Map<string, DiscoveredPlace>();

  const visit = async (circle: Circle, depth: number): Promise<void> => {
    const places = await requestCircle(circle, types, apiKey);
    options.onRequest?.(circle, places.length, depth);

    for (const place of places) {
      const mapped = toDiscovered(place, options.timeZone);
      if (mapped && !seen.has(mapped.details.placeId)) {
        seen.set(mapped.details.placeId, mapped);
      }
    }

    // A full response means the circle almost certainly held more than it told
    // us about. A short one means we have all of it.
    if (places.length >= RESULT_CAP && depth < maxDepth) {
      for (const sub of quarter(circle)) await visit(sub, depth + 1);
    }
  };

  await visit({ lat: options.lat, lon: options.lon, radiusM: options.radiusM }, 0);
  return [...seen.values()];
}

function normalizeWebsite(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Split "8 Elm St, Toronto, ON M5G 1G7, Canada" into its parts.
 *
 * Places (New) returns one formatted string rather than components under this
 * field mask, and asking for `addressComponents` moves the call to a dearer
 * billing tier. The format is stable enough for the countries this launches in,
 * and every field it fills is optional downstream.
 */
function splitAddress(formatted: string | undefined): {
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
} {
  if (!formatted) return { address: null, city: null, region: null, country: null };
  const parts = formatted.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return { address: formatted, city: null, region: null, country: null };

  const country = parts.at(-1) ?? null;
  // "ON M5G 1G7" — the province code leads the postal code.
  const regionField = parts.at(-2) ?? "";
  const region = regionField.split(/\s+/)[0] ?? null;
  const city = parts.at(-3) ?? null;
  return { address: parts.slice(0, -3).join(", ") || null, city, region, country };
}

export function toDiscovered(place: GooglePlace, timeZone: string): DiscoveredPlace | null {
  const placeId = place.id;
  const name = place.displayName?.text;
  const lat = place.location?.latitude;
  const lon = place.location?.longitude;
  if (!placeId || !name || lat === undefined || lon === undefined) return null;

  // Somewhere that has closed down is worse than no result: it sends someone
  // to a shuttered door.
  if (place.businessStatus && place.businessStatus !== "OPERATIONAL") return null;

  const { address, city, region, country } = splitAddress(place.formattedAddress);

  return {
    venue: {
      id: `gpl_${placeId}`,
      name,
      address,
      city,
      region,
      country,
      lat,
      lon,
      timeZone,
      website: normalizeWebsite(place.websiteUri),
      phone: place.nationalPhoneNumber ?? null,
      source: "google_places",
      sourceId: placeId,
    },
    details: {
      placeId,
      rating: typeof place.rating === "number" ? place.rating : null,
      ratingCount: typeof place.userRatingCount === "number" ? place.userRatingCount : null,
      priceLevel: place.priceLevel ? (PRICE_LEVELS[place.priceLevel] ?? null) : null,
      placeTypes: place.types?.length ? place.types.join(",") : (place.primaryType ?? null),
      businessStatus: place.businessStatus ?? null,
    },
  };
}
