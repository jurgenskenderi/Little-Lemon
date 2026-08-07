import type { DealWindow } from "./time.ts";

export type DealCategory = "drink" | "food" | "both";

export interface Venue {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number;
  lon: number;
  /** IANA time zone. Windows are wall-clock local, so this is required. */
  timeZone: string;
  website: string | null;
  phone: string | null;
  source: string;
  sourceId: string | null;
  /** Discovery metadata. Only a Google Places import fills these in. */
  rating: number | null;
  ratingCount: number | null;
  /** 0-4, Google's scale: free through very expensive. */
  priceLevel: number | null;
  placeTypes: string[] | null;
  /** When the provider's copy was last re-read. Their terms cap its age. */
  placeRefreshedAt: string | null;
}

export interface Deal {
  id: string;
  venueId: string;
  title: string;
  description: string | null;
  priceText: string | null;
  category: DealCategory;
  finePrint: string | null;
  /** 0-1. Heuristic matches score lower than model-extracted ones by default. */
  confidence: number;
  sourceUrl: string | null;
  extractedBy: "heuristic" | "model" | "seed" | "manual";
  /** Agreed directly with the venue rather than scraped. Ranks first. */
  partner: boolean;
  /** Photo from the venue's own page, if one could be found. */
  imageUrl: string | null;
  windows: DealWindow[];
  lastVerifiedAt: string | null;
}

/** A deal joined to its venue and scored against one specific search. */
export interface DealResult extends Deal {
  venue: Venue;
  distanceM: number;
  /** Open at the exact moment the user asked about. */
  activeNow: boolean;
  /** 0 when already open, otherwise the wait until it starts. */
  minutesUntilStart: number;
  minutesUntilEnd: number;
  matchedWindow: DealWindow;
}

export interface DealSearch {
  lat: number;
  lon: number;
  radiusM: number;
  /** Instant the user is asking about; defaults to now. */
  at: Date;
  /** How far past `at` they are willing to look, in minutes. */
  windowMin: number;
  category?: DealCategory;
  query?: string;
  limit: number;
  offset: number;
}
