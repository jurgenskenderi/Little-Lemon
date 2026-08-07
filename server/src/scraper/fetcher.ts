import { config } from "../config.ts";
import {
  isAllowed,
  parseRobots,
  policyForStatus,
  type RobotsPolicy,
} from "./robots.ts";

export interface FetchResult {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
}

export class DisallowedByRobotsError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = "DisallowedByRobotsError";
  }
}

/**
 * One request at a time per host, spaced by the host's crawl delay.
 *
 * Requests to *different* hosts still run concurrently — the serialisation is
 * per host, which is the thing site owners actually care about. The per-host
 * chain is a promise tail: each new request appends itself to that host's
 * chain, so ordering and spacing hold without a scheduler.
 */
export class PoliteFetcher {
  readonly #robots = new Map<string, Promise<RobotsPolicy>>();
  readonly #hostChains = new Map<string, Promise<void>>();
  readonly #userAgent: string;
  readonly #minDelayMs: number;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  constructor(options: {
    userAgent?: string;
    minDelayMs?: number;
    timeoutMs?: number;
    maxBytes?: number;
  } = {}) {
    this.#userAgent = options.userAgent ?? config.scraper.userAgent;
    this.#minDelayMs = options.minDelayMs ?? config.scraper.minHostDelayMs;
    this.#timeoutMs = options.timeoutMs ?? config.scraper.requestTimeoutMs;
    this.#maxBytes = options.maxBytes ?? config.scraper.maxBytesPerPage;
  }

  async #policyFor(origin: string): Promise<RobotsPolicy> {
    let pending = this.#robots.get(origin);
    if (pending) return pending;

    pending = (async () => {
      try {
        const response = await this.#rawFetch(`${origin}/robots.txt`);
        const fallback = policyForStatus(response.status);
        if (fallback) return fallback;
        return parseRobots(response.body, this.#userAgent);
      } catch {
        // Network failure on robots.txt is not permission to crawl.
        return { rules: [{ allow: false, path: "/" }], crawlDelayMs: null, assumed: true };
      }
    })();

    this.#robots.set(origin, pending);
    return pending;
  }

  async #rawFetch(url: string): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": this.#userAgent,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });

      const body = await this.#readCapped(response);
      return {
        url: response.url || url,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read at most `maxBytes` so a huge or endless response can't exhaust memory. */
  async #readCapped(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let received = 0;
    let text = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (received >= this.#maxBytes) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    return text + decoder.decode();
  }

  /** Fetch `url`, honouring robots.txt and this host's crawl delay. */
  async fetch(url: string): Promise<FetchResult> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }

    const policy = await this.#policyFor(parsed.origin);
    if (!isAllowed(policy, parsed)) {
      throw new DisallowedByRobotsError(url);
    }

    const delayMs = Math.max(this.#minDelayMs, policy.crawlDelayMs ?? 0);
    const host = parsed.host;
    const previous = this.#hostChains.get(host) ?? Promise.resolve();

    const result = previous.then(async () => {
      const response = await this.#rawFetch(url);
      // Hold the slot for the delay so the *next* caller waits, rather than
      // sleeping before a request that may be the only one for this host.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return response;
    });

    // The chain must not break on failure, or one bad URL wedges the host.
    this.#hostChains.set(
      host,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );

    return result;
  }
}
