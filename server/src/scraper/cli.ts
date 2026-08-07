/**
 * Crawl runner.
 *
 *   npm run scrape -- --preset toronto            # every Toronto bar strip
 *   npm run scrape -- --preset toronto-core       # downtown only, quicker
 *   npm run scrape -- --lat 43.6487 --lon -79.3980 --radius-km 3
 *
 * Discovers venues near one or more points via OpenStreetMap, then crawls each
 * one's site for deals. Add --dry-run to list what would be crawled without
 * fetching anything.
 */

import { config } from "../config.ts";
import { openDatabase, type VenueInput } from "../db/index.ts";
import { kilometersToMeters, milesToMeters } from "../domain/geo.ts";
import { discoverVenues } from "./discover.ts";
import { isModelExtractionAvailable } from "./extract-model.ts";
import { crawlVenues, saveDiscoveredVenues } from "./pipeline.ts";
import { preflight } from "./preflight.ts";
import { listPresets, PRESETS, type CrawlArea } from "./presets.ts";

interface Args {
  areas: CrawlArea[];
  timeZone: string;
  limitPerArea: number;
  dryRun: boolean;
  force: boolean;
  useModel: boolean;
  skipPreflight: boolean;
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

  const shared = {
    limitPerArea: Number(flags.get("limit") ?? 40),
    dryRun: booleans.has("dry-run"),
    force: booleans.has("force"),
    useModel: !booleans.has("no-model"),
    skipPreflight: booleans.has("skip-preflight"),
  };

  const presetName = flags.get("preset");
  if (presetName) {
    const preset = PRESETS[presetName];
    if (!preset) {
      throw new Error(
        `Unknown preset "${presetName}". Available:\n${listPresets()}`,
      );
    }
    return {
      ...shared,
      areas: preset.areas,
      timeZone: flags.get("tz") ?? preset.timeZone,
    };
  }

  const lat = Number(flags.get("lat"));
  const lon = Number(flags.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(
      "Give either --preset or --lat/--lon.\n\nPresets:\n" + listPresets() +
      "\n\nExample:\n  npm run scrape -- --preset toronto\n" +
      "  npm run scrape -- --lat 43.6487 --lon -79.3980 --radius-km 2",
    );
  }

  const radiusKm = Number(flags.get("radius-km") ?? 2);
  const radiusMi = flags.get("radius-mi");
  const radiusM = Number(
    flags.get("radius-m") ??
      (radiusMi !== undefined ? milesToMeters(Number(radiusMi)) : kilometersToMeters(radiusKm)),
  );

  return {
    ...shared,
    areas: [{ name: `${lat}, ${lon}`, lat, lon, radiusM }],
    // Ontario is Eastern time end to end, apart from a small north-western
    // corner around Atikokan that sits on Central.
    timeZone: flags.get("tz") ?? "America/Toronto",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.skipPreflight) {
    process.stdout.write("Checking connectivity… ");
    const check = await preflight();
    console.log(check.ok ? "ok" : "failed");
    if (!check.ok) {
      console.error(`\n${check.detail}\n`);
      console.error("Pass --skip-preflight to try the crawl anyway.");
      process.exitCode = 1;
      return;
    }
  }

  const db = openDatabase(config.databaseFile);

  console.log(
    `\nDiscovering venues across ${args.areas.length} area${args.areas.length === 1 ? "" : "s"} ` +
      `(${args.timeZone})`,
  );

  // Discover everything first so the crawl reports a real total, and so an
  // Overpass rate-limit surfaces before any venue site has been touched.
  const byId = new Map<string, VenueInput>();
  for (const area of args.areas) {
    try {
      const found = await discoverVenues({
        lat: area.lat,
        lon: area.lon,
        radiusM: area.radiusM,
        timeZone: args.timeZone,
        limit: args.limitPerArea,
      });
      let added = 0;
      for (const venue of found) {
        // Neighbourhood circles overlap; the OSM id keeps each venue once.
        const key = venue.id ?? `${venue.name}|${venue.lat},${venue.lon}`;
        if (!byId.has(key)) { byId.set(key, venue); added += 1; }
      }
      console.log(`  ${area.name.padEnd(26)} ${found.length} found, ${added} new`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ${area.name.padEnd(26)} failed: ${message}`);
    }
    // Overpass asks for a pause between queries; it is a shared free service.
    if (args.areas.length > 1) await new Promise((r) => setTimeout(r, 2000));
  }

  const discovered = [...byId.values()];
  console.log(`\n${discovered.length} unique venues with a website.`);

  if (discovered.length === 0) {
    console.log("Nothing to crawl.");
    db.close();
    return;
  }

  if (args.dryRun) {
    for (const venue of discovered) console.log(`  ${venue.name} — ${venue.website}`);
    console.log("\n(dry run — nothing was fetched)");
    db.close();
    return;
  }

  const venues = saveDiscoveredVenues(db, discovered);

  if (args.useModel && !isModelExtractionAvailable()) {
    console.log("ANTHROPIC_API_KEY is not set — running with the heuristic parser only.");
  }
  const estimateMin = Math.ceil(
    (venues.length * config.scraper.maxPagesPerVenue * config.scraper.minHostDelayMs) / 60_000,
  );
  console.log(`Crawling (roughly ${estimateMin} min at the polite delay)…\n`);

  const started = Date.now();
  const stats = await crawlVenues(db, venues, {
    useModel: args.useModel,
    force: args.force,
    onProgress: (message) => console.log(`  ${message}`),
  });

  console.log("\nCrawl complete:");
  console.log(`  elapsed            ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  venues crawled     ${stats.venuesCrawled}/${stats.venuesConsidered}`);
  console.log(`  pages fetched      ${stats.pagesFetched}`);
  console.log(`  pages skipped      ${stats.pagesSkipped} (fresh in cache)`);
  console.log(`  pages disallowed   ${stats.pagesDisallowed} (robots.txt)`);
  console.log(`  deals written      ${stats.dealsWritten}`);
  console.log(`  model calls        ${stats.modelCalls} (${stats.modelRefusals} declined)`);

  if (stats.errors.length > 0) {
    console.log(`\n${stats.errors.length} errors (first 20):`);
    for (const error of stats.errors.slice(0, 20)) console.log(`  ${error}`);
  }

  if (stats.dealsWritten === 0 && stats.pagesFetched > 0) {
    console.log(
      "\nPages were fetched but no deals were found. That is a normal outcome when\n" +
        "venues publish hours as images or inside a booking widget. Setting\n" +
        "ANTHROPIC_API_KEY lets the model extractor read pages the parser cannot.",
    );
  }

  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
