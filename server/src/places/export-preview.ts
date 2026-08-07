/**
 * Push the real database into the standalone preview page.
 *
 *   npm run export:preview                    # rewrite preview/index.html
 *   npm run export:preview -- --dry-run       # print what would change
 *   npm run export:preview -- --radius-km 6   # widen the area exported
 *
 * The preview is a single self-contained HTML file with its venue table
 * inlined, because a sandboxed artifact page cannot call an API. That normally
 * means the preview drifts from reality the moment you import anything. This
 * closes the loop: import venues, crawl deals, run this, and the page people
 * actually open is showing the same data the app is.
 *
 * Only the block between the CLOCKTAILS:VENUES markers is touched.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.ts";
import { getDealsForVenue, openDatabase, searchVenues } from "../db/index.ts";
import type { Deal, Venue } from "../domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PREVIEW = join(here, "..", "..", "..", "preview", "index.html");

const START = "/* CLOCKTAILS:VENUES:START";
const END = "/* CLOCKTAILS:VENUES:END */";

/** JS string literal, safe to paste into a page. */
function js(value: string | null): string {
  if (value === null) return "null";
  return JSON.stringify(value);
}

/**
 * The preview stores windows as minutes from local midnight and takes one
 * (start, end) pair per deal, so a deal whose windows differ by day has to be
 * split. Grouping by the pair keeps "Mon-Fri 4-6, Sat 3-5" as two entries
 * rather than silently dropping one.
 */
function dealLiterals(deal: Deal): string[] {
  const byWindow = new Map<string, number[]>();
  for (const window of deal.windows) {
    const key = `${window.startMin}:${window.endMin}`;
    byWindow.set(key, [...(byWindow.get(key) ?? []), window.dayOfWeek]);
  }

  return [...byWindow.entries()].map(([key, days]) => {
    const [startMin, endMin] = key.split(":").map(Number);
    const options: string[] = [];
    if (deal.finePrint) options.push(`fine:${js(deal.finePrint)}`);
    if (deal.partner) options.push("partner:true");
    options.push(`conf:${Number(deal.confidence.toFixed(2))}`);

    return (
      `    D(${js(deal.title)},${js(deal.priceText)},${js(deal.category)},` +
      `[${days.sort().join(",")}],${startMin},${endMin},` +
      `${js(deal.description)},{${options.join(",")}})`
    );
  });
}

function venueLiteral(venue: Venue, deals: Deal[]): string {
  const body = deals.flatMap(dealLiterals);
  const head =
    `  V(${js(venue.name)},${js(venue.address)},${js(venue.city)},` +
    `${venue.lat.toFixed(5)},${venue.lon.toFixed(5)},${js(venue.phone)},[`;
  return body.length === 0 ? `${head}]),` : `${head}\n${body.join(",\n")}]),`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const dryRun = argv.includes("--dry-run");
  const radiusKm = Number(flag("radius-km") ?? 8);
  const lat = Number(flag("lat") ?? 43.6487);
  const lon = Number(flag("lon") ?? -79.398);

  const db = openDatabase(config.databaseFile);
  const nearby = searchVenues(db, { lat, lon, radiusM: radiusKm * 1000, limit: 500 });

  if (nearby.length === 0) {
    console.error(
      `No venues within ${radiusKm} km of ${lat},${lon} in ${config.databaseFile}.\n` +
        `Import some first: npm run import:places -- --preset toronto`,
    );
    process.exit(1);
  }

  const lines: string[] = [];
  let withDeals = 0;
  let withPhone = 0;

  for (const { venue } of nearby) {
    const deals = getDealsForVenue(db, venue.id);
    if (deals.length > 0) withDeals += 1;
    if (venue.phone) withPhone += 1;
    lines.push(venueLiteral(venue, deals));
  }

  const generated =
    `${START} — replaced wholesale by \`npm run export:preview\`.\n` +
    `   Everything between the markers is generated; edit the source data, not this.\n` +
    `   ${nearby.length} venues within ${radiusKm} km, exported ${new Date().toISOString()}. */\n` +
    `const VENUES = [\n${lines.join("\n")}\n];\n${END}`;

  const html = readFileSync(PREVIEW, "utf8");
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < 0) {
    console.error(`Could not find the CLOCKTAILS:VENUES markers in ${PREVIEW}.`);
    process.exit(1);
  }

  console.log(
    `${nearby.length} venues within ${radiusKm} km — ` +
      `${withDeals} with deals, ${withPhone} with a phone number`,
  );

  if (dryRun) {
    console.log(`\nWould replace ${to + END.length - from} bytes in ${PREVIEW}. First few:\n`);
    console.log(lines.slice(0, 5).join("\n"));
    db.close();
    return;
  }

  writeFileSync(PREVIEW, html.slice(0, from) + generated + html.slice(to + END.length));
  console.log(`Wrote ${PREVIEW}`);
  if (withDeals === 0) {
    console.log(
      "None of them have deals yet — the preview will show them as places on the map. " +
        "Run `npm run scrape` to read their sites.",
    );
  }
  db.close();
}

main();
