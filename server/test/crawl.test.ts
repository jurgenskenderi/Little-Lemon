/**
 * End-to-end crawl against a local fixture site.
 *
 * This exercises the real pipeline — fetcher, robots.txt, link discovery, HTML
 * extraction, heuristic parsing, and the database write — without touching a
 * third party's servers. The fixture deliberately includes the things that
 * break naive crawlers: a robots.txt exclusion, a page that only lists opening
 * hours, and a deal that runs past midnight.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { getDealsForVenue, openDatabase, upsertVenue, type DatabaseHandle } from "../src/db/index.ts";
import type { Venue } from "../src/domain/types.ts";
import { PoliteFetcher } from "../src/scraper/fetcher.ts";
import { crawlVenue } from "../src/scraper/pipeline.ts";

const PAGES: Record<string, { type: string; body: string }> = {
  "/robots.txt": {
    type: "text/plain",
    body: ["User-agent: *", "Disallow: /private", ""].join("\n"),
  },
  "/": {
    type: "text/html",
    body: `<!doctype html><html><head><title>The Alder &amp; Oak</title></head>
      <body>
        <h1>The Alder &amp; Oak</h1>
        <p>Open Mon-Sun 11am-11pm. Kitchen closes at 10.</p>
        <nav>
          <a href="/happy-hour">Happy Hour</a>
          <a href="/private/staff">Staff area</a>
          <a href="/about">About us</a>
        </nav>
      </body></html>`,
  },
  "/happy-hour": {
    type: "text/html",
    body: `<!doctype html><html><head>
        <meta property="og:image" content="/photos/happy-hour-spread.jpg">
      </head><body>
        <h2>Happy Hour</h2>
        <p>Happy Hour Mon-Fri 4-6pm: $6 local pints and half off shared plates.</p>
        <p>Late Night Happy Hour Fri &amp; Sat 10pm-2am, $5 draught.</p>
        <p>Bar area only. Excludes holidays.</p>
      </body></html>`,
  },
  "/private/staff": {
    type: "text/html",
    body: "<html><body><p>Happy hour Mon-Fri 9am-10am, $1 coffee.</p></body></html>",
  },
  "/about": {
    type: "text/html",
    body: "<html><body><p>We opened in 2011 on Queen Street.</p></body></html>",
  },
};

describe("crawlVenue against a fixture site", () => {
  let server: Server;
  let origin: string;
  let db: DatabaseHandle;
  let venue: Venue;
  const requested: string[] = [];

  before(async () => {
    server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      requested.push(path);
      const page = PAGES[path];
      if (!page) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": page.type });
      response.end(page.body);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;

    db = openDatabase(":memory:");
    upsertVenue(db, {
      id: "ven_fixture",
      name: "The Alder & Oak",
      address: "412 Queen St W",
      city: "Toronto",
      region: "ON",
      country: "CA",
      lat: 43.6479,
      lon: -79.3968,
      timeZone: "America/Toronto",
      website: origin,
      phone: null,
      source: "test",
      sourceId: "fixture",
    });
    venue = { ...(getVenueOrThrow(db, "ven_fixture")) };

    await crawlVenue(db, venue, {
      // No delay against our own loopback server; the delay logic itself is
      // covered by the fetcher's own behaviour, not by making tests slow.
      fetcher: new PoliteFetcher({ minDelayMs: 0, timeoutMs: 5000 }),
      useModel: false,
    });
  });

  after(async () => {
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches robots.txt before any page", () => {
    assert.equal(requested[0], "/robots.txt", "politeness is not an afterthought");
  });

  it("follows the happy hour link found on the homepage", () => {
    assert.ok(requested.includes("/happy-hour"));
  });

  it("does not fetch a path robots.txt disallows", () => {
    assert.ok(
      !requested.includes("/private/staff"),
      "the disallowed page must never be requested, not merely discarded",
    );
  });

  it("does not follow links with no deal signal", () => {
    assert.ok(!requested.includes("/about"));
  });

  it("extracts both happy hours with the right schedules", () => {
    const deals = getDealsForVenue(db, "ven_fixture");
    const titles = deals.map((deal) => deal.title);
    assert.ok(titles.includes("Happy Hour"), `got ${JSON.stringify(titles)}`);

    const weekday = deals.find((deal) =>
      deal.windows.some((window) => window.startMin === 960 && window.endMin === 1080),
    );
    assert.ok(weekday, "Mon-Fri 4-6pm");
    assert.deepEqual(
      weekday.windows.map((window) => window.dayOfWeek).sort(),
      [1, 2, 3, 4, 5],
    );

    const lateNight = deals.find((deal) =>
      deal.windows.some((window) => window.endMin > 1440),
    );
    assert.ok(lateNight, "the 10pm-2am window survives as a past-midnight window");
    assert.deepEqual(
      lateNight.windows.map((window) => window.dayOfWeek).sort(),
      [5, 6],
      "Fri & Sat",
    );
  });

  it("does not turn opening hours into a deal", () => {
    const deals = getDealsForVenue(db, "ven_fixture");
    assert.ok(
      !deals.some((deal) => deal.windows.some((window) => window.startMin === 660)),
      "11am-11pm is when the door is open, not a happy hour",
    );
  });

  it("carries the page's photo through to the stored deal", () => {
    const deals = getDealsForVenue(db, "ven_fixture");
    assert.ok(deals.length > 0);
    assert.ok(
      deals.every((deal) => deal.imageUrl?.endsWith("/photos/happy-hour-spread.jpg")),
      `got ${JSON.stringify(deals.map((deal) => deal.imageUrl))}`,
    );
  });

  it("marks crawled deals as non-partner", () => {
    const deals = getDealsForVenue(db, "ven_fixture");
    assert.ok(deals.length > 0);
    assert.ok(deals.every((deal) => deal.partner === false));
  });
});

function getVenueOrThrow(db: DatabaseHandle, id: string): Venue {
  const row = db.prepare(`SELECT * FROM venues WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`fixture venue ${id} missing`);
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    address: row["address"] as string | null,
    city: row["city"] as string | null,
    region: row["region"] as string | null,
    country: row["country"] as string | null,
    lat: row["lat"] as number,
    lon: row["lon"] as number,
    timeZone: row["time_zone"] as string,
    website: row["website"] as string | null,
    phone: row["phone"] as string | null,
    source: row["source"] as string,
    sourceId: row["source_id"] as string | null,
  };
}
