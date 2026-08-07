/**
 * Crawl runner.
 *
 *   npm run scrape --workspace server -- --lat 47.6205 --lon -122.3493 \
 *     --radius-mi 2 --tz America/Los_Angeles --limit 25
 *
 * Discovers venues near a point via OpenStreetMap, then crawls each one's site
 * for deals. Add --dry-run to see what would be crawled without fetching.
 */

import { config } from "../config.ts";
import { openDatabase } from "../db/index.ts";
import { milesToMeters } from "../domain/geo.ts";
import { discoverVenues } from "./discover.ts";
import { isModelExtractionAvailable } from "./extract-model.ts";
import { crawlVenues, saveDiscoveredVenues } from "./pipeline.ts";

interface Args {
  lat: number;
  lon: number;
  radiusM: number;
  timeZone: string;
  limit: number;
  dryRun: boolean;
  force: boolean;
  useModel: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      booleans.add(key);
    }
  }

  const lat = Number(flags.get("lat"));
  const lon = Number(flags.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("--lat and --lon are required, e.g. --lat 47.62 --lon -122.35");
  }

  const radiusMi = Number(flags.get("radius-mi") ?? 2);
  const radiusM = Number(flags.get("radius-m") ?? milesToMeters(radiusMi));

  return {
    lat,
    lon,
    radiusM,
    timeZone:
      flags.get("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    limit: Number(flags.get("limit") ?? 25),
    dryRun: booleans.has("dry-run"),
    force: booleans.has("force"),
    useModel: !booleans.has("no-model"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase(config.databaseFile);

  console.log(
    `Discovering venues within ${(args.radiusM / 1000).toFixed(1)} km of ` +
      `${args.lat}, ${args.lon} (${args.timeZone})`,
  );

  const discovered = await discoverVenues({
    lat: args.lat,
    lon: args.lon,
    radiusM: args.radiusM,
    timeZone: args.timeZone,
    limit: args.limit,
  });

  console.log(`Found ${discovered.length} venues with a website.`);

  if (args.dryRun) {
    for (const venue of discovered) {
      console.log(`  ${venue.name} — ${venue.website}`);
    }
    db.close();
    return;
  }

  const venues = saveDiscoveredVenues(db, discovered);

  if (args.useModel && !isModelExtractionAvailable()) {
    console.log(
      "ANTHROPIC_API_KEY is not set — running with the heuristic parser only.",
    );
  }

  const stats = await crawlVenues(db, venues, {
    useModel: args.useModel,
    force: args.force,
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log("\nCrawl complete:");
  console.log(`  venues crawled     ${stats.venuesCrawled}/${stats.venuesConsidered}`);
  console.log(`  pages fetched      ${stats.pagesFetched}`);
  console.log(`  pages skipped      ${stats.pagesSkipped} (fresh in cache)`);
  console.log(`  pages disallowed   ${stats.pagesDisallowed} (robots.txt)`);
  console.log(`  deals written      ${stats.dealsWritten}`);
  console.log(`  model calls        ${stats.modelCalls} (${stats.modelRefusals} declined)`);

  if (stats.errors.length > 0) {
    console.log(`\n${stats.errors.length} errors:`);
    for (const error of stats.errors.slice(0, 20)) console.log(`  ${error}`);
  }

  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
