import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { config } from "../config.ts";
import { searchDeals, type DatabaseHandle } from "../db/index.ts";
import { isValidCoordinate, kilometersToMeters, milesToMeters } from "../domain/geo.ts";
import { serializeDealResult } from "./serialize.ts";

const searchQuery = z.object({
  lat: z.coerce.number(),
  lon: z.coerce.number(),
  // Accepts metres, kilometres, or miles. The app sends km (Canada is metric);
  // the others are kept so the API is usable from anywhere.
  radiusM: z.coerce.number().positive().max(config.search.maxRadiusM).optional(),
  radiusKm: z.coerce.number().positive().max(60).optional(),
  radiusMi: z.coerce.number().positive().max(40).optional(),
  /** ISO instant the user is asking about. Defaults to now. */
  at: z.iso.datetime({ offset: true }).optional(),
  /** How far past `at` to look, in minutes. 0 means "open right at that moment". */
  windowMin: z.coerce.number().int().min(0).max(1440).default(0),
  category: z.enum(["drink", "food", "both"]).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  sort: z.enum(["best", "distance", "soonest"]).default("best"),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().positive().max(config.search.maxLimit).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerDealRoutes(app: FastifyInstance, db: DatabaseHandle): void {
  app.get("/api/deals", async (request, reply) => {
    const parsed = searchQuery.safeParse(request.query);
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

    const at = params.at ? new Date(params.at) : new Date();
    if (Number.isNaN(at.getTime())) {
      return reply.code(400).send({ error: "invalid_at" });
    }

    const limit = params.limit ?? config.search.defaultLimit;

    const results = searchDeals(db, {
      lat: params.lat,
      lon: params.lon,
      radiusM: Math.min(radiusM, config.search.maxRadiusM),
      at,
      windowMin: params.windowMin,
      category: params.category,
      query: params.q,
      sort: params.sort,
      minConfidence: params.minConfidence,
      limit,
      offset: params.offset,
    });

    return {
      query: {
        lat: params.lat,
        lon: params.lon,
        radiusM: Math.round(radiusM),
        at: at.toISOString(),
        windowMin: params.windowMin,
        sort: params.sort,
      },
      count: results.length,
      deals: results.map(serializeDealResult),
    };
  });
}
