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

/* ------------------------------------------------------------------ *
 * Social and off-site links
 * ------------------------------------------------------------------ */

/**
 * Hosts worth following off the venue's own origin.
 *
 * `findPromisingLinks` deliberately stays on-origin so a crawl cannot wander
 * into aggregators. But a lot of small bars publish nothing on their own site
 * and everything on Instagram or a link-in-bio page, so those are worth
 * naming explicitly.
 *
 * Be clear about the odds. Instagram and Facebook disallow anonymous crawling
 * in robots.txt and serve a login wall to everyone else, so the fetcher will
 * decline them and should — that is the correct behaviour, not a bug to work
 * around. They are recorded anyway so the app can link a visitor straight to
 * the page. The link-in-bio hosts are the ones that actually pay off: they
 * allow crawling and often carry the specials verbatim.
 */
const SOCIAL_HOSTS = [
  { pattern: /(^|\.)instagram\.com$/i, network: "instagram", crawlable: false },
  { pattern: /(^|\.)facebook\.com$/i, network: "facebook", crawlable: false },
  { pattern: /(^|\.)x\.com$/i, network: "x", crawlable: false },
  { pattern: /(^|\.)twitter\.com$/i, network: "x", crawlable: false },
  { pattern: /(^|\.)linktr\.ee$/i, network: "linktree", crawlable: true },
  { pattern: /(^|\.)beacons\.ai$/i, network: "linktree", crawlable: true },
  { pattern: /(^|\.)linkin\.bio$/i, network: "linktree", crawlable: true },
  { pattern: /(^|\.)toasttab\.com$/i, network: "menu", crawlable: true },
  { pattern: /(^|\.)square\.site$/i, network: "menu", crawlable: true },
];

export interface SocialLink {
  url: string;
  network: string;
  /** False for hosts that refuse anonymous crawlers; link to them instead. */
  crawlable: boolean;
}

/** Social and link-in-bio destinations referenced by a page. */
export function findSocialLinks(html: string, baseUrl: string): SocialLink[] {
  const base = new URL(baseUrl);
  const found = new Map<string, SocialLink>();
  const anchor = /<a\b[^>]*href=["']([^"']+)["']/gi;

  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1];
    if (!href) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

    const host = SOCIAL_HOSTS.find((candidate) => candidate.pattern.test(resolved.hostname));
    if (!host) continue;

    // A bare profile is what we want; share widgets and intent URLs are not.
    if (/\/(sharer|share|intent|dialog)\b/i.test(resolved.pathname)) continue;
    const handle = resolved.pathname.replace(/^\/+|\/+$/g, "");
    if (!handle || handle.split("/").length > 2) continue;

    resolved.hash = "";
    resolved.search = "";
    const key = resolved.toString();
    if (!found.has(key)) {
      found.set(key, { url: key, network: host.network, crawlable: host.crawlable });
    }
  }

  return [...found.values()];
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

/** Filenames that are almost never a photo of what is being served. */
const NON_PHOTO =
  /(logo|icon|favicon|sprite|badge|avatar|placeholder|spacer|pixel|banner-ad|arrow|chevron|social|instagram|facebook|twitter|yelp|opentable|payment|visa|mastercard)/i;

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;

export interface ImageCandidate {
  url: string;
  /** Higher is more likely to be an appetising photo of food or drink. */
  score: number;
  alt: string | null;
}

function absolute(raw: string, base: URL): string | null {
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // SVGs are logos and diagrams, never dish photography.
    if (/\.svgz?(\?|#|$)/i.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Find photos on a venue page worth showing next to a deal.
 *
 * Social preview images (`og:image`) win by a wide margin: they are chosen by
 * the venue as the picture that represents them, they are already sized for a
 * card, and they are stable. Inline images are a fallback, filtered hard —
 * most `<img>` tags on a restaurant site are chrome, not food.
 */
export function findImages(html: string, baseUrl: string): ImageCandidate[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const found = new Map<string, ImageCandidate>();
  const add = (raw: string | undefined, score: number, alt: string | null = null) => {
    if (!raw) return;
    const url = absolute(decodeEntities(raw), base);
    if (!url) return;
    if (NON_PHOTO.test(url)) return;
    const existing = found.get(url);
    if (!existing || existing.score < score) found.set(url, { url, score, alt });
  };

  // Open Graph and Twitter cards, in either attribute order.
  const meta = /<meta\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = meta.exec(html)) !== null) {
    const raw = tag[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1]?.toLowerCase();
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1];
    if (!key || !content) continue;
    if (key === "og:image" || key === "og:image:secure_url") add(content, 100);
    else if (key === "twitter:image" || key === "twitter:image:src") add(content, 90);
  }

  // Inline images, scored by hints that they are editorial rather than chrome.
  const img = /<img\b[^>]*>/gi;
  while ((tag = img.exec(html)) !== null) {
    const raw = tag[0];
    const src =
      /\bsrc\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1] ??
      // Lazy-loaded images keep the real URL in a data attribute.
      /\bdata-(?:src|lazy-src|original)\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1];
    if (!src) continue;

    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(raw)?.[1] ?? null;
    const width = Number(/\bwidth\s*=\s*["']?(\d+)/i.exec(raw)?.[1] ?? 0);
    const height = Number(/\bheight\s*=\s*["']?(\d+)/i.exec(raw)?.[1] ?? 0);

    // Anything declared tiny is an icon; anything with food words in its alt
    // text is likely the real thing.
    if ((width && width < 200) || (height && height < 150)) continue;
    let score = 20;
    if (IMAGE_EXTENSION.test(src)) score += 10;
    if (width >= 600 || height >= 400) score += 15;
    if (alt && /\b(food|drink|cocktail|beer|wine|dish|plate|menu|bar|burger|taco|oyster|pizza)\b/i.test(alt)) {
      score += 25;
    }
    add(src, score, alt);
  }

  return [...found.values()].sort((a, b) => b.score - a.score);
}

/** The single best photo for a page, or null when nothing qualifies. */
export function bestImage(html: string, baseUrl: string): string | null {
  return findImages(html, baseUrl)[0]?.url ?? null;
}
