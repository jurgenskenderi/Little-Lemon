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
  replaceCrawledDeals,
  upsertVenue,
  type DatabaseHandle,
  type VenueInput,
} from "../db/index.ts";
import type { Venue } from "../domain/types.ts";
import { extractDealsFromText, type ExtractedDeal } from "./extract-heuristic.ts";
import { extractDealsWithModel, isModelExtractionAvailable } from "./extract-model.ts";
import { DisallowedByRobotsError, PoliteFetcher } from "./fetcher.ts";
import { bestImage, findPromisingLinks, findSocialLinks, htmlToText } from "./html.ts";

export interface CrawlStats {
  venuesConsidered: number;
  venuesCrawled: number;
  pagesFetched: number;
  pagesSkipped: number;
  pagesDisallowed: number;
  /** Social profiles found. Most refuse crawlers; we link to them instead. */
  socialsFound: number;
  socialsCrawled: number;
  /** network -> profile URL for the venue just crawled. */
  socials?: Map<string, string>;
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
    socialsFound: 0,
    socialsCrawled: 0,
    dealsWritten: 0,
    modelCalls: 0,
    modelRefusals: 0,
    errors: [],
  };
}

/** Extra fetches allowed beyond the per-venue budget, for link-in-bio hosts. */
const SOCIAL_PAGE_BUDGET = 2;

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
  // A link-in-bio page is one extra fetch on someone else's host, so it gets
  // its own small allowance rather than eating the venue's page budget.
  const pageCeiling = maxPages + SOCIAL_PAGE_BUDGET;
  const useModel = (options.useModel ?? true) && isModelExtractionAvailable();
  const log = options.onProgress ?? (() => {});

  const queue: string[] = [venue.website];
  const visited = new Set<string>();
  /** network -> profile URL, for the app to link even when crawling is refused. */
  const socials = new Map<string, string>();
  const dealsForVenue: Array<ExtractedDeal & { imageUrl: string | null }> = [];
  let crawledAnything = false;
  // Falls back to the entry page's photo when a deal page carries none of
  // its own — a venue's social image is still better than a blank card.
  let venueImage: string | null = null;

  while (queue.length > 0 && visited.size < pageCeiling) {
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

    const pageImage = bestImage(html, url);
    venueImage ??= pageImage;

    const heuristic = extractDealsFromText(text);
    dealsForVenue.push(...heuristic.map((deal) => ({ ...deal, imageUrl: pageImage })));

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
        dealsForVenue.push(...result.deals.map((deal) => ({ ...deal, imageUrl: pageImage })));
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

      // Plenty of small bars put nothing on their own site and everything on
      // Instagram or a link-in-bio page. Record every social profile so the
      // app can link to it, and queue only the hosts that permit crawling —
      // Instagram and Facebook do not, and the fetcher would refuse anyway.
      for (const social of findSocialLinks(html, url)) {
        stats.socialsFound += 1;
        socials.set(social.network, social.url);
        if (!social.crawlable) continue;
        if (queue.length + visited.size >= maxPages + SOCIAL_PAGE_BUDGET) break;
        if (!visited.has(social.url)) {
          queue.push(social.url);
          stats.socialsCrawled += 1;
        }
      }
    }
  }

  if (crawledAnything) stats.venuesCrawled = 1;
  stats.socials = socials;

  // Only rewrite this venue's deals if we actually reached its site. A failed
  // crawl must not be read as "this venue has no deals any more".
  if (crawledAnything) {
    const now = new Date().toISOString();
    const written = replaceCrawledDeals(
      db,
      venue.id,
      dedupeDeals(dealsForVenue).map((deal) => ({
        title: deal.title,
        description: deal.description,
        priceText: deal.priceText,
        category: deal.category,
        finePrint: deal.finePrint,
        confidence: deal.confidence,
        sourceUrl: venue.website,
        extractedBy: deal.confidence >= HEURISTIC_TRUST_THRESHOLD ? "heuristic" : "model",
        imageUrl: deal.imageUrl ?? venueImage,
        windows: deal.windows,
        lastVerifiedAt: now,
      })),
    );
    stats.dealsWritten += written.length;
  }

  return stats;
}

/**
 * The same happy hour usually appears on several pages of a site. Collapse by
 * schedule and title, keeping the highest-confidence copy of each.
 */
function dedupeDeals<T extends ExtractedDeal>(deals: T[]): T[] {
  const byKey = new Map<string, T>();

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
