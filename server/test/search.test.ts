import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  openDatabase,
  searchDeals,
  upsertDeal,
  upsertVenue,
  type DatabaseHandle,
} from "../src/db/index.ts";
import { milesToMeters } from "../src/domain/geo.ts";
import type { DayOfWeek } from "../src/domain/time.ts";

const ORIGIN = { lat: 47.6142, lon: -122.3283 };
const TZ = "America/Los_Angeles";

/** Friday 2026-08-07, 4:30pm in Seattle — inside a 4-6pm happy hour. */
const FRIDAY_430PM = new Date("2026-08-07T23:30:00Z");

function addVenue(
  db: DatabaseHandle,
  id: string,
  name: string,
  lat: number,
  lon: number,
): string {
  return upsertVenue(db, {
    id,
    name,
    address: null,
    city: "Seattle",
    region: "WA",
    country: "US",
    lat,
    lon,
    timeZone: TZ,
    website: null,
    phone: null,
    source: "test",
    sourceId: id,
  });
}

function addDeal(
  db: DatabaseHandle,
  options: {
    id: string;
    venueId: string;
    title?: string;
    category?: "drink" | "food" | "both";
    confidence?: number;
    days: DayOfWeek[];
    startMin: number;
    endMin: number;
  },
): void {
  upsertDeal(db, {
    id: options.id,
    venueId: options.venueId,
    title: options.title ?? "Happy Hour",
    description: null,
    priceText: null,
    category: options.category ?? "both",
    finePrint: null,
    confidence: options.confidence ?? 0.9,
    sourceUrl: null,
    extractedBy: "seed",
    windows: options.days.map((day) => ({
      dayOfWeek: day,
      startMin: options.startMin,
      endMin: options.endMin,
    })),
    lastVerifiedAt: null,
  });
}

describe("searchDeals", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");

    // Right on top of the search origin.
    addVenue(db, "ven_near", "Near Bar", ORIGIN.lat, ORIGIN.lon);
    // ~1.1 km north.
    addVenue(db, "ven_mid", "Mid Bar", ORIGIN.lat + 0.01, ORIGIN.lon);
    // ~11 km north, outside every radius used below.
    addVenue(db, "ven_far", "Far Bar", ORIGIN.lat + 0.1, ORIGIN.lon);

    for (const venueId of ["ven_near", "ven_mid", "ven_far"]) {
      addDeal(db, {
        id: `deal_${venueId}`,
        venueId,
        days: [5],
        startMin: 960,
        endMin: 1080, // Fri 4-6pm
      });
    }
  });

  const baseSearch = {
    lat: ORIGIN.lat,
    lon: ORIGIN.lon,
    at: FRIDAY_430PM,
    windowMin: 0,
    limit: 50,
    offset: 0,
  };

  it("returns only venues inside the chosen radius", () => {
    const oneMile = searchDeals(db, { ...baseSearch, radiusM: milesToMeters(1) });
    assert.deepEqual(
      oneMile.map((deal) => deal.venue.id).sort(),
      ["ven_mid", "ven_near"],
      "the 11 km venue is excluded",
    );

    const tenMiles = searchDeals(db, { ...baseSearch, radiusM: milesToMeters(10) });
    assert.equal(tenMiles.length, 3, "widening the radius reaches the far venue");
  });

  it("excludes a venue just outside the radius", () => {
    // ven_mid sits ~1.11 km out; a 1 km radius must not include it.
    const results = searchDeals(db, { ...baseSearch, radiusM: 1000 });
    assert.deepEqual(results.map((deal) => deal.venue.id), ["ven_near"]);
  });

  it("reports the real distance, not the bounding-box approximation", () => {
    const results = searchDeals(db, { ...baseSearch, radiusM: milesToMeters(10) });
    const mid = results.find((deal) => deal.venue.id === "ven_mid");
    assert.ok(mid);
    assert.ok(Math.abs(mid.distanceM - 1112) < 30, `got ${Math.round(mid.distanceM)}m`);
  });

  it("filters out deals that are not running at the requested time", () => {
    // Friday 9am — before any window opens.
    const morning = searchDeals(db, {
      ...baseSearch,
      at: new Date("2026-08-07T16:00:00Z"),
      radiusM: milesToMeters(10),
    });
    assert.equal(morning.length, 0);
  });

  it("finds deals that start later when a look-ahead window is given", () => {
    const results = searchDeals(db, {
      ...baseSearch,
      at: new Date("2026-08-07T21:00:00Z"), // 2pm Friday
      windowMin: 180,
      radiusM: milesToMeters(10),
    });
    assert.equal(results.length, 3);
    assert.equal(results[0]?.activeNow, false, "not open yet");
    assert.equal(results[0]?.minutesUntilStart, 120, "opens in two hours");
  });

  it("sorts open-now venues ahead of ones that open later", () => {
    addVenue(db, "ven_later", "Later Bar", ORIGIN.lat + 0.001, ORIGIN.lon);
    addDeal(db, {
      id: "deal_later",
      venueId: "ven_later",
      days: [5],
      startMin: 1200,
      endMin: 1320, // Fri 8-10pm
    });

    const results = searchDeals(db, {
      ...baseSearch,
      windowMin: 360,
      radiusM: milesToMeters(1),
    });

    assert.equal(results[0]?.activeNow, true, "an open venue leads");
    assert.equal(results.at(-1)?.venue.id, "ven_later", "the not-yet-open one trails");
  });

  it("honours the category filter, treating 'both' as always eligible", () => {
    addVenue(db, "ven_food", "Food Bar", ORIGIN.lat, ORIGIN.lon + 0.001);
    addDeal(db, {
      id: "deal_food",
      venueId: "ven_food",
      category: "food",
      days: [5],
      startMin: 960,
      endMin: 1080,
    });

    const drinks = searchDeals(db, {
      ...baseSearch,
      radiusM: milesToMeters(1),
      category: "drink",
    });
    assert.ok(
      !drinks.some((deal) => deal.venue.id === "ven_food"),
      "a food-only deal is not a drink deal",
    );
    assert.ok(drinks.length > 0, "'both' deals still qualify");
  });

  it("can hide low-confidence extractions", () => {
    addVenue(db, "ven_shaky", "Shaky Bar", ORIGIN.lat, ORIGIN.lon + 0.002);
    addDeal(db, {
      id: "deal_shaky",
      venueId: "ven_shaky",
      confidence: 0.2,
      days: [5],
      startMin: 960,
      endMin: 1080,
    });

    const all = searchDeals(db, { ...baseSearch, radiusM: milesToMeters(1) });
    const trusted = searchDeals(db, {
      ...baseSearch,
      radiusM: milesToMeters(1),
      minConfidence: 0.5,
    });

    assert.ok(all.some((deal) => deal.venue.id === "ven_shaky"));
    assert.ok(!trusted.some((deal) => deal.venue.id === "ven_shaky"));
  });

  it("matches a late-night window from the following calendar day", () => {
    addVenue(db, "ven_late", "Late Bar", ORIGIN.lat, ORIGIN.lon);
    addDeal(db, {
      id: "deal_late",
      venueId: "ven_late",
      days: [5],
      startMin: 1320,
      endMin: 1560, // Fri 10pm-2am
    });

    // Saturday 00:30 local — a Friday deal that is still running.
    const results = searchDeals(db, {
      ...baseSearch,
      at: new Date("2026-08-08T07:30:00Z"),
      radiusM: milesToMeters(1),
    });

    assert.deepEqual(results.map((deal) => deal.venue.id), ["ven_late"]);
    assert.equal(results[0]?.activeNow, true);
  });

  it("paginates without dropping or repeating results", () => {
    const all = searchDeals(db, { ...baseSearch, radiusM: milesToMeters(10) });
    const firstPage = searchDeals(db, { ...baseSearch, radiusM: milesToMeters(10), limit: 2 });
    const secondPage = searchDeals(db, {
      ...baseSearch,
      radiusM: milesToMeters(10),
      limit: 2,
      offset: 2,
    });

    assert.equal(firstPage.length, 2);
    assert.equal(secondPage.length, 1);
    assert.deepEqual(
      [...firstPage, ...secondPage].map((deal) => deal.id),
      all.map((deal) => deal.id),
    );
  });
});
