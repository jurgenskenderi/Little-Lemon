/**
 * Named crawl areas.
 *
 * A single centre with a big radius is the wrong shape for a city: Overpass
 * returns thousands of venues for a 10 km circle over Toronto, most of them
 * nowhere near a happy hour. A handful of tight circles over the neighbourhoods
 * that actually have bars covers the same ground with far less noise, and the
 * crawler dedupes venues by OSM id where the circles overlap.
 */

export interface CrawlArea {
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
}

export interface Preset {
  description: string;
  timeZone: string;
  areas: CrawlArea[];
}

export const PRESETS: Record<string, Preset> = {
  toronto: {
    description: "Toronto's main bar and restaurant strips",
    timeZone: "America/Toronto",
    areas: [
      { name: "Queen West",            lat: 43.6479, lon: -79.3968, radiusM: 1200 },
      { name: "King West",             lat: 43.6444, lon: -79.4005, radiusM: 1200 },
      { name: "Ossington / Dundas W",  lat: 43.6486, lon: -79.4189, radiusM: 1200 },
      { name: "Kensington / Chinatown",lat: 43.6547, lon: -79.4005, radiusM: 1000 },
      { name: "Financial District",    lat: 43.6487, lon: -79.3810, radiusM: 1000 },
      { name: "Entertainment District",lat: 43.6465, lon: -79.3900, radiusM: 1000 },
      { name: "The Danforth",          lat: 43.6779, lon: -79.3496, radiusM: 1200 },
      { name: "Leslieville / Riverside",lat: 43.6620, lon: -79.3380, radiusM: 1200 },
      { name: "Little Italy",          lat: 43.6551, lon: -79.4139, radiusM: 1000 },
      { name: "The Annex",             lat: 43.6656, lon: -79.4085, radiusM: 1200 },
      { name: "Yorkville",             lat: 43.6708, lon: -79.3934, radiusM: 900 },
      { name: "Liberty Village",       lat: 43.6380, lon: -79.4207, radiusM: 1000 },
      { name: "Distillery / Corktown", lat: 43.6503, lon: -79.3595, radiusM: 1000 },
      { name: "Roncesvalles / Parkdale",lat: 43.6430, lon: -79.4430, radiusM: 1400 },
      { name: "The Junction",          lat: 43.6655, lon: -79.4692, radiusM: 1200 },
    ],
  },

  "toronto-core": {
    description: "Downtown Toronto only — a quick first run",
    timeZone: "America/Toronto",
    areas: [
      { name: "Queen West",         lat: 43.6479, lon: -79.3968, radiusM: 1200 },
      { name: "King West",          lat: 43.6444, lon: -79.4005, radiusM: 1200 },
      { name: "Financial District", lat: 43.6487, lon: -79.3810, radiusM: 1000 },
    ],
  },

  ottawa: {
    description: "Ottawa's central nightlife areas",
    timeZone: "America/Toronto",
    areas: [
      { name: "ByWard Market", lat: 45.4285, lon: -75.6924, radiusM: 1000 },
      { name: "Elgin Street",  lat: 45.4174, lon: -75.6890, radiusM: 1000 },
      { name: "Westboro",      lat: 45.3960, lon: -75.7530, radiusM: 1200 },
    ],
  },

  hamilton: {
    description: "Hamilton's downtown core",
    timeZone: "America/Toronto",
    areas: [
      { name: "James North", lat: 43.2611, lon: -79.8656, radiusM: 1200 },
      { name: "Augusta / Corktown", lat: 43.2515, lon: -79.8686, radiusM: 1000 },
    ],
  },
};

export function listPresets(): string {
  return Object.entries(PRESETS)
    .map(([key, preset]) => `  ${key.padEnd(14)} ${preset.description} (${preset.areas.length} areas)`)
    .join("\n");
}
