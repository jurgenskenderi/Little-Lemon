import type { FastifyInstance } from "fastify";

import { getDealsForVenue, getVenue, type DatabaseHandle } from "../db/index.ts";
import { serializeDeal, serializeVenue } from "./serialize.ts";

export function registerVenueRoutes(app: FastifyInstance, db: DatabaseHandle): void {
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
