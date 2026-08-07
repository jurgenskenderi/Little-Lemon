/**
 * Minimal robots.txt handling: enough of RFC 9309 to be a good citizen.
 *
 * Group selection follows the spec: the most specific matching user-agent group
 * wins outright (an exact-name group beats `*`, and we never merge the two).
 * Within a group, the longest matching path rule wins, with Allow beating
 * Disallow on ties — which is what makes `Disallow: /` plus `Allow: /menu`
 * behave the way site owners expect.
 */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  crawlDelayMs: number | null;
  /** True when robots.txt could not be fetched and we fell back to permissive. */
  assumed: boolean;
}

const PERMISSIVE: RobotsPolicy = { rules: [], crawlDelayMs: null, assumed: true };

/** A 4xx on robots.txt means "no restrictions"; a 5xx means "stay out". */
export function policyForStatus(status: number): RobotsPolicy | null {
  if (status >= 200 && status < 300) return null; // caller parses the body
  if (status >= 400 && status < 500) return PERMISSIVE;
  return { rules: [{ allow: false, path: "/" }], crawlDelayMs: null, assumed: true };
}

export function parseRobots(body: string, userAgent: string): RobotsPolicy {
  const agentToken = userAgent.split("/")[0]?.toLowerCase() ?? userAgent.toLowerCase();

  // Collect every group so we can pick the most specific one afterwards.
  const groups: Array<{ agents: string[]; rules: RobotsRule[]; crawlDelay: number | null }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      // Consecutive user-agent lines share one group.
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (!current) continue;

    if (field === "disallow") {
      // An empty Disallow means "allow everything" and carries no path rule.
      if (value !== "") current.rules.push({ allow: false, path: value });
    } else if (field === "allow") {
      if (value !== "") current.rules.push({ allow: true, path: value });
    } else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }

  const named = groups.find((group) =>
    group.agents.some((agent) => agent !== "*" && agentToken.includes(agent)),
  );
  const wildcard = groups.find((group) => group.agents.includes("*"));
  const chosen = named ?? wildcard;

  if (!chosen) return { rules: [], crawlDelayMs: null, assumed: false };
  return {
    rules: chosen.rules,
    crawlDelayMs: chosen.crawlDelay === null ? null : chosen.crawlDelay * 1000,
    assumed: false,
  };
}

function pathMatches(pattern: string, path: string): boolean {
  // robots.txt supports two wildcards: `*` (any run) and `$` (end anchor).
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  if (!body.includes("*")) {
    return anchored ? path === body : path.startsWith(body);
  }

  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(path);
}

export function isAllowed(policy: RobotsPolicy, url: URL): boolean {
  const path = url.pathname + url.search;

  let best: { rule: RobotsRule; length: number } | null = null;
  for (const rule of policy.rules) {
    if (!pathMatches(rule.path, path)) continue;
    const length = rule.path.replace(/[*$]/g, "").length;
    if (
      !best ||
      length > best.length ||
      // Longest match wins; Allow breaks ties, so a site can carve exceptions.
      (length === best.length && rule.allow && !best.rule.allow)
    ) {
      best = { rule, length };
    }
  }

  return best ? best.rule.allow : true;
}
