/**
 * Just enough HTML handling to turn a restaurant page into (a) readable text
 * for the extractors and (b) a shortlist of links worth following. A real DOM
 * parser would be more correct, but happy-hour copy lives in plain prose and
 * the regex path keeps the dependency surface small.
 */

const BLOCK_TAGS =
  /<\/?(?:p|div|br|li|tr|td|th|h[1-6]|section|article|header|footer|ul|ol|table)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  middot: "·",
  bull: "•",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const codePoint = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      // Drop anything that isn't page copy before stripping tags, or their
      // contents would survive as text.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(BLOCK_TAGS, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function extractTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]).trim() : null;
}

/** Link text or URL that suggests the page carries deal information. */
const PROMISING_LINK =
  /(happy[-\s_]?hour|specials?|deals?|drink|menu|bar|events?|promotions?)/i;

const SKIP_LINK =
  /(\.(?:pdf|jpe?g|png|gif|webp|svg|mp4|zip|doc|docx)$|^mailto:|^tel:|^javascript:|#)/i;

export interface DiscoveredLink {
  url: string;
  text: string;
  score: number;
}

/**
 * Rank same-origin links by how likely they are to hold happy-hour copy.
 * "happy hour" in the anchor text is the strongest signal; a bare "menu" is
 * weaker but still worth a look when a site buries specials in the menu page.
 */
export function findPromisingLinks(html: string, baseUrl: string): DiscoveredLink[] {
  const base = new URL(baseUrl);
  const seen = new Map<string, DiscoveredLink>();
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1];
    const rawText = match[2];
    if (!href || SKIP_LINK.test(href)) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }

    // Staying on-origin keeps the crawl bounded and avoids wandering into
    // aggregators, social links, and reservation widgets.
    if (resolved.origin !== base.origin) continue;
    resolved.hash = "";

    const text = htmlToText(rawText ?? "").slice(0, 120);
    const haystack = `${text} ${resolved.pathname}`;
    if (!PROMISING_LINK.test(haystack)) continue;

    const score =
      (/happy[-\s_]?hour/i.test(haystack) ? 10 : 0) +
      (/specials?|deals?/i.test(haystack) ? 5 : 0) +
      (/drink|bar/i.test(haystack) ? 2 : 0) +
      (/menu/i.test(haystack) ? 1 : 0);

    const key = resolved.toString();
    const existing = seen.get(key);
    if (!existing || existing.score < score) {
      seen.set(key, { url: key, text, score });
    }
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
}
