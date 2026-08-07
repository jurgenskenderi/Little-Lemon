/**
 * Load the fictional development dataset so the app is usable before any crawl
 * has run. Safe to re-run: everything upserts by id.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.ts";
import { openDatabase, upsertDeal, upsertVenue, type DatabaseHandle } from "../db/index.ts";
import type { DayOfWeek } from "../domain/time.ts";
import type { DealCategory } from "../domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface SeedDeal {
  title: string;
  description: string | null;
  priceText: string | null;
  category: DealCategory;
  finePrint: string | null;
  confidence: number;
  partner?: boolean;
  imageUrl?: string | null;
  days: number[];
  startMin: number;
  endMin: number;
}

interface SeedVenue {
  id: string;
  name: string;
  address: string;
  city: string;
  region: string;
  lat: number;
  lon: number;
  website: string;
  phone: string;
  deals: SeedDeal[];
}

interface SeedFile {
  timeZone: string;
  venues: SeedVenue[];
}

export function seedDatabase(db: DatabaseHandle): { venues: number; deals: number } {
  const file = JSON.parse(
    readFileSync(join(here, "venues.json"), "utf8"),
  ) as SeedFile;

  let dealCount = 0;

  for (const venue of file.venues) {
    upsertVenue(db, {
      id: venue.id,
      name: venue.name,
      address: venue.address,
      city: venue.city,
      region: venue.region,
      country: "CA",
      lat: venue.lat,
      lon: venue.lon,
      timeZone: file.timeZone,
      website: venue.website,
      phone: venue.phone,
      source: "seed",
      sourceId: venue.id,
    });

    for (const deal of venue.deals) {
      upsertDeal(db, {
        id: `${venue.id}__${deal.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        venueId: venue.id,
        title: deal.title,
        description: deal.description,
        priceText: deal.priceText,
        category: deal.category,
        finePrint: deal.finePrint,
        confidence: deal.confidence,
        sourceUrl: venue.website,
        extractedBy: deal.partner ? "manual" : "seed",
        partner: deal.partner ?? false,
        imageUrl: deal.imageUrl ?? null,
        windows: deal.days.map((day) => ({
          dayOfWeek: day as DayOfWeek,
          startMin: deal.startMin,
          endMin: deal.endMin,
        })),
        lastVerifiedAt: new Date().toISOString(),
      });
      dealCount += 1;
    }
  }

  return { venues: file.venues.length, deals: dealCount };
}

// Only run the CLI path when invoked directly, so tests can import the loader.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDatabase(config.databaseFile);
  const counts = seedDatabase(db);
  console.log(
    `Seeded ${counts.venues} venues and ${counts.deals} deals into ${config.databaseFile}`,
  );
  db.close();
}
