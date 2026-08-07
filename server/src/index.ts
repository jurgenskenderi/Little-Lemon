import Fastify from "fastify";
import { z } from "zod";

import { config } from "./config.ts";
import { openDatabase } from "./db/index.ts";
import { kilometersToMeters } from "./domain/geo.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerDealRoutes } from "./routes/deals.ts";
import { registerVenueRoutes } from "./routes/venues.ts";
import { discoverVenues } from "./scraper/discover.ts";
import { isModelExtractionAvailable } from "./scraper/extract-model.ts";
import { crawlVenues, saveDiscoveredVenues } from "./scraper/pipeline.ts";

const db = openDatabase(config.databaseFile);
const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

// The mobile client is not browser-based, but the same API backs a web preview
// during development, and a bare hook beats another dependency.
app.addHook("onRequest", async (request, reply) => {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-headers", "content-type, authorization");
  reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") {
    return reply.code(204).send();
  }
});

app.get("/api/health", async () => {
  const venues = db.prepare("SELECT COUNT(*) AS n FROM venues").get() as { n: number };
  const deals = db.prepare("SELECT COUNT(*) AS n FROM deals").get() as { n: number };
  return {
    status: "ok",
    venues: venues.n,
    deals: deals.n,
    modelExtraction: isModelExtractionAvailable() ? "enabled" : "disabled",
  };
});

registerDealRoutes(app, db);
registerVenueRoutes(app, db);
registerAdminRoutes(app, db);

const scrapeBody = z.object({
  lat: z.number(),
  lon: z.number(),
  radiusKm: z.number().positive().max(30).default(3),
  timeZone: z.string().min(1).default("America/Toronto"),
  limit: z.number().int().positive().max(200).default(25),
});

/**
 * Kicks off a crawl. Guarded by ADMIN_TOKEN and disabled entirely when that is
 * unset, because it makes this server issue outbound requests on demand.
 */
app.post("/api/admin/scrape", async (request, reply) => {
  if (!config.adminToken) {
    return reply.code(404).send({ error: "scrape_endpoint_disabled" });
  }
  const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (provided !== config.adminToken) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  const parsed = scrapeBody.safeParse(request.body);
  if (!parsed.success) {
    return reply
      .code(400)
      .send({ error: "invalid_body", details: z.flattenError(parsed.error).fieldErrors });
  }

  const params = parsed.data;

  // A crawl runs for minutes under the polite delay, so it can't be awaited
  // inside the request. The response acknowledges the start; progress goes to
  // the server log.
  void (async () => {
    try {
      const discovered = await discoverVenues({
        lat: params.lat,
        lon: params.lon,
        radiusM: kilometersToMeters(params.radiusKm),
        timeZone: params.timeZone,
        limit: params.limit,
      });
      const venues = saveDiscoveredVenues(db, discovered);
      const stats = await crawlVenues(db, venues, {
        onProgress: (message) => app.log.info(message),
      });
      app.log.info({ stats }, "crawl finished");
    } catch (error) {
      app.log.error({ err: error }, "crawl failed");
    }
  })();

  return reply.code(202).send({ status: "started", area: params });
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}

await start();
