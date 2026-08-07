/**
 * Importing discovered places into the venues table.
 *
 * Separate from the Places client so the network shape and the storage shape
 * can be tested independently, and so a second provider could be added without
 * touching this file.
 */

import { upsertVenue, type DatabaseHandle } from "../db/index.ts";
import { PlacesError, searchArea, type DiscoveredPlace } from "./google.ts";
import type { CrawlArea } from "../scraper/presets.ts";

/**
 * Google's terms allow a place ID to be stored indefinitely but require every
 * other field to be refreshed at least every 30 days. Twenty-five leaves room
 * for a weekly job to slip without going out of compliance.
 */
export const REFRESH_AFTER_DAYS = 25;

export interface ImportOptions {
  areas: CrawlArea[];
  timeZone: string;
  apiKey?: string;
  /** Discover and report, write nothing. */
  dryRun?: boolean;
  /** Re-fetch places whose stored copy is older than this. */
  maxAgeDays?: number;
  types?: readonly string[];
  onProgress?: (message: string) => void;
}

export interface ImportResult {
  areasSearched: number;
  requests: number;
  /** Distinct places seen, after deduplicating across overlapping circles. */
  discovered: number;
  written: number;
  skippedFresh: number;
  withWebsite: number;
  errors: Array<{ area: string; message: string; hint: string | null }>;
}

/** Which stored place IDs are still inside their permitted cache window. */
function freshPlaceIds(db: DatabaseHandle, maxAgeDays: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT source_id FROM venues
        WHERE source = 'google_places'
          AND source_id IS NOT NULL
          AND place_refreshed_at IS NOT NULL
          AND place_refreshed_at > datetime('now', ?)`,
    )
    .all(`-${maxAgeDays} days`) as Array<{ source_id: string }>;
  return new Set(rows.map((row) => row.source_id));
}

export async function importPlaces(
  db: DatabaseHandle,
  options: ImportOptions,
): Promise<ImportResult> {
  const maxAgeDays = options.maxAgeDays ?? REFRESH_AFTER_DAYS;
  const fresh = freshPlaceIds(db, maxAgeDays);

  const result: ImportResult = {
    areasSearched: 0,
    requests: 0,
    discovered: 0,
    written: 0,
    skippedFresh: 0,
    withWebsite: 0,
    errors: [],
  };

  const seen = new Map<string, DiscoveredPlace>();

  for (const area of options.areas) {
    try {
      const found = await searchArea({
        lat: area.lat,
        lon: area.lon,
        radiusM: area.radiusM,
        timeZone: options.timeZone,
        apiKey: options.apiKey,
        types: options.types,
        onRequest: (circle, count, depth) => {
          result.requests += 1;
          if (depth > 0) {
            options.onProgress?.(
              `    ${area.name}: split at ${Math.round(circle.radiusM)} m → ${count}`,
            );
          }
        },
      });
      result.areasSearched += 1;
      for (const place of found) seen.set(place.details.placeId, place);
      options.onProgress?.(`  ${area.name.padEnd(26)} ${found.length} places`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = error instanceof PlacesError ? error.hint : null;
      result.errors.push({ area: area.name, message, hint });
      options.onProgress?.(`  ${area.name.padEnd(26)} failed: ${message}`);
      // An auth or billing failure will fail identically for every remaining
      // area. Stop rather than burning fifteen requests to learn it again.
      if (error instanceof PlacesError && [0, 401, 403].includes(error.status)) break;
    }
  }

  result.discovered = seen.size;

  for (const place of seen.values()) {
    if (place.venue.website) result.withWebsite += 1;
    if (fresh.has(place.details.placeId)) {
      result.skippedFresh += 1;
      continue;
    }
    if (options.dryRun) continue;

    upsertVenue(db, {
      ...place.venue,
      rating: place.details.rating,
      ratingCount: place.details.ratingCount,
      priceLevel: place.details.priceLevel,
      placeTypes: place.details.placeTypes ? place.details.placeTypes.split(",") : null,
      placeRefreshedAt: new Date().toISOString(),
    });
    result.written += 1;
  }

  return result;
}

/**
 * Venues whose provider copy has aged past what the terms allow.
 *
 * Worth surfacing rather than silently serving: stale rows are both a
 * compliance problem and the reason a closed restaurant is still on the map.
 */
export function countStalePlaces(db: DatabaseHandle, maxAgeDays = REFRESH_AFTER_DAYS): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM venues
        WHERE source = 'google_places'
          AND (place_refreshed_at IS NULL OR place_refreshed_at <= datetime('now', ?))`,
    )
    .get(`-${maxAgeDays} days`) as { n: number };
  return row.n;
}
