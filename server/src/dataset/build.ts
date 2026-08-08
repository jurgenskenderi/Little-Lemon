/**
 * Build the static deals dataset the web app reads.
 *
 *   npm run build:deals -- --preset toronto
 *   npm run build:deals -- --preset toronto-core --limit 40
 *
 * The web app is a page on GitHub Pages with no server behind it, and a
 * browser cannot scrape: same-origin policy stops a page reading anyone else's
 * site. So the crawl happens here — on a machine with real network access —
 * and the result is written to `docs/deals.json`, which the page fetches from
 * its own origin. A GitHub Action re-runs this on a schedule and commits the
 * file, so the data refreshes without anything to host.
 *
 * Venues are keyed by their OpenStreetMap id, which is exactly what the app
 * already has for every pin it draws, so merging is a map lookup rather than
 * a fuzzy name match.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.ts";
import { getDealsForVenue, openDatabase, type DatabaseHandle } from "../db/index.ts";
import type { Venue } from "../domain/types.ts";
import { discoverVenues } from "../scraper/discover.ts";
import { isModelExtractionAvailable } from "../scraper/extract-model.ts";
import { crawlVenue, saveDiscoveredVenues, type CrawlStats } from "../scraper/pipeline.ts";
import { preflight } from "../scraper/preflight.ts";
import { listPresets, PRESETS } from "../scraper/presets.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Overridable so the end-to-end test can point it at a temp file rather than
// rewriting the real dataset.
const OUTPUT =
  process.env["DEALS_OUTPUT"] ?? join(here, "..", "..", "..", "docs", "deals.json");

/** Shape the app consumes. Kept flat and small — it ships over the wire. */
interface DatasetDeal {
  title: string;
  priceText: string | null;
  description: string | null;
  category: "drink" | "food" | "both";
  finePrint: string | null;
  /** 0-1. The app labels anything under 0.75 as worth calling ahead about. */
  confidence: number;
  /** Photo on the venue's own host. See the README on caching before launch. */
  imageUrl: string | null;
  sourceUrl: string | null;
  /** One entry per window: day 0-6, minutes from local midnight. */
  windows: Array<{ day: number; start: number; end: number }>;
}

interface DatasetVenue {
  name: string;
  deals: DatasetDeal[];
  socials?: Record<string, string>;
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags.set(key, next); i += 1; }
    else booleans.add(key);
  }

  const presetName = flags.get("preset") ?? "toronto";
  const preset = PRESETS[presetName];
  if (!preset) {
    console.error(`Unknown preset "${presetName}". Available:\n${listPresets()}`);
    process.exit(1);
  }
  return {
    presetName,
    preset,
    limitPerArea: Number(flags.get("limit") ?? 60),
    minConfidence: Number(flags.get("min-confidence") ?? 0.4),
    useModel: !booleans.has("no-model"),
    skipPreflight: booleans.has("skip-preflight"),
  };
}

function toDatasetDeal(deal: ReturnType<typeof getDealsForVenue>[number]): DatasetDeal {
  return {
    title: deal.title,
    priceText: deal.priceText,
    description: deal.description,
    category: deal.category,
    finePrint: deal.finePrint,
    confidence: Number(deal.confidence.toFixed(2)),
    imageUrl: deal.imageUrl,
    sourceUrl: deal.sourceUrl,
    windows: deal.windows.map((window) => ({
      day: window.dayOfWeek,
      start: window.startMin,
      end: window.endMin,
    })),
  };
}

function mergeStats(into: CrawlStats, from: CrawlStats): void {
  into.venuesConsidered += from.venuesConsidered;
  into.venuesCrawled += from.venuesCrawled;
  into.pagesFetched += from.pagesFetched;
  into.pagesSkipped += from.pagesSkipped;
  into.pagesDisallowed += from.pagesDisallowed;
  into.socialsFound += from.socialsFound;
  into.socialsCrawled += from.socialsCrawled;
  into.dealsWritten += from.dealsWritten;
  into.modelCalls += from.modelCalls;
  into.modelRefusals += from.modelRefusals;
  into.errors.push(...from.errors);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.skipPreflight) {
    const check = await preflight();
    console.log(`Connectivity: ${check.ok ? "ok" : "FAILED"} — ${check.detail}`);
    if (!check.ok) {
      // A crawl that fails from no network looks exactly like one where every
      // venue site is down: a pile of timeouts and an empty file. Say which.
      console.error(
        check.overpassReachable
          ? "Venue sites are unreachable, so there is nothing to extract."
          : "Overpass is unreachable, so there are no venues to crawl.",
      );
      process.exit(1);
    }
  }

  console.log(
    `Model extraction: ${isModelExtractionAvailable() && args.useModel ? "on" : "off"}` +
      `${isModelExtractionAvailable() ? "" : " (set ANTHROPIC_API_KEY to widen coverage)"}`,
  );

  const db: DatabaseHandle = openDatabase(config.databaseFile);
  const totals: CrawlStats = {
    venuesConsidered: 0, venuesCrawled: 0, pagesFetched: 0, pagesSkipped: 0,
    pagesDisallowed: 0, socialsFound: 0, socialsCrawled: 0, dealsWritten: 0,
    modelCalls: 0, modelRefusals: 0, errors: [],
  };

  // Discover once across every area, deduplicating by OSM id where the
  // circles overlap, so a venue on two bar strips is crawled once.
  const discovered = new Map<string, Venue>();
  for (const area of args.preset.areas) {
    try {
      const found = await discoverVenues({
        lat: area.lat, lon: area.lon, radiusM: area.radiusM,
        timeZone: args.preset.timeZone,
        requireWebsite: true,
        limit: args.limitPerArea,
      });
      for (const venue of saveDiscoveredVenues(db, found)) discovered.set(venue.id, venue);
      console.log(`  ${area.name.padEnd(26)} ${found.length} with a website`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ${area.name.padEnd(26)} discovery failed: ${message}`);
      totals.errors.push(`discover ${area.name}: ${message}`);
    }
  }

  const venues = [...discovered.values()];
  console.log(`\n${venues.length} distinct venues to crawl\n`);

  const dataset: Record<string, DatasetVenue> = {};
  let done = 0;
  let dropped = 0;

  for (const venue of venues) {
    const stats = await crawlVenue(db, venue, { useModel: args.useModel });
    mergeStats(totals, stats);
    done += 1;

    // A guess below the floor is worse than nothing: it sends someone across
    // town on a phantom. The app already warns about anything under 0.75, but
    // there is a level below which the honest move is to publish silence.
    const deals = getDealsForVenue(db, venue.id).filter(
      (deal) => deal.windows.length > 0 && deal.confidence >= args.minConfidence,
    );
    dropped += getDealsForVenue(db, venue.id).length - deals.length;
    const socials = stats.socials && stats.socials.size > 0
      ? Object.fromEntries(stats.socials) : undefined;

    // Only venues we learned something about earn a place in the file — the
    // app already knows every venue from OpenStreetMap, so repeating the ones
    // with nothing to say would just make the download bigger.
    if (deals.length > 0 || socials) {
      // sourceId is "node/123" — the same key the app has for its own pins.
      dataset[venue.sourceId ?? venue.id] = {
        name: venue.name,
        deals: deals.map(toDatasetDeal),
        ...(socials ? { socials } : {}),
      };
    }

    if (done % 10 === 0 || done === venues.length) {
      console.log(`  ${done}/${venues.length} crawled, ${totals.dealsWritten} deals so far`);
    }
  }

  const withDeals = Object.values(dataset).filter((entry) => entry.deals.length > 0).length;
  const withImages = Object.values(dataset)
    .flatMap((entry) => entry.deals).filter((deal) => deal.imageUrl).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    preset: args.presetName,
    timeZone: args.preset.timeZone,
    stats: {
      venuesConsidered: totals.venuesConsidered,
      venuesCrawled: totals.venuesCrawled,
      venuesWithDeals: withDeals,
      deals: totals.dealsWritten,
      dealsWithImages: withImages,
      dealsBelowConfidence: dropped,
      pagesFetched: totals.pagesFetched,
      pagesDisallowed: totals.pagesDisallowed,
      socialsFound: totals.socialsFound,
      socialsCrawled: totals.socialsCrawled,
      modelCalls: totals.modelCalls,
      errors: totals.errors.length,
    },
    venues: dataset,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 1)}\n`);

  console.log(`\nWrote ${OUTPUT}`);
  console.log(`  ${withDeals} venues with deals, ${totals.dealsWritten} deals total`);
  console.log(`  ${withImages} deals carry a photo`);
  console.log(`  ${dropped} dropped below the ${args.minConfidence} confidence floor`);
  console.log(`  ${totals.pagesFetched} pages fetched, ${totals.pagesDisallowed} refused by robots.txt`);
  console.log(`  ${totals.socialsFound} social profiles found, ${totals.socialsCrawled} crawlable`);
  if (totals.errors.length > 0) {
    console.log(`  ${totals.errors.length} errors; first few:`);
    for (const error of totals.errors.slice(0, 5)) console.log(`    ${error}`);
  }
  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
