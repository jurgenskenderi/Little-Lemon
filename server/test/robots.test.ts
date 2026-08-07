import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAllowed, parseRobots, policyForStatus } from "../src/scraper/robots.ts";
import { htmlToText, findPromisingLinks, decodeEntities } from "../src/scraper/html.ts";

const UA = "ClocktailsBot/0.1";
const url = (path: string) => new URL(`https://example.com${path}`);

describe("parseRobots and isAllowed", () => {
  it("applies wildcard rules", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /admin\n", UA);
    assert.equal(isAllowed(policy, url("/admin/login")), false);
    assert.equal(isAllowed(policy, url("/happy-hour")), true);
  });

  it("prefers our named group over the wildcard, without merging them", () => {
    const policy = parseRobots(
      ["User-agent: *", "Disallow: /", "", "User-agent: ClocktailsBot", "Disallow: /private"].join("\n"),
      UA,
    );
    assert.equal(isAllowed(policy, url("/menu")), true, "the wildcard block does not apply to us");
    assert.equal(isAllowed(policy, url("/private/x")), false);
  });

  it("lets a longer Allow carve an exception out of a broad Disallow", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /\nAllow: /menu\n", UA);
    assert.equal(isAllowed(policy, url("/menu/drinks")), true);
    assert.equal(isAllowed(policy, url("/checkout")), false);
  });

  it("treats an empty Disallow as full permission", () => {
    const policy = parseRobots("User-agent: *\nDisallow:\n", UA);
    assert.equal(isAllowed(policy, url("/anything")), true);
  });

  it("handles wildcard and end-anchor patterns", () => {
    const policy = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*/private\n", UA);
    assert.equal(isAllowed(policy, url("/menus/winter.pdf")), false);
    assert.equal(isAllowed(policy, url("/menus/winter.pdf.html")), true, "anchored to the end");
    assert.equal(isAllowed(policy, url("/tmp/a/private")), false);
  });

  it("ignores comments and blank lines", () => {
    const policy = parseRobots("# comment\nUser-agent: *\n\nDisallow: /x # trailing\n", UA);
    assert.equal(isAllowed(policy, url("/x")), false);
    assert.equal(isAllowed(policy, url("/y")), true);
  });

  it("reads crawl-delay in milliseconds", () => {
    const policy = parseRobots("User-agent: *\nCrawl-delay: 5\n", UA);
    assert.equal(policy.crawlDelayMs, 5000);
  });

  it("groups consecutive user-agent lines together", () => {
    const policy = parseRobots(
      "User-agent: SomeBot\nUser-agent: ClocktailsBot\nDisallow: /shared\n",
      UA,
    );
    assert.equal(isAllowed(policy, url("/shared")), false);
  });
});

describe("policyForStatus", () => {
  it("treats a missing robots.txt as permission and a server error as refusal", () => {
    assert.equal(isAllowed(policyForStatus(404)!, url("/anything")), true);
    assert.equal(
      isAllowed(policyForStatus(503)!, url("/anything")),
      false,
      "a 5xx must not be read as consent",
    );
    assert.equal(policyForStatus(200), null, "a 200 means parse the body instead");
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles rather than leaking their contents", () => {
    const text = htmlToText(
      "<style>.a{color:red}</style><script>var x = 'happy hour 4-6pm';</script><p>Real copy</p>",
    );
    assert.equal(text, "Real copy");
  });

  it("keeps block elements on separate lines", () => {
    const text = htmlToText("<p>Happy Hour</p><p>Mon-Fri 4-6pm</p>");
    assert.deepEqual(text.split("\n").filter(Boolean), ["Happy Hour", "Mon-Fri 4-6pm"]);
  });

  it("decodes entities", () => {
    assert.equal(decodeEntities("4&ndash;6pm &amp; more"), "4–6pm & more");
    assert.equal(decodeEntities("&#36;5 drafts"), "$5 drafts");
  });
});

describe("findPromisingLinks", () => {
  const html = `
    <a href="/happy-hour">Happy Hour</a>
    <a href="/specials">Our Specials</a>
    <a href="/menu">Menu</a>
    <a href="/about">About us</a>
    <a href="https://other.example.org/happy-hour">Elsewhere</a>
    <a href="/menu.pdf">Menu PDF</a>
  `;

  it("ranks happy-hour links above weaker signals and drops the rest", () => {
    const links = findPromisingLinks(html, "https://example.com/");
    const paths = links.map((link) => new URL(link.url).pathname);

    assert.equal(paths[0], "/happy-hour", "strongest signal first");
    assert.ok(paths.includes("/specials"));
    assert.ok(!paths.includes("/about"), "no deal signal");
  });

  it("stays on the same origin and skips binaries", () => {
    const links = findPromisingLinks(html, "https://example.com/");
    assert.ok(
      links.every((link) => new URL(link.url).origin === "https://example.com"),
      "does not wander off-site",
    );
    assert.ok(!links.some((link) => link.url.endsWith(".pdf")));
  });
});
