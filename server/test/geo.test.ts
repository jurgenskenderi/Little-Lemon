import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boundingBox,
  crossesAntimeridian,
  haversineMeters,
  metersToMiles,
  milesToMeters,
} from "../src/domain/geo.ts";

const SEATTLE = { lat: 47.6062, lon: -122.3321 };
const PORTLAND = { lat: 45.5152, lon: -122.6784 };

describe("haversineMeters", () => {
  it("measures a known city-to-city distance", () => {
    // Seattle to Portland is about 233 km.
    const meters = haversineMeters(SEATTLE, PORTLAND);
    assert.ok(Math.abs(meters - 233_000) < 5_000, `got ${Math.round(meters)}m`);
  });

  it("is zero for the same point and symmetric between two", () => {
    assert.equal(haversineMeters(SEATTLE, SEATTLE), 0);
    assert.equal(
      Math.round(haversineMeters(SEATTLE, PORTLAND)),
      Math.round(haversineMeters(PORTLAND, SEATTLE)),
    );
  });

  it("stays accurate at walking distances", () => {
    // ~0.001 degree of latitude is ~111 m anywhere on Earth.
    const meters = haversineMeters(SEATTLE, { lat: SEATTLE.lat + 0.001, lon: SEATTLE.lon });
    assert.ok(Math.abs(meters - 111) < 2, `got ${meters.toFixed(1)}m`);
  });
});

describe("boundingBox", () => {
  it("contains every point inside the radius", () => {
    const radiusM = 1600;
    const box = boundingBox(SEATTLE, radiusM);

    // Sample the circle; every point within the radius must be inside the box.
    for (let degrees = 0; degrees < 360; degrees += 15) {
      const radians = (degrees * Math.PI) / 180;
      const latDelta = (radiusM * Math.cos(radians)) / 111_320;
      const lonDelta =
        (radiusM * Math.sin(radians)) /
        (111_320 * Math.cos((SEATTLE.lat * Math.PI) / 180));
      const point = { lat: SEATTLE.lat + latDelta, lon: SEATTLE.lon + lonDelta };

      assert.ok(point.lat >= box.minLat && point.lat <= box.maxLat, `lat at ${degrees}°`);
      assert.ok(point.lon >= box.minLon && point.lon <= box.maxLon, `lon at ${degrees}°`);
    }
  });

  it("widens longitude at high latitude, where degrees are narrower", () => {
    const equator = boundingBox({ lat: 0, lon: 0 }, 10_000);
    const arctic = boundingBox({ lat: 70, lon: 0 }, 10_000);

    const equatorWidth = equator.maxLon - equator.minLon;
    const arcticWidth = arctic.maxLon - arctic.minLon;
    assert.ok(arcticWidth > equatorWidth * 2, "same metres span more longitude near the pole");
  });

  it("degrades to the full longitude range at the pole instead of exploding", () => {
    const box = boundingBox({ lat: 90, lon: 0 }, 5_000);
    assert.equal(box.maxLon - box.minLon, 360);
    assert.ok(box.maxLat <= 90, "latitude stays on the globe");
  });

  it("flags a box that wraps the antimeridian", () => {
    assert.equal(crossesAntimeridian(boundingBox({ lat: 0, lon: 179.99 }, 5_000)), true);
    assert.equal(crossesAntimeridian(boundingBox(SEATTLE, 5_000)), false);
  });
});

describe("unit conversion", () => {
  it("round-trips miles and metres", () => {
    assert.ok(Math.abs(metersToMiles(milesToMeters(3)) - 3) < 1e-9);
    assert.equal(Math.round(milesToMeters(1)), 1609);
  });
});
