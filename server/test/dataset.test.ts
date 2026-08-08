/**
 * The static dataset build, end to end over loopback.
 *
 * This runs the real CLI as a subprocess against a fake Overpass and a fixture
 * restaurant site, so it covers the whole path the GitHub Action takes:
 * discovery, the polite crawl, robots.txt, heuristic extraction, image
 * selection, social-link capture, and the JSON the web app actually reads.
 *
 * The fixture site is built to be awkward in the ways real ones are: the
 * happy hour lives on a second page reached by a link, the homepage carries a
 * decoy line of opening hours, one page is disallowed by robots.txt, and the
 * Instagram link is to a host that refuses crawlers.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let site: Server;
let overpass: Server;
let siteUrl = "";
let workDir = "";
let payload: {
  generatedAt: string;
  // Read back off disk, so index access is genuinely possibly-undefined.
  stats: Partial<Record<
    "venuesConsidered" | "venuesCrawled" | "venuesWithDeals" | "deals" | "dealsWithImages" |
    "pagesFetched" | "pagesDisallowed" | "socialsFound" | "socialsCrawled" | "modelCalls" |
    "errors",
    number
  >>;
  venues: Record<string, {
    name: string;
    deals: Array<{
      title: string;
      priceText: string | null;
      category: string;
      confidence: number;
      imageUrl: string | null;
      windows: Array<{ day: number; start: number; end: number }>;
    }>;
    socials?: Record<string, string>;
  }>;
};

const PAGES: Record<string, { type: string; body: string }> = {
  "/robots.txt": {
    type: "text/plain",
    body: ["User-agent: *", "Disallow: /private", ""].join("\n"),
  },
  "/": {
    type: "text/html",
    body: `<!doctype html><html><head>
      <meta property="og:image" content="/img/interior.jpg">
      <title>The Alder &amp; Oak</title></head>
      <body>
        <h1>The Alder &amp; Oak</h1>
        <p>Open Mon-Sun 11am-11pm. Kitchen closes at 10.</p>
        <nav>
          <a href="/happy-hour">Happy Hour</a>
          <a href="/private/drink-specials">Drink specials</a>
        </nav>
        <a href="https://www.instagram.com/alderandoak">Instagram</a>
        <a href="https://www.facebook.com/alderandoak">Facebook</a>
      </body></html>`,
  },
  "/happy-hour": {
    type: "text/html",
    body: `<!doctype html><html><head>
      <meta property="og:image" content="https://cdn.example.test/photos/oysters-large.jpg">
      </head><body>
        <h1>Happy Hour</h1>
        <p>Mon-Fri 4-6pm: $6 local pints and $1.75 oysters.</p>
        <p>Fri &amp; Sat 10pm-close: $8 cocktails.</p>
      </body></html>`,
  },
  // Link text a crawler would want to follow, on a path robots.txt forbids —
  // so the refusal is exercised rather than the link simply being ignored.
  "/private/drink-specials": {
    type: "text/html",
    body: "<p>Staff only. Mon-Fri 3-5pm: $1 beer.</p>",
  },
};

before(async () => {
  site = createServer((request, response) => {
    const page = PAGES[(request.url ?? "/").split("?")[0] ?? "/"];
    if (!page) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": page.type });
    response.end(page.body);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  overpass = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        elements: [{
          type: "node", id: 1, lat: 43.6487, lon: -79.3980,
          tags: {
            name: "The Alder & Oak", amenity: "bar", website: siteUrl,
            "addr:housenumber": "120", "addr:street": "Queen St W", phone: "+1 416-555-0142",
          },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => overpass.listen(0, "127.0.0.1", resolve));

  workDir = mkdtempSync(join(tmpdir(), "clocktails-dataset-"));
  const output = join(workDir, "deals.json");

  // Must be async, not spawnSync: the fixture servers live in this process, and
  // spawnSync blocks its event loop — the subprocess's requests would never be
  // answered and both sides would wait forever.
  const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "src/dataset/build.ts",
       "--preset", "toronto-core", "--skip-preflight", "--no-model", "--limit", "5"],
      {
        env: {
          ...process.env,
          OVERPASS_ENDPOINT: `http://127.0.0.1:${(overpass.address() as AddressInfo).port}`,
          DATABASE_FILE: join(workDir, "test.db"),
          DEALS_OUTPUT: output,
          // The fixture is loopback; no reason to be polite about the delay.
          SCRAPER_MIN_HOST_DELAY_MS: "0",
        },
      },
    );
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, output: text }));
  });

  assert.equal(result.code, 0, `build failed:\n${result.output}`);
  payload = JSON.parse(readFileSync(output, "utf8"));
});

after(() => {
  site.close();
  overpass.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("the generated dataset", () => {
  it("keys venues by their OpenStreetMap id, which is what the app already has", () => {
    assert.ok(payload.venues["node/1"], `expected node/1, got ${Object.keys(payload.venues)}`);
    assert.equal(payload.venues["node/1"]?.name, "The Alder & Oak");
  });

  it("finds the deal on the page behind a link, not just the entry page", () => {
    const deals = payload.venues["node/1"]?.deals ?? [];
    const pints = deals.find((deal) => /pint/i.test(deal.priceText ?? ""));
    assert.ok(pints, `no pints deal in ${JSON.stringify(deals.map((d) => d.priceText))}`);
    // "Mon-Fri 4-6pm" — the afternoon, five days.
    assert.equal(pints.windows.length, 5);
    assert.deepEqual(pints.windows.map((w) => w.day).sort(), [1, 2, 3, 4, 5]);
    assert.equal(pints.windows[0]?.start, 16 * 60);
    assert.equal(pints.windows[0]?.end, 18 * 60);
  });

  it("keeps a window that runs past midnight as one entry", () => {
    const deals = payload.venues["node/1"]?.deals ?? [];
    const late = deals.find((deal) => /cocktail/i.test(deal.priceText ?? ""));
    assert.ok(late, "the Fri & Sat late deal was not extracted");
    // 10pm to close on Friday and Saturday: end must run past 1440, not wrap.
    for (const window of late.windows) {
      assert.equal(window.start, 22 * 60);
      assert.ok(window.end > 1440, `expected a past-midnight end, got ${window.end}`);
    }
    assert.deepEqual(late.windows.map((w) => w.day).sort(), [5, 6]);
  });

  it("does not treat the homepage's opening hours as a deal", () => {
    const deals = payload.venues["node/1"]?.deals ?? [];
    assert.ok(
      !deals.some((deal) => deal.windows.some((w) => w.start === 11 * 60 && w.end === 23 * 60)),
      "'Open Mon-Sun 11am-11pm' was parsed as a deal",
    );
  });

  it("obeys robots.txt, so the disallowed page contributes nothing", () => {
    const deals = payload.venues["node/1"]?.deals ?? [];
    assert.ok(
      !deals.some((deal) => /\$1 beer/i.test(`${deal.priceText} ${deal.title}`)),
      "content from a disallowed page reached the dataset",
    );
    assert.ok((payload.stats.pagesDisallowed ?? 0) >= 1, "nothing was refused by robots.txt");
  });

  it("attaches a photo, preferring the deal page's own", () => {
    const deals = payload.venues["node/1"]?.deals ?? [];
    assert.ok(deals.length > 0);
    const withImage = deals.filter((deal) => deal.imageUrl);
    assert.ok(withImage.length > 0, "no deal carried an image");
    assert.match(withImage[0]?.imageUrl ?? "", /oysters-large\.jpg$/);
    assert.equal(payload.stats.dealsWithImages, withImage.length);
  });

  it("records social profiles it is not allowed to crawl, so the app can link them", () => {
    const socials = payload.venues["node/1"]?.socials ?? {};
    assert.equal(socials["instagram"], "https://www.instagram.com/alderandoak");
    assert.equal(socials["facebook"], "https://www.facebook.com/alderandoak");
    assert.ok((payload.stats.socialsFound ?? 0) >= 2);
    // Neither permits anonymous crawling, so neither was queued.
    assert.equal(payload.stats.socialsCrawled, 0);
  });

  it("reports what it did, so a run that found nothing is distinguishable", () => {
    assert.equal(payload.stats.venuesCrawled, 1);
    assert.equal(payload.stats.venuesWithDeals, 1);
    assert.ok((payload.stats.deals ?? 0) >= 2);
    assert.ok((payload.stats.pagesFetched ?? 0) >= 2);
    assert.ok(Date.parse(payload.generatedAt) > 0);
  });
});
