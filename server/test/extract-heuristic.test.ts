import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyCategory,
  extractDealsFromText,
  extractPriceText,
  parseDays,
  parseTimeRanges,
} from "../src/scraper/extract-heuristic.ts";

describe("parseDays", () => {
  it("expands a hyphenated range", () => {
    assert.deepEqual(parseDays("Happy hour Mon-Fri").days, [1, 2, 3, 4, 5]);
  });

  it("expands a range that wraps the week", () => {
    assert.deepEqual(parseDays("Thu through Sun").days, [0, 4, 5, 6]);
  });

  it("reads a comma-and-ampersand list", () => {
    assert.deepEqual(parseDays("Tues, Thurs & Sat only").days, [2, 4, 6]);
  });

  it("understands daily and weekday shorthands", () => {
    assert.deepEqual(parseDays("Available daily").days, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(parseDays("Weekdays only").days, [1, 2, 3, 4, 5]);
    assert.deepEqual(parseDays("Weekends").days, [0, 6]);
  });

  it("falls back to every day but marks the guess", () => {
    const parsed = parseDays("Happy hour 4-6pm");
    assert.deepEqual(parsed.days, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(parsed.explicit, false, "so confidence can be discounted");
  });
});

describe("parseTimeRanges", () => {
  it("borrows the meridiem from the marked side", () => {
    const [range] = parseTimeRanges("Happy hour 4-6pm");
    assert.equal(range?.startMin, 16 * 60);
    assert.equal(range?.endMin, 18 * 60);
  });

  it("reads 11-2pm as late morning to early afternoon", () => {
    // Inheriting "pm" would give 11pm-2pm, which is backwards.
    const [range] = parseTimeRanges("Lunch specials 11-2pm");
    assert.equal(range?.startMin, 11 * 60, "11am, not 11pm");
    assert.equal(range?.endMin, 14 * 60);
  });

  it("carries a window past midnight instead of wrapping", () => {
    const [range] = parseTimeRanges("Late night 10pm-2am");
    assert.equal(range?.startMin, 22 * 60);
    assert.equal(range?.endMin, 26 * 60, "2am is 1560, not 120");
  });

  it("handles half-hour boundaries and 'to'", () => {
    const [range] = parseTimeRanges("Specials 4:30 to 6:30pm");
    assert.equal(range?.startMin, 16 * 60 + 30);
    assert.equal(range?.endMin, 18 * 60 + 30);
  });

  it("resolves noon and midnight", () => {
    const [range] = parseTimeRanges("Open bar noon to midnight");
    assert.equal(range?.startMin, 12 * 60);
    assert.equal(range?.endMin, 24 * 60);
  });

  it("treats 'until close' as 2am and flags the assumption", () => {
    const [range] = parseTimeRanges("Half off drinks 9pm until close");
    assert.equal(range?.startMin, 21 * 60);
    assert.equal(range?.endMin, 26 * 60);
    assert.equal(range?.endedAtClose, true, "so the caller can discount it");
  });

  it("ignores an implausibly long span", () => {
    assert.deepEqual(parseTimeRanges("Open 6am-11pm"), [], "that is opening hours, not a deal");
  });
});

describe("extractPriceText and classifyCategory", () => {
  it("picks out the price as written", () => {
    assert.equal(extractPriceText("$5 drafts all night"), "$5 drafts");
    assert.equal(extractPriceText("Half-price appetizers"), "Half-price");
    assert.equal(extractPriceText("BOGO wings"), "BOGO");
    assert.equal(extractPriceText("No discount here"), null);
  });

  it("classifies by what is on offer", () => {
    assert.equal(classifyCategory("$5 drafts and well cocktails"), "drink");
    assert.equal(classifyCategory("Half off wings and nachos"), "food");
    assert.equal(classifyCategory("$5 drafts and half off wings"), "both");
  });
});

describe("extractDealsFromText", () => {
  it("pulls a standard happy hour off a page", () => {
    const deals = extractDealsFromText(
      "Welcome to our bar\nHappy Hour Mon-Fri 4-6pm: $5 drafts and half off appetizers.\nCome say hi.",
    );

    assert.equal(deals.length, 1);
    const deal = deals[0];
    assert.equal(deal?.title, "Happy Hour");
    assert.equal(deal?.category, "both");
    assert.equal(deal?.priceText, "$5 drafts");
    assert.equal(deal?.windows.length, 5, "one window per weekday");
    assert.deepEqual(deal?.windows[0], { dayOfWeek: 1, startMin: 960, endMin: 1080 });
    assert.ok((deal?.confidence ?? 0) > 0.7, "explicit days and times score high");
  });

  it("does not mistake opening hours for a deal", () => {
    const deals = extractDealsFromText("Hours: Mon-Sun 11am-10pm. Kitchen closes at 9.");
    assert.deepEqual(deals, [], "no deal keyword and no price");
  });

  it("keeps two deals on one page separate", () => {
    const deals = extractDealsFromText(
      "Happy Hour Mon-Thu 3-6pm, $6 cocktails.\nLate Night Happy Hour Fri-Sat 10pm-1am, $4 beers.",
    );
    assert.equal(deals.length, 2);

    const days = deals.map((deal) => deal.windows.map((w) => w.dayOfWeek));
    assert.deepEqual(days[0], [1, 2, 3, 4]);
    assert.deepEqual(days[1], [5, 6]);
    assert.equal(deals[1]?.windows[0]?.endMin, 25 * 60, "1am the next morning");
  });

  it("scores an 'until close' deal below one with a stated end", () => {
    const [stated] = extractDealsFromText("Happy hour Fri 9pm-11pm, $5 beers.");
    const [guessed] = extractDealsFromText("Happy hour Fri 9pm until close, $5 beers.");
    assert.ok(
      (guessed?.confidence ?? 1) < (stated?.confidence ?? 0),
      "the guessed end time is marked as less certain",
    );
  });

  it("discounts a deal whose days it had to assume", () => {
    const [explicit] = extractDealsFromText("Happy hour Monday 4-6pm, $5 drafts.");
    const [assumed] = extractDealsFromText("Happy hour 4-6pm, $5 drafts.");
    assert.ok((assumed?.confidence ?? 1) < (explicit?.confidence ?? 0));
  });

  it("returns nothing for a page with no deals", () => {
    assert.deepEqual(
      extractDealsFromText("Our story began in 1994 when two friends opened a small cafe."),
      [],
    );
  });
});
