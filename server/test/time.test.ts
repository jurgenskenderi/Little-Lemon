import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatWindow,
  isValidWindow,
  localTimeAt,
  matchWindows,
  type DealWindow,
} from "../src/domain/time.ts";

const FRIDAY_HAPPY_HOUR: DealWindow = { dayOfWeek: 5, startMin: 960, endMin: 1080 }; // Fri 4-6pm
const FRIDAY_LATE_NIGHT: DealWindow = { dayOfWeek: 5, startMin: 1320, endMin: 1560 }; // Fri 10pm-2am

describe("localTimeAt", () => {
  it("reads wall-clock time in the venue's zone, not the server's", () => {
    // 2026-08-07T02:30:00Z is Thursday evening in Los Angeles.
    const instant = new Date("2026-08-07T02:30:00Z");
    const seattle = localTimeAt(instant, "America/Los_Angeles");
    assert.equal(seattle.dayOfWeek, 4, "Thursday in Pacific time");
    assert.equal(seattle.minuteOfDay, 19 * 60 + 30, "19:30 local");

    const london = localTimeAt(instant, "Europe/London");
    assert.equal(london.dayOfWeek, 5, "already Friday in London");
    assert.equal(london.minuteOfDay, 3 * 60 + 30);
  });

  it("tracks daylight saving transitions", () => {
    // Same UTC hour either side of the US spring-forward date.
    const winter = localTimeAt(new Date("2026-01-15T20:00:00Z"), "America/Los_Angeles");
    const summer = localTimeAt(new Date("2026-07-15T20:00:00Z"), "America/Los_Angeles");
    assert.equal(winter.minuteOfDay, 12 * 60, "PST is UTC-8");
    assert.equal(summer.minuteOfDay, 13 * 60, "PDT is UTC-7");
  });
});

describe("matchWindows — point-in-time queries", () => {
  it("matches a window that is open right now", () => {
    const matches = matchWindows([FRIDAY_HAPPY_HOUR], { dayOfWeek: 5, minuteOfDay: 1000 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.openAtQueryStart, true);
    assert.equal(matches[0]?.minutesUntilStart, 0);
    assert.equal(matches[0]?.minutesUntilEnd, 80);
  });

  it("treats the window as half-open so a deal ending at 6pm is over at 6pm", () => {
    const atFive = matchWindows([FRIDAY_HAPPY_HOUR], { dayOfWeek: 5, minuteOfDay: 960 });
    assert.equal(atFive.length, 1, "open exactly at the start");

    const atSix = matchWindows([FRIDAY_HAPPY_HOUR], { dayOfWeek: 5, minuteOfDay: 1080 });
    assert.equal(atSix.length, 0, "closed exactly at the end");
  });

  it("does not match a window on a different day", () => {
    const matches = matchWindows([FRIDAY_HAPPY_HOUR], { dayOfWeek: 3, minuteOfDay: 1000 });
    assert.equal(matches.length, 0);
  });
});

describe("matchWindows — windows running past midnight", () => {
  it("is open at 12:30am Saturday for a window that opened Friday night", () => {
    // The key case: it is Saturday by the calendar, but the deal is a Friday row.
    const matches = matchWindows([FRIDAY_LATE_NIGHT], { dayOfWeek: 6, minuteOfDay: 30 });
    assert.equal(matches.length, 1, "Friday's late window is still running");
    assert.equal(matches[0]?.openAtQueryStart, true);
    assert.equal(matches[0]?.minutesUntilEnd, 90, "90 minutes until 2am");
  });

  it("is closed at 2:30am Saturday, after the Friday window ended", () => {
    const matches = matchWindows([FRIDAY_LATE_NIGHT], { dayOfWeek: 6, minuteOfDay: 150 });
    assert.equal(matches.length, 0);
  });

  it("does not match Saturday's own late window from Friday evening", () => {
    const saturdayLate: DealWindow = { dayOfWeek: 6, startMin: 1320, endMin: 1560 };
    const matches = matchWindows([saturdayLate], { dayOfWeek: 5, minuteOfDay: 1400 });
    assert.equal(matches.length, 0, "Saturday 10pm has not arrived on Friday night");
  });

  it("handles a Sunday-into-Monday window across the week boundary", () => {
    const sundayLate: DealWindow = { dayOfWeek: 0, startMin: 1380, endMin: 1500 }; // Sun 11pm-1am
    const matches = matchWindows([sundayLate], { dayOfWeek: 1, minuteOfDay: 30 });
    assert.equal(matches.length, 1, "Monday 00:30 falls inside Sunday's window");
  });
});

describe("matchWindows — ranged queries", () => {
  it("finds a deal that starts later in the requested range", () => {
    // "I'm heading out around 3, what's on between now and 6?"
    const matches = matchWindows([FRIDAY_HAPPY_HOUR], { dayOfWeek: 5, minuteOfDay: 900 }, 180);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.openAtQueryStart, false, "not open yet at 3pm");
    assert.equal(matches[0]?.minutesUntilStart, 60, "starts in an hour");
  });

  it("excludes a deal that ends before the range begins", () => {
    const matches = matchWindows([FRIDAY_HAPPY_HOUR], { dayOfWeek: 5, minuteOfDay: 1100 }, 120);
    assert.equal(matches.length, 0);
  });

  it("finds a late-night window from an evening search", () => {
    const matches = matchWindows([FRIDAY_LATE_NIGHT], { dayOfWeek: 5, minuteOfDay: 1200 }, 240);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.minutesUntilStart, 120);
  });

  it("orders results so the soonest window comes first", () => {
    const matches = matchWindows(
      [FRIDAY_LATE_NIGHT, FRIDAY_HAPPY_HOUR],
      { dayOfWeek: 5, minuteOfDay: 900 },
      720,
    );
    assert.equal(matches.length, 2);
    assert.equal(matches[0]?.window.startMin, 960, "4pm before 10pm");
  });
});

describe("isValidWindow", () => {
  it("rejects windows that cannot describe a real schedule", () => {
    assert.equal(isValidWindow({ dayOfWeek: 5, startMin: 960, endMin: 960 }), false, "zero length");
    assert.equal(isValidWindow({ dayOfWeek: 5, startMin: 1080, endMin: 960 }), false, "inverted");
    assert.equal(isValidWindow({ dayOfWeek: 5, startMin: -1, endMin: 100 }), false, "negative");
    assert.equal(isValidWindow({ dayOfWeek: 5, startMin: 100, endMin: 3000 }), false, "over two days");
  });

  it("accepts a window that runs past midnight", () => {
    assert.equal(isValidWindow(FRIDAY_LATE_NIGHT), true);
  });
});

describe("formatWindow", () => {
  it("renders times the way a listing would", () => {
    assert.equal(formatWindow(FRIDAY_HAPPY_HOUR), "Fri 4pm–6pm");
    assert.equal(formatWindow(FRIDAY_LATE_NIGHT), "Fri 10pm–2am");
    assert.equal(
      formatWindow({ dayOfWeek: 2, startMin: 690, endMin: 750 }),
      "Tue 11:30am–12:30pm",
    );
  });
});
