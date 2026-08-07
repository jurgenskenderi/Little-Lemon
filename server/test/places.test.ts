/**
 * The Google Places import, against a local fixture standing in for the API.
 *
 * The parts worth testing are the ones that cost money or break silently: the
 * 20-result cap that makes a busy circle lie to you, deduplication across the
 * quadrants we split it into, the cache window Google's terms impose, and
 * whether an auth failure stops the run or burns a request per area learning
 * the same thing fifteen times.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { openDatabase, searchVenues, upsertVenue, type DatabaseHandle } from "../src/db/index.ts";
import { importPlaces, countStalePlaces } from "../src/places/import.ts";
import { searchArea, toDiscovered, PlacesError } from "../src/places/google.ts";

interface Recorded {
  radius: number;
  lat: number;
  lon: number;
}

let server: Server;
let requests: Recorded[] = [];
/** Set per test to control what the fake API does. */
let handler: (body: any) => { status: number; payload: unknown } = () => ({
  status: 200,
  payload: { places: [] },
});

function place(id: string, name: string, lat: number, lon: number, extra: object = {}) {
  return {
    id,
    displayName: { text: name },
    formattedAddress: `${id} Queen St W, Toronto, ON M6J 1E4, Canada`,
    location: { latitude: lat, longitude: lon },
    primaryType: "bar",
    types: ["bar", "restaurant"],
    businessStatus: "OPERATIONAL",
    ...extra,
  };
}

before(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const circle = body.locationRestriction?.circle;
      requests.push({
        radius: circle?.radius,
        lat: circle?.center?.latitude,
        lon: circle?.center?.longitude,
      });
      const { status, payload } = handler(body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env["GOOGLE_PLACES_ENDPOINT"] = `http://127.0.0.1:${port}/v1/places:searchNearby`;
});

after(() => server.close());

function freshDb(): DatabaseHandle {
  requests = [];
  return openDatabase(":memory:");
}

const AREA = { name: "Queen West", lat: 43.6479, lon: -79.3968, radiusM: 1200 };

describe("mapping a Places response", () => {
  it("splits a formatted address into its parts", () => {
    const mapped = toDiscovered(place("abc", "The Alder", 43.6479, -79.3968), "America/Toronto");
    assert.ok(mapped);
    assert.equal(mapped.venue.name, "The Alder");
    assert.equal(mapped.venue.address, "abc Queen St W");
    assert.equal(mapped.venue.city, "Toronto");
    assert.equal(mapped.venue.region, "ON");
    assert.equal(mapped.venue.country, "Canada");
    assert.equal(mapped.venue.source, "google_places");
    assert.equal(mapped.venue.sourceId, "abc");
  });

  it("drops a place that has closed down", () => {
    const closed = place("gone", "The Departed", 43.65, -79.4, {
      businessStatus: "CLOSED_PERMANENTLY",
    });
    assert.equal(toDiscovered(closed, "America/Toronto"), null);
  });

  it("translates the price level enum to a number", () => {
    const mapped = toDiscovered(
      place("p", "Pricey", 43.65, -79.4, { priceLevel: "PRICE_LEVEL_EXPENSIVE", rating: 4.4 }),
      "America/Toronto",
    );
    assert.equal(mapped?.details.priceLevel, 3);
    assert.equal(mapped?.details.rating, 4.4);
  });

  it("rejects a junk website rather than storing it", () => {
    const mapped = toDiscovered(
      place("w", "Odd", 43.65, -79.4, { websiteUri: "javascript:alert(1)" }),
      "America/Toronto",
    );
    assert.equal(mapped?.venue.website, null);
  });

  it("keeps a website that omits its scheme", () => {
    const mapped = toDiscovered(
      place("w2", "Bare", 43.65, -79.4, { websiteUri: "alderandoak.example" }),
      "America/Toronto",
    );
    assert.equal(mapped?.venue.website, "https://alderandoak.example/");
  });
});

describe("the 20-result cap", () => {
  it("splits a circle that came back full, and dedupes the overlap", async () => {
    requests = [];
    // A full first response, then four short ones. Two of the quadrants return
    // a place the parent circle already gave us.
    let call = 0;
    handler = () => {
      call += 1;
      if (call === 1) {
        return {
          status: 200,
          payload: {
            places: Array.from({ length: 20 }, (_, i) =>
              place(`p${i}`, `Bar ${i}`, 43.6479 + i * 0.0001, -79.3968),
            ),
          },
        };
      }
      return {
        status: 200,
        payload: {
          places: [
            place("p0", "Bar 0", 43.6479, -79.3968),
            place(`extra${call}`, `Extra ${call}`, 43.6481, -79.397),
          ],
        },
      };
    };

    const found = await searchArea({ ...AREA, timeZone: "America/Toronto", apiKey: "k" });

    assert.equal(requests.length, 5, "one full circle plus four quadrants");
    // 20 originals + 4 distinct extras; p0 came back four more times and was
    // counted once.
    assert.equal(found.length, 24);
    assert.equal(new Set(found.map((f) => f.details.placeId)).size, 24);
  });

  it("does not split a circle that came back short", async () => {
    requests = [];
    handler = () => ({
      status: 200,
      payload: { places: [place("only", "The Only One", 43.6479, -79.3968)] },
    });

    const found = await searchArea({ ...AREA, timeZone: "America/Toronto", apiKey: "k" });
    assert.equal(requests.length, 1);
    assert.equal(found.length, 1);
  });

  it("stops splitting at the depth limit", async () => {
    requests = [];
    // Always full: without a depth limit this would recurse forever.
    handler = () => ({
      status: 200,
      payload: {
        places: Array.from({ length: 20 }, (_, i) =>
          place(`d${i}`, `Bar ${i}`, 43.6479, -79.3968 + i * 0.0001),
        ),
      },
    });

    await searchArea({ ...AREA, timeZone: "America/Toronto", apiKey: "k", maxDepth: 1 });
    assert.equal(requests.length, 5, "the root plus one level of four");
    // Each level halves the radius.
    assert.equal(requests[0]?.radius, 1200);
    assert.equal(requests[1]?.radius, 600);
  });
});

describe("errors", () => {
  it("explains a 403 instead of relaying it", async () => {
    handler = () => ({
      status: 403,
      payload: { error: { message: "Places API has not been used in project 123" } },
    });

    await assert.rejects(
      () => searchArea({ ...AREA, timeZone: "America/Toronto", apiKey: "k" }),
      (error: unknown) => {
        assert.ok(error instanceof PlacesError);
        assert.equal(error.status, 403);
        assert.match(error.hint ?? "", /billing/i);
        return true;
      },
    );
  });

  it("refuses to run without a key, before making a request", async () => {
    requests = [];
    await assert.rejects(
      () => searchArea({ ...AREA, timeZone: "America/Toronto", apiKey: "" }),
      /GOOGLE_MAPS_API_KEY/,
    );
    assert.equal(requests.length, 0);
  });

  it("gives up on the whole import after an auth failure", async () => {
    const db = freshDb();
    handler = () => ({ status: 401, payload: { error: { message: "bad key" } } });

    const areas = Array.from({ length: 5 }, (_, i) => ({ ...AREA, name: `Area ${i}` }));
    const result = await importPlaces(db, {
      areas,
      timeZone: "America/Toronto",
      apiKey: "k",
    });

    assert.equal(requests.length, 1, "one request, not one per area");
    assert.equal(result.errors.length, 1);
    assert.equal(result.written, 0);
    db.close();
  });

  it("carries on past a single area failing", async () => {
    const db = freshDb();
    let call = 0;
    handler = () => {
      call += 1;
      if (call === 1) return { status: 429, payload: { error: { message: "slow down" } } };
      return { status: 200, payload: { places: [place("ok", "Survivor", 43.6479, -79.3968)] } };
    };

    const result = await importPlaces(db, {
      areas: [
        { ...AREA, name: "Fails" },
        { ...AREA, name: "Works" },
      ],
      timeZone: "America/Toronto",
      apiKey: "k",
    });

    assert.equal(result.errors.length, 1);
    assert.equal(result.areasSearched, 1);
    assert.equal(result.written, 1);
    db.close();
  });
});

describe("writing to the database", () => {
  it("stores places and marks when they were refreshed", async () => {
    const db = freshDb();
    handler = () => ({
      status: 200,
      payload: {
        places: [
          place("a", "The Alder", 43.6479, -79.3968, { rating: 4.5, userRatingCount: 210 }),
          place("b", "The Oak", 43.648, -79.397, { websiteUri: "https://oak.example" }),
        ],
      },
    });

    const result = await importPlaces(db, {
      areas: [AREA],
      timeZone: "America/Toronto",
      apiKey: "k",
    });

    assert.equal(result.discovered, 2);
    assert.equal(result.written, 2);
    assert.equal(result.withWebsite, 1);

    const nearby = searchVenues(db, { lat: 43.6479, lon: -79.3968, radiusM: 500 });
    assert.equal(nearby.length, 2);
    const alder = nearby.find((n) => n.venue.name === "The Alder");
    assert.equal(alder?.venue.rating, 4.5);
    assert.equal(alder?.venue.ratingCount, 210);
    assert.deepEqual(alder?.venue.placeTypes, ["bar", "restaurant"]);
    assert.ok(alder?.venue.placeRefreshedAt, "refresh time is stamped");
    assert.equal(alder?.dealCount, 0);
    assert.equal(countStalePlaces(db), 0);
    db.close();
  });

  it("skips a place still inside its cache window", async () => {
    const db = freshDb();
    handler = () => ({
      status: 200,
      payload: { places: [place("a", "The Alder", 43.6479, -79.3968)] },
    });

    const first = await importPlaces(db, { areas: [AREA], timeZone: "America/Toronto", apiKey: "k" });
    assert.equal(first.written, 1);

    const second = await importPlaces(db, { areas: [AREA], timeZone: "America/Toronto", apiKey: "k" });
    assert.equal(second.written, 0);
    assert.equal(second.skippedFresh, 1);
    db.close();
  });

  it("re-writes a place whose copy has aged past the terms", async () => {
    const db = freshDb();
    handler = () => ({
      status: 200,
      payload: { places: [place("a", "The Alder", 43.6479, -79.3968)] },
    });

    await importPlaces(db, { areas: [AREA], timeZone: "America/Toronto", apiKey: "k" });
    db.prepare(
      `UPDATE venues SET place_refreshed_at = datetime('now', '-40 days') WHERE source_id = 'a'`,
    ).run();

    assert.equal(countStalePlaces(db), 1);
    const again = await importPlaces(db, { areas: [AREA], timeZone: "America/Toronto", apiKey: "k" });
    assert.equal(again.written, 1);
    assert.equal(countStalePlaces(db), 0);
    db.close();
  });

  it("writes nothing on a dry run, but still reports what it found", async () => {
    const db = freshDb();
    handler = () => ({
      status: 200,
      payload: { places: [place("a", "The Alder", 43.6479, -79.3968)] },
    });

    const result = await importPlaces(db, {
      areas: [AREA],
      timeZone: "America/Toronto",
      apiKey: "k",
      dryRun: true,
    });

    assert.equal(result.discovered, 1);
    assert.equal(result.written, 0);
    assert.equal(searchVenues(db, { lat: 43.6479, lon: -79.3968, radiusM: 500 }).length, 0);
    db.close();
  });

  it("does not blank an import's ratings when a later crawl re-saves the venue", async () => {
    const db = freshDb();
    handler = () => ({
      status: 200,
      payload: { places: [place("a", "The Alder", 43.6479, -79.3968, { rating: 4.5 })] },
    });
    await importPlaces(db, { areas: [AREA], timeZone: "America/Toronto", apiKey: "k" });

    // What the OpenStreetMap path writes: no rating field at all.
    upsertVenue(db, {
      id: "gpl_a",
      name: "The Alder",
      address: null,
      city: "Toronto",
      region: "ON",
      country: "Canada",
      lat: 43.6479,
      lon: -79.3968,
      timeZone: "America/Toronto",
      website: "https://alder.example",
      phone: null,
      source: "openstreetmap",
      sourceId: "node/1",
    });

    const [venue] = searchVenues(db, { lat: 43.6479, lon: -79.3968, radiusM: 500 });
    assert.equal(venue?.venue.website, "https://alder.example", "the crawl's field wins");
    assert.equal(venue?.venue.rating, 4.5, "the import's field survives");
    db.close();
  });
});

describe("finding venues without deals", () => {
  it("separates venues we have deals for from the ones we don't", async () => {
    const db = freshDb();
    handler = () => ({
      status: 200,
      payload: {
        places: [
          place("a", "The Alder", 43.6479, -79.3968),
          place("b", "The Oak", 43.648, -79.397),
        ],
      },
    });
    await importPlaces(db, { areas: [AREA], timeZone: "America/Toronto", apiKey: "k" });

    db.prepare(
      `INSERT INTO deals (id, venue_id, title, category, confidence, extracted_by)
       VALUES ('d1', 'gpl_a', 'Happy Hour', 'both', 0.8, 'heuristic')`,
    ).run();

    const all = searchVenues(db, { lat: 43.6479, lon: -79.3968, radiusM: 500 });
    assert.equal(all.length, 2);
    assert.equal(all.find((v) => v.venue.name === "The Alder")?.dealCount, 1);

    const gaps = searchVenues(db, {
      lat: 43.6479,
      lon: -79.3968,
      radiusM: 500,
      withoutDealsOnly: true,
    });
    assert.deepEqual(gaps.map((v) => v.venue.name), ["The Oak"]);
    db.close();
  });

  it("enforces the radius exactly, not just the bounding box", async () => {
    const db = freshDb();
    // 1.4 km due east — inside a 1 km box's corner, outside a 1 km circle.
    handler = () => ({
      status: 200,
      payload: {
        places: [
          place("near", "Close By", 43.6479, -79.3968),
          place("far", "Too Far", 43.6479, -79.3794),
        ],
      },
    });
    await importPlaces(db, { areas: [AREA], timeZone: "America/Toronto", apiKey: "k" });

    const within = searchVenues(db, { lat: 43.6479, lon: -79.3968, radiusM: 1000 });
    assert.deepEqual(within.map((v) => v.venue.name), ["Close By"]);
    db.close();
  });
});
