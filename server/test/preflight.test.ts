/**
 * The preflight check is the first thing an operator sees when a crawl will
 * not work, so its verdict has to be right. The case that matters most is a
 * proxy answering 403 on the host's behalf: the request completes, so a naive
 * check reads it as "reachable" and the crawl fails later for invisible
 * reasons.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { preflight } from "../src/scraper/preflight.ts";

function serve(status: number, body = "ok"): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("preflight", () => {
  let ok: Awaited<ReturnType<typeof serve>>;
  let forbidden: Awaited<ReturnType<typeof serve>>;
  let broken: Awaited<ReturnType<typeof serve>>;

  before(async () => {
    ok = await serve(200);
    forbidden = await serve(403, "denied by policy");
    broken = await serve(503);
  });

  after(async () => {
    await Promise.all([ok.close(), forbidden.close(), broken.close()]);
  });

  it("passes when both probes answer normally", async () => {
    const result = await preflight({ overpassUrl: ok.url, webUrl: ok.url });
    assert.equal(result.ok, true);
    assert.equal(result.overpassReachable, true);
    assert.equal(result.webReachable, true);
  });

  it("fails when a proxy answers 403 for everything, and says so", async () => {
    const result = await preflight({ overpassUrl: forbidden.url, webUrl: forbidden.url });
    assert.equal(result.ok, false, "a 403 is not reachable, even though it is not a 5xx");
    assert.match(result.detail, /proxy or network policy/i);
    assert.match(result.detail, /permissions problem/i);
  });

  it("distinguishes Overpass being down from the network being down", async () => {
    const result = await preflight({ overpassUrl: broken.url, webUrl: ok.url });
    assert.equal(result.ok, false);
    assert.equal(result.webReachable, true, "the web is fine");
    assert.equal(result.overpassReachable, false);
    assert.match(result.detail, /mirror|rate-limit/i, "points at the actual fix");
  });

  it("reports a hard connection failure differently from an interception", async () => {
    // Nothing is listening on this port.
    const dead = "http://127.0.0.1:9/";
    const result = await preflight({ overpassUrl: dead, webUrl: dead });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.detail, /proxy or network policy/i);
    assert.match(result.detail, /No outbound internet access/i);
  });
});
