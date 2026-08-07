/**
 * Distance filtering is two stages: a bounding box that SQLite can answer from
 * an index, then an exact haversine pass in JS. The box alone would over-select
 * at the corners (a square is ~27% larger than its inscribed circle), so the
 * second pass is what actually enforces the radius the user picked.
 */

export const EARTH_RADIUS_M = 6_371_008.8;

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const h =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Smallest lat/lon box containing every point within `radiusM` of `centre`.
 *
 * Longitude degrees shrink toward the poles, so the longitude half-width is
 * divided by cos(latitude). Near the poles that denominator collapses and the
 * box would blow up, so we widen to the full longitude range instead — the
 * haversine pass still enforces the true radius.
 */
export function boundingBox(centre: Coordinates, radiusM: number): BoundingBox {
  const latDelta = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.cos(toRadians(centre.lat));

  const lonDelta =
    Math.abs(cosLat) < 1e-6
      ? 180
      : (radiusM / (EARTH_RADIUS_M * Math.abs(cosLat))) * (180 / Math.PI);

  return {
    minLat: Math.max(-90, centre.lat - latDelta),
    maxLat: Math.min(90, centre.lat + latDelta),
    minLon: centre.lon - lonDelta,
    maxLon: centre.lon + lonDelta,
  };
}

/** True when the box wraps the antimeridian and needs to be queried as two ranges. */
export function crossesAntimeridian(box: BoundingBox): boolean {
  return box.minLon < -180 || box.maxLon > 180;
}

export function isValidCoordinate(point: Coordinates): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lon >= -180 &&
    point.lon <= 180
  );
}

export function metersToMiles(meters: number): number {
  return meters / 1609.344;
}

export function milesToMeters(miles: number): number {
  return miles * 1609.344;
}
