export type DealCategory = "drink" | "food" | "both";

export interface ApiWindow {
  dayOfWeek: number;
  startMin: number;
  endMin: number;
  label: string;
}

export interface ApiVenue {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number;
  lon: number;
  timeZone: string;
  website: string | null;
  phone: string | null;
  /** Only a Google Places import fills these in. */
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null;
  placeTypes: string[] | null;
}

/** A venue near you, with or without a deal attached. */
export interface ApiPlace extends ApiVenue {
  distanceM: number;
  distanceKm: number;
  dealCount: number;
}

export interface PlacesResponse {
  places: ApiPlace[];
  /** Provider attribution the client must display, or null if none applies. */
  attribution: string | null;
}

export interface ApiDeal {
  id: string;
  title: string;
  description: string | null;
  priceText: string | null;
  category: DealCategory;
  finePrint: string | null;
  confidence: number;
  sourceUrl: string | null;
  extractedBy: "heuristic" | "model" | "seed" | "manual";
  partner: boolean;
  imageUrl: string | null;
  lastVerifiedAt: string | null;
  windows: ApiWindow[];
  venue: ApiVenue;
  distanceM: number;
  distanceKm: number;
  distanceMi: number;
  activeNow: boolean;
  minutesUntilStart: number;
  minutesUntilEnd: number;
  matchedWindow: ApiWindow;
}

export interface DealsResponse {
  query: {
    lat: number;
    lon: number;
    radiusM: number;
    at: string;
    windowMin: number;
    sort: string;
  };
  count: number;
  deals: ApiDeal[];
}
