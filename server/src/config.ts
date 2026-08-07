import { join } from "node:path";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: intFromEnv("PORT", 8787),
  host: process.env.HOST ?? "0.0.0.0",
  databaseFile: process.env.DATABASE_FILE ?? join(process.cwd(), "data", "little-lemon.db"),

  /** Guards the scrape trigger endpoint. Unset means the endpoint is disabled. */
  adminToken: process.env.ADMIN_TOKEN ?? null,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  /** Extraction is routine structured work; low effort keeps it cheap and fast. */
  extractionModel: process.env.EXTRACTION_MODEL ?? "claude-opus-5",

  search: {
    defaultRadiusM: intFromEnv("DEFAULT_RADIUS_M", 1600), // ~1 mile
    maxRadiusM: intFromEnv("MAX_RADIUS_M", 50_000),
    defaultLimit: intFromEnv("DEFAULT_LIMIT", 50),
    maxLimit: intFromEnv("MAX_LIMIT", 200),
  },

  scraper: {
    userAgent:
      process.env.SCRAPER_USER_AGENT ??
      "LittleLemonBot/0.1 (+https://github.com/jurgenskenderi/Little-Lemon; happy-hour aggregator)",
    /** Floor on the gap between requests to one host, in ms. */
    minHostDelayMs: intFromEnv("SCRAPER_MIN_HOST_DELAY_MS", 2000),
    requestTimeoutMs: intFromEnv("SCRAPER_TIMEOUT_MS", 15_000),
    maxPagesPerVenue: intFromEnv("SCRAPER_MAX_PAGES_PER_VENUE", 4),
    maxBytesPerPage: intFromEnv("SCRAPER_MAX_BYTES", 2_000_000),
    /** Skip refetching a page seen more recently than this. */
    refetchAfterHours: intFromEnv("SCRAPER_REFETCH_AFTER_HOURS", 168),
  },
} as const;
