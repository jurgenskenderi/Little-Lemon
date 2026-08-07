/**
 * Crawl a venue's site and turn it into deals.
 *
 * Per venue: fetch the homepage, follow the few links most likely to hold
 * specials, then run the heuristic parser over each page. The model extractor
 * is a fallback, not the default — it runs only for pages the parser couldn't
 * read, which keeps a metro-wide crawl affordable.
 */

import { createHash } from "node:crypto";

import { config } from "../config.ts";
import {
  getScrapedPage,
  recordScrapedPage,
  upsertDeal,
  upsertVenue,
  type DatabaseHandle,
  type VenueInput,
} from "../db/index.ts";
import type { Venue } from "../domain/types.ts";
import { extractDealsFromText, type ExtractedDeal } from "./extract-heuristic.ts";
import { extractDealsWithModel, isModelExtractionAvailable } from "./extract-model.ts";
import { DisallowedByRobotsError, PoliteFetcher } from "./fetcher.ts";
import { findPromisingLinks, htmlToText } from "./html.ts";

export interface CrawlStats {
  venuesConsidered: number;
  venuesCrawled: number;
  pagesFetched: number;
  pagesSkipped: number;
  pagesDisallowed: number;
  dealsWritten: number;
  modelCalls: number;
  modelRefusals: number;
  errors: string[];
}

function emptyStats(): CrawlStats {
  return {
    venuesConsidered: 0,
    venuesCrawled: 0,
    pagesFetched: 0,
    pagesSkipped: 0,
    pagesDisallowed: 0,
    dealsWritten: 0,
    modelCalls: 0,
    modelRefusals: 0,
    errors: [],
  };
}

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isFresh(fetchedAt: string, maxAgeHours: number): boolean {
  // SQLite's datetime() yields "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const parsed = Date.parse(`${fetchedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed < maxAgeHours * 3600_000;
}

/** Confidence at or above this means the heuristic parse is trusted on its own. */
const HEURISTIC_TRUST_THRESHOLD = 0.6;

export interface CrawlOptions {
  fetcher?: PoliteFetcher;
  maxPagesPerVenue?: number;
  useModel?: boolean;
  /** Re-fetch pages even if a recent copy is on file. */
  force?: boolean;
  onProgress?: (message: string) => void;
}

export async function crawlVenue(
  db: DatabaseHandle,
  venue: Venue,
  options: CrawlOptions = {},
): Promise<CrawlStats> {
  const stats = emptyStats();
  stats.venuesConsidered = 1;

  if (!venue.website) return stats;

  const fetcher = options.fetcher ?? new PoliteFetcher();
  const maxPages = options.maxPagesPerVenue ?? config.scraper.maxPagesPerVenue;
  const useModel = (options.useModel ?? true) && isModelExtractionAvailable();
  const log = options.onProgress ?? (() => {});

  const queue: string[] = [venue.website];
  const visited = new Set<string>();
  const dealsForVenue: ExtractedDeal[] = [];
  let crawledAnything = false;

  while (queue.length > 0 && visited.size < maxPages) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    const cached = getScrapedPage(db, url);
    if (!options.force && cached && isFresh(cached.fetchedAt, config.scraper.refetchAfterHours)) {
      stats.pagesSkipped += 1;
      continue;
    }

    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      continue;
    }

    let html: string;
    try {
      const response = await fetcher.fetch(url);
      stats.pagesFetched += 1;
      crawledAnything = true;

      if (response.status >= 400) {
        recordScrapedPage(db, {
          url,
          host,
          venueId: venue.id,
          status: response.status,
          contentHash: null,
          textContent: null,
          error: `HTTP ${response.status}`,
        });
        continue;
      }

      const contentType = response.contentType ?? "";
      if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
        continue;
      }
      html = response.body;
    } catch (error) {
      if (error instanceof DisallowedByRobotsError) {
        stats.pagesDisallowed += 1;
        log(`robots.txt disallows ${url}`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push(`${url}: ${message}`);
      recordScrapedPage(db, {
        url,
        host,
        venueId: venue.id,
        status: null,
        contentHash: null,
        textContent: null,
        error: message,
      });
      continue;
    }

    const text = htmlToText(html);
    recordScrapedPage(db, {
      url,
      host,
      venueId: venue.id,
      status: 200,
      contentHash: hashContent(text),
      textContent: text.slice(0, 100_000),
      error: null,
    });

    const heuristic = extractDealsFromText(text);
    dealsForVenue.push(...heuristic);

    const confident = heuristic.some((deal) => deal.confidence >= HEURISTIC_TRUST_THRESHOLD);
    const mentionsDeals = /happy hour|specials?|deals?/i.test(text);

    // Only spend a model call where it can actually help: the page talks about
    // deals but the parser came away without a confident window.
    if (useModel && !confident && mentionsDeals) {
      try {
        stats.modelCalls += 1;
        const result = await extractDealsWithModel({
          venueName: venue.name,
          timeZone: venue.timeZone,
          url,
          pageText: text,
        });
        if (result.refusal) {
          stats.modelRefusals += 1;
          log(`model declined ${url}: ${result.refusal}`);
        }
        dealsForVenue.push(...result.deals);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.errors.push(`model ${url}: ${message}`);
      }
    }

    // Only expand from the entry page; deeper crawling wanders off into blogs.
    if (visited.size === 1) {
      for (const link of findPromisingLinks(html, url)) {
        if (queue.length + visited.size >= maxPages) break;
        if (!visited.has(link.url)) queue.push(link.url);
      }
    }
  }

  if (crawledAnything) stats.venuesCrawled = 1;

  for (const deal of dedupeDeals(dealsForVenue)) {
    upsertDeal(db, {
      venueId: venue.id,
      title: deal.title,
      description: deal.description,
      priceText: deal.priceText,
      category: deal.category,
      finePrint: deal.finePrint,
      confidence: deal.confidence,
      sourceUrl: venue.website,
      extractedBy: deal.confidence >= HEURISTIC_TRUST_THRESHOLD ? "heuristic" : "model",
      windows: deal.windows,
      lastVerifiedAt: new Date().toISOString(),
    });
    stats.dealsWritten += 1;
  }

  return stats;
}

/**
 * The same happy hour usually appears on several pages of a site. Collapse by
 * schedule and title, keeping the highest-confidence copy of each.
 */
function dedupeDeals(deals: ExtractedDeal[]): ExtractedDeal[] {
  const byKey = new Map<string, ExtractedDeal>();

  for (const deal of deals) {
    const key = `${deal.title.toLowerCase()}|${deal.windows
      .map((w) => `${w.dayOfWeek}:${w.startMin}:${w.endMin}`)
      .sort()
      .join(",")}`;
    const existing = byKey.get(key);
    if (!existing || deal.confidence > existing.confidence) {
      byKey.set(key, deal);
    }
  }

  return [...byKey.values()];
}

function mergeStats(total: CrawlStats, next: CrawlStats): void {
  total.venuesConsidered += next.venuesConsidered;
  total.venuesCrawled += next.venuesCrawled;
  total.pagesFetched += next.pagesFetched;
  total.pagesSkipped += next.pagesSkipped;
  total.pagesDisallowed += next.pagesDisallowed;
  total.dealsWritten += next.dealsWritten;
  total.modelCalls += next.modelCalls;
  total.modelRefusals += next.modelRefusals;
  total.errors.push(...next.errors);
}

export async function crawlVenues(
  db: DatabaseHandle,
  venues: readonly Venue[],
  options: CrawlOptions = {},
): Promise<CrawlStats> {
  const total = emptyStats();
  // One shared fetcher so the crawl-delay bookkeeping spans the whole run —
  // several venues can share a host (a small chain, or a shared CMS).
  const fetcher = options.fetcher ?? new PoliteFetcher();

  for (const venue of venues) {
    const stats = await crawlVenue(db, venue, { ...options, fetcher });
    mergeStats(total, stats);
    options.onProgress?.(
      `${venue.name}: ${stats.pagesFetched} pages, ${stats.dealsWritten} deals`,
    );
  }

  return total;
}

export function saveDiscoveredVenues(
  db: DatabaseHandle,
  venues: readonly VenueInput[],
): Venue[] {
  const saved: Venue[] = [];
  for (const venue of venues) {
    const id = upsertVenue(db, venue);
    saved.push({ ...venue, id } as Venue);
  }
  return saved;
}
