/**
 * Venue import from Google Places.
 *
 *   npm run import:places -- --preset toronto
 *   npm run import:places -- --preset toronto-core --dry-run
 *   npm run import:places -- --lat 43.6487 --lon -79.3980 --radius-km 1.5
 *
 * Fills the venues table with real restaurants and bars. Deals are a separate
 * step: run `npm run scrape` afterwards to read each venue's own site, or add
 * partner deals by hand in the admin console.
 *
 * Needs GOOGLE_MAPS_API_KEY, a Google Cloud project with the Places API (New)
 * enabled, and billing attached. `--dry-run` still calls the API — discovery is
 * the billed part — so use it to check coverage and cost, not to avoid them.
 */

import { config } from "../config.ts";
import { openDatabase } from "../db/index.ts";
import { kilometersToMeters, milesToMeters } from "../domain/geo.ts";
import { listPresets, PRESETS, type CrawlArea } from "../scraper/presets.ts";
import { DEFAULT_TYPES } from "./google.ts";
import { countStalePlaces, importPlaces, REFRESH_AFTER_DAYS } from "./import.ts";

interface Args {
  areas: CrawlArea[];
  timeZone: string;
  dryRun: boolean;
  maxAgeDays: number;
  types: readonly string[];
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
    dryRun: booleans.has("dry-run"),
    maxAgeDays: Number(flags.get("max-age-days") ?? REFRESH_AFTER_DAYS),
    types: flags.get("types")?.split(",").map((type) => type.trim()).filter(Boolean) ??
      DEFAULT_TYPES,
  };

  const presetName = flags.get("preset");
  if (presetName) {
    const preset = PRESETS[presetName];
    if (!preset) {
      console.error(`Unknown preset "${presetName}". Available:\n${listPresets()}`);
      process.exit(1);
    }
    return { ...shared, areas: preset.areas, timeZone: flags.get("tz") ?? preset.timeZone };
  }

  const lat = Number(flags.get("lat"));
  const lon = Number(flags.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error(
      `Usage: npm run import:places -- --preset <name>\n` +
        `   or: npm run import:places -- --lat <lat> --lon <lon> [--radius-km 1.5]\n\n` +
        `Presets:\n${listPresets()}`,
    );
    process.exit(1);
  }

  const radiusM = flags.has("radius-mi")
    ? milesToMeters(Number(flags.get("radius-mi")))
    : kilometersToMeters(Number(flags.get("radius-km") ?? 1.5));

  return {
    ...shared,
    areas: [{ name: `${lat.toFixed(4)},${lon.toFixed(4)}`, lat, lon, radiusM }],
    timeZone: flags.get("tz") ?? "America/Toronto",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!config.googleMapsApiKey) {
    console.error(
      "No GOOGLE_MAPS_API_KEY set.\n\n" +
        "  1. Create a project at https://console.cloud.google.com\n" +
        "  2. Enable 'Places API (New)' and attach a billing account\n" +
        "  3. Create an API key with no HTTP-referrer restriction\n" +
        "  4. GOOGLE_MAPS_API_KEY=... npm run import:places -- --preset toronto\n\n" +
        "Or use the keyless OpenStreetMap path instead: npm run scrape -- --preset toronto",
    );
    process.exit(1);
  }

  console.log(
    `Importing places for ${args.areas.length} area${args.areas.length === 1 ? "" : "s"} ` +
      `(${args.timeZone})${args.dryRun ? " — dry run, nothing will be written" : ""}`,
  );
  console.log(`Types: ${args.types.join(", ")}\n`);

  const db = openDatabase(config.databaseFile);
  const started = Date.now();

  const result = await importPlaces(db, {
    areas: args.areas,
    timeZone: args.timeZone,
    dryRun: args.dryRun,
    maxAgeDays: args.maxAgeDays,
    types: args.types,
    onProgress: (message) => console.log(message),
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${result.discovered} distinct places from ${result.requests} API requests ` +
      `across ${result.areasSearched}/${args.areas.length} areas in ${seconds}s`,
  );
  console.log(`  ${result.written} written, ${result.skippedFresh} already fresh`);
  console.log(
    `  ${result.withWebsite} have a website — those are the ones ` +
      `\`npm run scrape\` can read deals from`,
  );

  if (result.errors.length > 0) {
    console.log(`\n${result.errors.length} area${result.errors.length === 1 ? "" : "s"} failed:`);
    for (const error of result.errors) {
      console.log(`  ${error.area}: ${error.message}`);
      if (error.hint) console.log(`    → ${error.hint}`);
    }
  }

  const stale = countStalePlaces(db, args.maxAgeDays);
  if (stale > 0) {
    console.log(
      `\n${stale} stored place${stale === 1 ? "" : "s"} older than ${args.maxAgeDays} days. ` +
        `Google's terms require a refresh within 30 — re-run this to renew them.`,
    );
  }

  if (result.written > 0) {
    console.log(`\nNext: npm run scrape -- --preset <same> to read deals from their sites.`);
  }
  db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
