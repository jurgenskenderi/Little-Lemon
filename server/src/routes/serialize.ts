import { metersToKilometers, metersToMiles } from "../domain/geo.ts";
import { formatWindow, type DealWindow } from "../domain/time.ts";
import type { Deal, DealResult, Venue } from "../domain/types.ts";

export function serializeVenue(venue: Venue) {
  return {
    id: venue.id,
    name: venue.name,
    address: venue.address,
    city: venue.city,
    region: venue.region,
    country: venue.country,
    lat: venue.lat,
    lon: venue.lon,
    timeZone: venue.timeZone,
    website: venue.website,
    phone: venue.phone,
  };
}

function serializeWindow(window: DealWindow) {
  return {
    dayOfWeek: window.dayOfWeek,
    startMin: window.startMin,
    endMin: window.endMin,
    label: formatWindow(window),
  };
}

export function serializeDeal(deal: Deal) {
  return {
    id: deal.id,
    title: deal.title,
    description: deal.description,
    priceText: deal.priceText,
    category: deal.category,
    finePrint: deal.finePrint,
    confidence: deal.confidence,
    sourceUrl: deal.sourceUrl,
    extractedBy: deal.extractedBy,
    partner: deal.partner,
    imageUrl: deal.imageUrl,
    lastVerifiedAt: deal.lastVerifiedAt,
    windows: deal.windows.map(serializeWindow),
  };
}

export function serializeDealResult(result: DealResult) {
  return {
    ...serializeDeal(result),
    venue: serializeVenue(result.venue),
    distanceM: Math.round(result.distanceM),
    // Both units are returned so the client can present whichever its market
    // expects; Canada is metric, so the app reads distanceKm.
    distanceKm: Number(metersToKilometers(result.distanceM).toFixed(2)),
    distanceMi: Number(metersToMiles(result.distanceM).toFixed(2)),
    activeNow: result.activeNow,
    minutesUntilStart: result.minutesUntilStart,
    minutesUntilEnd: result.minutesUntilEnd,
    matchedWindow: serializeWindow(result.matchedWindow),
  };
}
