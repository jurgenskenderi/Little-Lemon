import Constants from "expo-constants";

import type { DealCategory, DealsResponse } from "./types";

/**
 * Resolving the API host is the one piece of dev-time friction worth automating:
 * a phone on the same Wi-Fi cannot reach `localhost`, so the URL has to be the
 * dev machine's LAN address. Expo already knows that address — it is the host
 * serving the bundle — so we reuse it instead of asking the developer to
 * hardcode an IP that changes with every network.
 */
function resolveBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, "");

  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;

  const host = hostUri?.split(":")[0];
  if (host) return `http://${host}:8787`;

  // Last resort: an emulator on the same machine as the server.
  return "http://localhost:8787";
}

export const API_BASE_URL = resolveBaseUrl();

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface DealSearchParams {
  lat: number;
  lon: number;
  /** Kilometres — the launch market is Ontario. */
  radiusKm: number;
  /** The moment being asked about. */
  at: Date;
  /** Minutes past `at` to include; 0 means "open right then". */
  windowMin: number;
  category?: DealCategory;
  signal?: AbortSignal;
}

export async function fetchDeals(params: DealSearchParams): Promise<DealsResponse> {
  const query = new URLSearchParams({
    lat: String(params.lat),
    lon: String(params.lon),
    radiusKm: String(params.radiusKm),
    at: params.at.toISOString(),
    windowMin: String(params.windowMin),
    limit: "60",
  });
  if (params.category) query.set("category", params.category);

  const url = `${API_BASE_URL}/api/deals?${query.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: params.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // A network failure here is almost always the dev server being unreachable,
    // so name that rather than surfacing "Network request failed".
    throw new ApiError(
      `Could not reach the Little Lemon server at ${API_BASE_URL}. Is it running?`,
      0,
    );
  }

  if (!response.ok) {
    throw new ApiError(`The server returned ${response.status}.`, response.status);
  }

  return (await response.json()) as DealsResponse;
}
