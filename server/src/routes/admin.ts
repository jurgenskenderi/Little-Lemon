/**
 * Admin surface for deals you negotiate directly with a venue.
 *
 * These are entered by hand, marked `partner`, ranked above scraped results,
 * and protected from being overwritten by a later crawl of the venue's site.
 * Everything here requires ADMIN_TOKEN; the whole surface 404s when it is unset.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { config } from "../config.ts";
import {
  countPartnerDeals,
  deleteDeal,
  deleteVenue,
  getDealsForVenue,
  listVenues,
  upsertDeal,
  upsertVenue,
  type DatabaseHandle,
} from "../db/index.ts";
import { isValidCoordinate } from "../domain/geo.ts";
import { MINUTES_PER_DAY, type DayOfWeek } from "../domain/time.ts";
import { serializeDeal, serializeVenue } from "./serialize.ts";
import { ADMIN_PAGE_HTML } from "./admin-page.ts";

/** "16:30" -> 990. Rejects anything that is not a real clock time. */
function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

const clockString = z.string().regex(/^\d{1,2}:\d{2}$/, "Use 24-hour HH:MM, e.g. 16:30");

const venueBody = z.object({
  id: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(200),
  address: z.string().max(200).nullish(),
  city: z.string().max(100).default("Toronto"),
  region: z.string().max(100).default("ON"),
  country: z.string().max(100).default("CA"),
  lat: z.number(),
  lon: z.number(),
  timeZone: z.string().min(1).default("America/Toronto"),
  website: z.string().url().nullish(),
  phone: z.string().max(40).nullish(),
});

const dealBody = z.object({
  id: z.string().min(1).max(120).optional(),
  venueId: z.string().min(1),
  title: z.string().min(1).max(120),
  description: z.string().max(400).nullish(),
  priceText: z.string().max(80).nullish(),
  category: z.enum(["drink", "food", "both"]).default("both"),
  finePrint: z.string().max(200).nullish(),
  /** 0 = Sunday. */
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start: clockString,
  end: clockString,
});

export function registerAdminRoutes(app: FastifyInstance, db: DatabaseHandle): void {
  /** Returns true when the request may proceed; sends the response if not. */
  const authorize = (
    request: { headers: Record<string, unknown> },
    reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  ): boolean => {
    if (!config.adminToken) {
      reply.code(404).send({ error: "admin_disabled", message: "Set ADMIN_TOKEN to enable." });
      return false;
    }
    const header = request.headers["authorization"];
    const provided =
      typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : undefined;
    if (provided !== config.adminToken) {
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  // The console is a plain page; it asks for the token and calls the API below.
  app.get("/admin", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(ADMIN_PAGE_HTML);
  });

  app.get("/api/admin/summary", async (request, reply) => {
    if (!authorize(request, reply)) return;
    const venues = db.prepare("SELECT COUNT(*) AS n FROM venues").get() as { n: number };
    const deals = db.prepare("SELECT COUNT(*) AS n FROM deals").get() as { n: number };
    return {
      venues: venues.n,
      deals: deals.n,
      partnerDeals: countPartnerDeals(db),
    };
  });

  app.get<{ Querystring: { q?: string } }>("/api/admin/venues", async (request, reply) => {
    if (!authorize(request, reply)) return;
    const venues = listVenues(db, { query: request.query.q });
    return {
      venues: venues.map((venue) => ({
        ...serializeVenue(venue),
        deals: getDealsForVenue(db, venue.id).map(serializeDeal),
      })),
    };
  });

  app.post("/api/admin/venues", async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = venueBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_venue", details: z.flattenError(parsed.error).fieldErrors });
    }
    const venue = parsed.data;
    if (!isValidCoordinate({ lat: venue.lat, lon: venue.lon })) {
      return reply.code(400).send({ error: "invalid_coordinates" });
    }

    const id = upsertVenue(db, {
      id: venue.id,
      name: venue.name,
      address: venue.address ?? null,
      city: venue.city,
      region: venue.region,
      country: venue.country,
      lat: venue.lat,
      lon: venue.lon,
      timeZone: venue.timeZone,
      website: venue.website ?? null,
      phone: venue.phone ?? null,
      source: "partner",
      sourceId: null,
    });

    return reply.code(201).send({ id });
  });

  app.delete<{ Params: { id: string } }>("/api/admin/venues/:id", async (request, reply) => {
    if (!authorize(request, reply)) return;
    return deleteVenue(db, request.params.id)
      ? { deleted: true }
      : reply.code(404).send({ error: "venue_not_found" });
  });

  app.post("/api/admin/deals", async (request, reply) => {
    if (!authorize(request, reply)) return;

    const parsed = dealBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_deal", details: z.flattenError(parsed.error).fieldErrors });
    }
    const deal = parsed.data;

    const startMin = parseClock(deal.start);
    const endRaw = parseClock(deal.end);
    if (startMin === null || endRaw === null) {
      return reply.code(400).send({ error: "invalid_time", message: "Use 24-hour HH:MM." });
    }
    if (startMin === endRaw) {
      return reply
        .code(400)
        .send({ error: "invalid_time", message: "Start and end cannot be the same." });
    }

    // An end at or before the start means the deal runs past midnight, which is
    // stored as minutes past the opening day's midnight rather than wrapping.
    const endMin = endRaw < startMin ? endRaw + MINUTES_PER_DAY : endRaw;

    const venue = listVenues(db).find((candidate) => candidate.id === deal.venueId);
    if (!venue) {
      return reply.code(400).send({ error: "venue_not_found", venueId: deal.venueId });
    }

    const id = upsertDeal(db, {
      id: deal.id,
      venueId: deal.venueId,
      title: deal.title,
      description: deal.description ?? null,
      priceText: deal.priceText ?? null,
      category: deal.category,
      finePrint: deal.finePrint ?? null,
      // Entered by hand from an agreement, so it is not a guess.
      confidence: 1,
      sourceUrl: venue.website,
      extractedBy: "manual",
      partner: true,
      windows: [...new Set(deal.days)].map((day) => ({
        dayOfWeek: day as DayOfWeek,
        startMin,
        endMin,
      })),
      lastVerifiedAt: new Date().toISOString(),
    });

    return reply.code(201).send({ id });
  });

  app.delete<{ Params: { id: string } }>("/api/admin/deals/:id", async (request, reply) => {
    if (!authorize(request, reply)) return;
    return deleteDeal(db, request.params.id)
      ? { deleted: true }
      : reply.code(404).send({ error: "deal_not_found" });
  });
}
