/**
 * Connectivity check run before a crawl.
 *
 * A crawl that fails because the machine has no outbound internet looks exactly
 * like a crawl that fails because every venue's site is down: a pile of
 * timeouts and an empty database. Checking first, and naming the difference,
 * turns a confusing ten-minute run into a five-second answer.
 */

import { config } from "../config.ts";

export interface PreflightResult {
  ok: boolean;
  overpassReachable: boolean;
  webReachable: boolean;
  detail: string;
}

interface Probe {
  ok: boolean;
  note: string;
  /** A proxy or network policy answered on the host's behalf. */
  intercepted: boolean;
}

/**
 * Only a 2xx/3xx counts as reachable. A corporate proxy or sandbox gateway
 * answers with 403/407 rather than refusing the connection, which looks like a
 * live server if you only rule out 5xx — and then the crawl fails for reasons
 * the operator cannot see.
 */
async function probe(url: string, timeoutMs = 12_000): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": config.scraper.userAgent },
    });
    const intercepted = [403, 407, 451, 502].includes(response.status);
    return {
      ok: response.status >= 200 && response.status < 400,
      note: `HTTP ${response.status}`,
      intercepted,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, note: message, intercepted: false };
  } finally {
    clearTimeout(timer);
  }
}

export interface PreflightOptions {
  /** Overridable so the check itself can be tested against local servers. */
  overpassUrl?: string;
  webUrl?: string;
}

export async function preflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const [overpass, web] = await Promise.all([
    probe(options.overpassUrl ?? "https://overpass-api.de/api/status"),
    // A second, unrelated host separates "Overpass is down or rate-limiting us"
    // from "this machine cannot reach the internet at all".
    probe(options.webUrl ?? "https://example.com/"),
  ]);

  if (overpass.ok && web.ok) {
    return {
      ok: true,
      overpassReachable: true,
      webReachable: true,
      detail: "Overpass and the open web are both reachable.",
    };
  }

  if (!web.ok && !overpass.ok) {
    const blocked = web.intercepted || overpass.intercepted;
    return {
      ok: false,
      overpassReachable: false,
      webReachable: false,
      detail: blocked
        ? `A proxy or network policy is blocking outbound requests (${web.note}).\n` +
          "  The request reached a gateway, which refused to forward it — so this is a\n" +
          "  permissions problem, not a connectivity one. Venue sites are unreachable\n" +
          "  too, so there is nothing to crawl. Run this from a machine with normal\n" +
          "  internet access, or allow overpass-api.de and general HTTPS egress."
        : `No outbound internet access from this machine (${web.note}).\n` +
          "  Nothing to crawl — the venue sites are unreachable too.\n" +
          "  If you are behind a proxy, set HTTPS_PROXY so Node can reach the web.",
    };
  }

  if (!overpass.ok) {
    return {
      ok: false,
      overpassReachable: false,
      webReachable: true,
      detail:
        `The open web is reachable but Overpass is not (${overpass.note}).\n` +
        "  Overpass rate-limits heavily. Wait a minute and retry, or point at a\n" +
        "  mirror: OVERPASS_ENDPOINT=https://overpass.kumi.systems/api/interpreter",
    };
  }

  return {
    ok: false,
    overpassReachable: true,
    webReachable: false,
    detail:
      `Overpass answered but general web access failed (${web.note}).\n` +
      "  Venue discovery would work while the crawl itself would not.",
  };
}
