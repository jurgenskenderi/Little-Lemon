import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { config } from "../config.ts";
import {
  getDealsForVenue,
  getVenue,
  searchVenues,
  type DatabaseHandle,
} from "../db/index.ts";
import { isValidCoordinate, kilometersToMeters, milesToMeters } from "../domain/geo.ts";
import { serializeDeal, serializeNearbyVenue, serializeVenue } from "./serialize.ts";

const nearbyQuery = z.object({
  lat: z.coerce.number(),
  lon: z.coerce.number(),
  radiusM: z.coerce.number().positive().max(config.search.maxRadiusM).optional(),
  radiusKm: z.coerce.number().positive().max(60).optional(),
  radiusMi: z.coerce.number().positive().max(40).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  /** Only the venues we hold no deals for. */
  withoutDeals: z.stringbool().default(false),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export function registerVenueRoutes(app: FastifyInstance, db: DatabaseHandle): void {
  /**
   * Every venue near a point, with or without deals.
   *
   * `/api/deals` answers "what is on near me". This answers "what is near me at
   * all", which is what an imported-but-not-yet-crawled city can honestly show.
   */
  app.get("/api/places", async (request, reply) => {
    const parsed = nearbyQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_query",
        details: z.flattenError(parsed.error).fieldErrors,
      });
    }

    const params = parsed.data;
    if (!isValidCoordinate({ lat: params.lat, lon: params.lon })) {
      return reply.code(400).send({
        error: "invalid_coordinates",
        message: "lat must be between -90 and 90, lon between -180 and 180.",
      });
    }

    const radiusM =
      params.radiusM ??
      (params.radiusKm !== undefined
        ? kilometersToMeters(params.radiusKm)
        : params.radiusMi !== undefined
          ? milesToMeters(params.radiusMi)
          : config.search.defaultRadiusM);

    const places = searchVenues(db, {
      lat: params.lat,
      lon: params.lon,
      radiusM,
      q: params.q,
      withoutDealsOnly: params.withoutDeals,
      limit: params.limit,
    });

    return {
      places: places.map(serializeNearbyVenue),
      // Google requires visible attribution wherever their Places content is
      // shown. The client renders whatever this says rather than hard-coding a
      // provider it may not be using.
      attribution: places.some((place) => place.venue.source === "google_places")
        ? "Powered by Google"
        : null,
    };
  });

  app.get<{ Params: { id: string } }>("/api/venues/:id", async (request, reply) => {
    const venue = getVenue(db, request.params.id);
    if (!venue) {
      return reply.code(404).send({ error: "venue_not_found" });
    }
    return {
      venue: serializeVenue(venue),
      deals: getDealsForVenue(db, venue.id).map(serializeDeal),
    };
  });
}
