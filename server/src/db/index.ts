import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  boundingBox,
  crossesAntimeridian,
  haversineMeters,
} from "../domain/geo.ts";
import { localTimeAt, matchWindows, type DayOfWeek, type DealWindow } from "../domain/time.ts";
import type {
  Deal,
  DealCategory,
  DealResult,
  DealSearch,
  Venue,
} from "../domain/types.ts";

const here = dirname(fileURLToPath(import.meta.url));

export type DatabaseHandle = Database.Database;

export function openDatabase(file: string): DatabaseHandle {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  migrate(db);
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * columns added after someone's database was created need an explicit ALTER.
 * Adding a column is checked against the live schema and is safe to re-run.
 */
function migrate(db: DatabaseHandle): void {
  const columns = db.prepare(`PRAGMA table_info(deals)`).all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("partner")) {
    db.exec(
      `ALTER TABLE deals ADD COLUMN partner INTEGER NOT NULL DEFAULT 0
         CHECK (partner IN (0, 1))`,
    );
  }
  if (!existing.has("image_url")) {
    db.exec(`ALTER TABLE deals ADD COLUMN image_url TEXT`);
  }
}

interface VenueRow {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number;
  lon: number;
  time_zone: string;
  website: string | null;
  phone: string | null;
  source: string;
  source_id: string | null;
}

interface DealRow {
  id: string;
  venue_id: string;
  title: string;
  description: string | null;
  price_text: string | null;
  category: DealCategory;
  fine_print: string | null;
  confidence: number;
  source_url: string | null;
  extracted_by: Deal["extractedBy"];
  partner: number;
  image_url: string | null;
  last_verified_at: string | null;
}

interface WindowRow {
  deal_id: string;
  day_of_week: number;
  start_min: number;
  end_min: number;
}

function toVenue(row: VenueRow): Venue {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    region: row.region,
    country: row.country,
    lat: row.lat,
    lon: row.lon,
    timeZone: row.time_zone,
    website: row.website,
    phone: row.phone,
    source: row.source,
    sourceId: row.source_id,
  };
}

export interface VenueInput extends Omit<Venue, "id"> {
  id?: string;
}

export interface DealInput extends Omit<Deal, "id"> {
  id?: string;
}

function slugId(prefix: string, parts: string[]): string {
  const slug = parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${prefix}_${slug || Math.random().toString(36).slice(2, 10)}`;
}

export function upsertVenue(db: DatabaseHandle, venue: VenueInput): string {
  const id = venue.id ?? slugId("ven", [venue.name, venue.city ?? ""]);
  db.prepare(
    `INSERT INTO venues (id, name, address, city, region, country, lat, lon,
                         time_zone, website, phone, source, source_id, updated_at)
     VALUES (@id, @name, @address, @city, @region, @country, @lat, @lon,
             @time_zone, @website, @phone, @source, @source_id, datetime('now'))
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       address = excluded.address,
       city = excluded.city,
       region = excluded.region,
       country = excluded.country,
       lat = excluded.lat,
       lon = excluded.lon,
       time_zone = excluded.time_zone,
       website = excluded.website,
       phone = excluded.phone,
       source = excluded.source,
       source_id = excluded.source_id,
       updated_at = datetime('now')`,
  ).run({
    id,
    name: venue.name,
    address: venue.address,
    city: venue.city,
    region: venue.region,
    country: venue.country,
    lat: venue.lat,
    lon: venue.lon,
    time_zone: venue.timeZone,
    website: venue.website,
    phone: venue.phone,
    source: venue.source,
    source_id: venue.sourceId,
  });
  return id;
}

/**
 * Replace a deal and its windows atomically. Windows are deleted and reinserted
 * rather than diffed: a re-scrape that drops a day should drop the row, and the
 * window set is small enough that a diff would only add failure modes.
 */
export function upsertDeal(db: DatabaseHandle, deal: DealInput): string {
  const id = deal.id ?? slugId("deal", [deal.venueId, deal.title]);

  // A deal negotiated with a venue is authoritative. A later crawl of that
  // venue's site must not quietly replace it with whatever the page says.
  if (!deal.partner) {
    const existing = db
      .prepare(`SELECT partner FROM deals WHERE id = ?`)
      .get(id) as { partner: number } | undefined;
    if (existing?.partner === 1) return id;
  }

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO deals (id, venue_id, title, description, price_text, category,
                          fine_print, confidence, source_url, extracted_by,
                          partner, image_url, last_verified_at, updated_at)
       VALUES (@id, @venue_id, @title, @description, @price_text, @category,
               @fine_print, @confidence, @source_url, @extracted_by,
               @partner, @image_url, @last_verified_at, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET
         venue_id = excluded.venue_id,
         title = excluded.title,
         description = excluded.description,
         price_text = excluded.price_text,
         category = excluded.category,
         fine_print = excluded.fine_print,
         confidence = excluded.confidence,
         source_url = excluded.source_url,
         extracted_by = excluded.extracted_by,
         partner = excluded.partner,
         image_url = excluded.image_url,
         last_verified_at = excluded.last_verified_at,
         updated_at = datetime('now')`,
    ).run({
      id,
      venue_id: deal.venueId,
      title: deal.title,
      description: deal.description,
      price_text: deal.priceText,
      category: deal.category,
      fine_print: deal.finePrint,
      confidence: deal.confidence,
      source_url: deal.sourceUrl,
      extracted_by: deal.extractedBy,
      partner: deal.partner ? 1 : 0,
      image_url: deal.imageUrl,
      last_verified_at: deal.lastVerifiedAt,
    });

    db.prepare(`DELETE FROM deal_windows WHERE deal_id = ?`).run(id);
    const insertWindow = db.prepare(
      `INSERT INTO deal_windows (deal_id, day_of_week, start_min, end_min)
       VALUES (?, ?, ?, ?)`,
    );
    for (const window of deal.windows) {
      insertWindow.run(id, window.dayOfWeek, window.startMin, window.endMin);
    }
  });

  run();
  return id;
}

export function getVenue(db: DatabaseHandle, id: string): Venue | null {
  const row = db
    .prepare(`SELECT * FROM venues WHERE id = ?`)
    .get(id) as VenueRow | undefined;
  return row ? toVenue(row) : null;
}

function windowsByDeal(
  db: DatabaseHandle,
  dealIds: string[],
): Map<string, DealWindow[]> {
  const byDeal = new Map<string, DealWindow[]>();
  if (dealIds.length === 0) return byDeal;

  const placeholders = dealIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT deal_id, day_of_week, start_min, end_min
       FROM deal_windows WHERE deal_id IN (${placeholders})`,
    )
    .all(...dealIds) as WindowRow[];

  for (const row of rows) {
    const list = byDeal.get(row.deal_id) ?? [];
    list.push({
      dayOfWeek: row.day_of_week as DayOfWeek,
      startMin: row.start_min,
      endMin: row.end_min,
    });
    byDeal.set(row.deal_id, list);
  }
  return byDeal;
}

export function getDealsForVenue(db: DatabaseHandle, venueId: string): Deal[] {
  const rows = db
    .prepare(`SELECT * FROM deals WHERE venue_id = ? ORDER BY title`)
    .all(venueId) as DealRow[];
  const windows = windowsByDeal(db, rows.map((row) => row.id));

  return rows.map((row) => ({
    id: row.id,
    venueId: row.venue_id,
    title: row.title,
    description: row.description,
    priceText: row.price_text,
    category: row.category,
    finePrint: row.fine_print,
    confidence: row.confidence,
    sourceUrl: row.source_url,
    extractedBy: row.extracted_by,
    partner: row.partner === 1,
    imageUrl: row.image_url,
    windows: windows.get(row.id) ?? [],
    lastVerifiedAt: row.last_verified_at,
  }));
}

export interface SearchOptions extends DealSearch {
  sort?: "best" | "distance" | "soonest";
  /** Deals below this confidence are hidden; model output can be noisy. */
  minConfidence?: number;
}

/**
 * The search: bounding box in SQL, exact distance in JS, then time matching.
 *
 * A venue can carry several deals and a deal several windows; only the single
 * best-matching window is returned per deal, because that is what the card in
 * the app shows ("4–6pm, ends in 40 min") and returning all of them would make
 * the client pick anyway.
 */
export function searchDeals(
  db: DatabaseHandle,
  search: SearchOptions,
): DealResult[] {
  const box = boundingBox({ lat: search.lat, lon: search.lon }, search.radiusM);

  const conditions = ["v.lat BETWEEN ? AND ?"];
  const params: unknown[] = [box.minLat, box.maxLat];

  if (crossesAntimeridian(box)) {
    // The box wraps ±180°, so it is two ranges in longitude space.
    const minLon = ((((box.minLon + 180) % 360) + 360) % 360) - 180;
    const maxLon = ((((box.maxLon + 180) % 360) + 360) % 360) - 180;
    conditions.push("(v.lon >= ? OR v.lon <= ?)");
    params.push(minLon, maxLon);
  } else {
    conditions.push("v.lon BETWEEN ? AND ?");
    params.push(box.minLon, box.maxLon);
  }

  if (search.category) {
    // "both" covers drink and food, so it always qualifies.
    conditions.push("(d.category = ? OR d.category = 'both')");
    params.push(search.category);
  }

  if (search.query) {
    conditions.push(
      "(d.title LIKE ? OR d.description LIKE ? OR v.name LIKE ?)",
    );
    const like = `%${search.query}%`;
    params.push(like, like, like);
  }

  const minConfidence = search.minConfidence ?? 0;
  if (minConfidence > 0) {
    conditions.push("d.confidence >= ?");
    params.push(minConfidence);
  }

  const rows = db
    .prepare(
      `SELECT d.id AS deal_id, d.venue_id, d.title, d.description, d.price_text,
              d.category, d.fine_print, d.confidence, d.source_url,
              d.extracted_by, d.partner, d.image_url, d.last_verified_at,
              v.id AS v_id, v.name AS v_name, v.address, v.city, v.region,
              v.country, v.lat, v.lon, v.time_zone, v.website, v.phone,
              v.source, v.source_id
       FROM deals d
       JOIN venues v ON v.id = d.venue_id
       WHERE ${conditions.join(" AND ")}`,
    )
    .all(...params) as Array<DealRow & VenueRow & { deal_id: string; v_id: string; v_name: string }>;

  const windows = windowsByDeal(db, rows.map((row) => row.deal_id));
  const results: DealResult[] = [];

  for (const row of rows) {
    const distanceM = haversineMeters(
      { lat: search.lat, lon: search.lon },
      { lat: row.lat, lon: row.lon },
    );
    if (distanceM > search.radiusM) continue;

    const venue = toVenue({ ...row, id: row.v_id, name: row.v_name });
    const dealWindows = windows.get(row.deal_id) ?? [];
    if (dealWindows.length === 0) continue;

    const localNow = localTimeAt(search.at, venue.timeZone);
    const matches = matchWindows(dealWindows, localNow, search.windowMin);
    const best = matches[0];
    if (!best) continue;

    results.push({
      id: row.deal_id,
      venueId: row.venue_id,
      title: row.title,
      description: row.description,
      priceText: row.price_text,
      category: row.category,
      finePrint: row.fine_print,
      confidence: row.confidence,
      sourceUrl: row.source_url,
      extractedBy: row.extracted_by,
      partner: row.partner === 1,
      imageUrl: row.image_url,
      windows: dealWindows,
      lastVerifiedAt: row.last_verified_at,
      venue,
      distanceM,
      activeNow: best.openAtQueryStart,
      minutesUntilStart: best.minutesUntilStart,
      minutesUntilEnd: best.minutesUntilEnd,
      matchedWindow: best.window,
    });
  }

  const sort = search.sort ?? "best";
  results.sort((a, b) => {
    if (sort === "distance") return a.distanceM - b.distanceM;
    if (sort === "soonest") {
      return (
        a.minutesUntilStart - b.minutesUntilStart || a.distanceM - b.distanceM
      );
    }
    // "best": partner venues first — those deals are agreed directly and are
    // the only ones we can vouch for. Then already-open places, because someone
    // searching at 5pm on a Friday wants a table now, not the best deal across
    // town. Distance breaks the remaining ties.
    if (a.partner !== b.partner) return a.partner ? -1 : 1;
    if (a.activeNow !== b.activeNow) return a.activeNow ? -1 : 1;
    return a.distanceM - b.distanceM;
  });

  return results.slice(search.offset, search.offset + search.limit);
}

/**
 * Replace every crawled deal for a venue in one transaction.
 *
 * A re-crawl treats the venue's own site as the source of truth: a deal it no
 * longer lists should disappear rather than linger. Partner deals are excluded
 * from the delete, so an agreement is never collateral damage of a crawl.
 *
 * Ids embed the schedule, because a venue can run two deals under one name
 * ("Happy Hour" at 4pm and again at 10pm) and those must not collide.
 */
export function replaceCrawledDeals(
  db: DatabaseHandle,
  venueId: string,
  deals: readonly Omit<DealInput, "venueId" | "partner">[],
): string[] {
  const ids: string[] = [];

  const run = db.transaction(() => {
    db.prepare(`DELETE FROM deals WHERE venue_id = ? AND partner = 0`).run(venueId);

    for (const deal of deals) {
      const signature = deal.windows
        .map((window) => `${window.dayOfWeek}-${window.startMin}-${window.endMin}`)
        .sort()
        .join("_");
      const id = deal.id ?? slugId("deal", [venueId, deal.title, signature]);
      ids.push(upsertDeal(db, { ...deal, id, venueId, partner: false }));
    }
  });

  run();
  return ids;
}

export function listVenues(
  db: DatabaseHandle,
  options: { limit?: number; query?: string } = {},
): Venue[] {
  const limit = Math.min(options.limit ?? 200, 500);
  const rows = options.query
    ? (db
        .prepare(
          `SELECT * FROM venues WHERE name LIKE ? OR city LIKE ? ORDER BY name LIMIT ?`,
        )
        .all(`%${options.query}%`, `%${options.query}%`, limit) as VenueRow[])
    : (db.prepare(`SELECT * FROM venues ORDER BY name LIMIT ?`).all(limit) as VenueRow[]);
  return rows.map(toVenue);
}

export function deleteDeal(db: DatabaseHandle, id: string): boolean {
  const result = db.prepare(`DELETE FROM deals WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function deleteVenue(db: DatabaseHandle, id: string): boolean {
  // deal_windows cascade from deals, which cascade from venues.
  const result = db.prepare(`DELETE FROM venues WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function countPartnerDeals(db: DatabaseHandle): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM deals WHERE partner = 1`).get() as {
    n: number;
  };
  return row.n;
}

export function recordScrapedPage(
  db: DatabaseHandle,
  page: {
    url: string;
    host: string;
    venueId: string | null;
    status: number | null;
    contentHash: string | null;
    textContent: string | null;
    error: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO scraped_pages (url, host, venue_id, status, content_hash, text_content, error, fetched_at)
     VALUES (@url, @host, @venue_id, @status, @content_hash, @text_content, @error, datetime('now'))
     ON CONFLICT (url) DO UPDATE SET
       host = excluded.host,
       venue_id = excluded.venue_id,
       status = excluded.status,
       content_hash = excluded.content_hash,
       text_content = excluded.text_content,
       error = excluded.error,
       fetched_at = datetime('now')`,
  ).run({
    url: page.url,
    host: page.host,
    venue_id: page.venueId,
    status: page.status,
    content_hash: page.contentHash,
    text_content: page.textContent,
    error: page.error,
  });
}

export function getScrapedPage(
  db: DatabaseHandle,
  url: string,
): { contentHash: string | null; fetchedAt: string } | null {
  const row = db
    .prepare(`SELECT content_hash, fetched_at FROM scraped_pages WHERE url = ?`)
    .get(url) as { content_hash: string | null; fetched_at: string } | undefined;
  return row ? { contentHash: row.content_hash, fetchedAt: row.fetched_at } : null;
}
