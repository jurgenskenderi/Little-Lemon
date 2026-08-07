/**
 * Rule-based extraction of happy-hour windows from page text.
 *
 * Most bars publish deals in a handful of shapes ("Mon-Fri 4-6pm", "Daily
 * 3–6", "Fri & Sat 10pm-close"), so a parser covers the bulk of pages for no
 * per-page cost. Pages this can't parse fall through to the model extractor.
 * Everything here reports a confidence so ambiguous parses can be filtered or
 * sent for review rather than shown as fact.
 */

import type { DayOfWeek, DealWindow } from "../domain/time.ts";
import { MINUTES_PER_DAY } from "../domain/time.ts";
import type { DealCategory } from "../domain/types.ts";

export interface ExtractedDeal {
  title: string;
  description: string | null;
  priceText: string | null;
  category: DealCategory;
  finePrint: string | null;
  windows: DealWindow[];
  confidence: number;
}

const DAY_TOKENS: Array<[RegExp, DayOfWeek]> = [
  [/^sun(?:day)?$/i, 0],
  [/^mon(?:day)?$/i, 1],
  [/^tue?s?(?:day)?$/i, 2],
  [/^wed(?:nesday|s)?$/i, 3],
  [/^thu(?:rs?(?:day)?)?$/i, 4],
  [/^fri(?:day)?$/i, 5],
  [/^sat(?:urday)?$/i, 6],
];

const DAY_WORD =
  /\b(sun(?:day)?|mon(?:day)?|tue?s?(?:day)?|wed(?:nesday|s)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?)\b/gi;

const RANGE_CONNECTOR = /^[\s]*(?:-|–|—|to|thru|through|til|till|until)[\s]*$/i;
const LIST_CONNECTOR = /^[\s]*(?:,|&|and|\/|\+)[\s]*$/i;

const ALL_DAYS: DayOfWeek[] = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS: DayOfWeek[] = [1, 2, 3, 4, 5];
const WEEKEND: DayOfWeek[] = [0, 6];

function dayFromToken(token: string): DayOfWeek | null {
  for (const [pattern, day] of DAY_TOKENS) {
    if (pattern.test(token)) return day;
  }
  return null;
}

function expandDayRange(from: DayOfWeek, to: DayOfWeek): DayOfWeek[] {
  const days: DayOfWeek[] = [];
  // Ranges wrap the week: "Thu-Sun" is Thu, Fri, Sat, Sun.
  for (let offset = 0; offset < 7; offset += 1) {
    const day = ((from + offset) % 7) as DayOfWeek;
    days.push(day);
    if (day === to) break;
  }
  return days;
}

export interface ParsedDays {
  days: DayOfWeek[];
  /** False when we fell back to "every day" rather than reading it off the page. */
  explicit: boolean;
}

export function parseDays(text: string): ParsedDays {
  const lower = text.toLowerCase();

  if (/\b(?:every\s?day|everyday|daily|all week|7 days a week|seven days)\b/.test(lower)) {
    return { days: [...ALL_DAYS], explicit: true };
  }

  const named: DayOfWeek[] = [];
  const matches = [...text.matchAll(DAY_WORD)];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (!match) continue;
    const day = dayFromToken(match[0]);
    if (day === null) continue;

    const next = matches[i + 1];
    if (next && match.index !== undefined && next.index !== undefined) {
      const between = text.slice(match.index + match[0].length, next.index);
      const nextDay = dayFromToken(next[0]);
      if (nextDay !== null && RANGE_CONNECTOR.test(between)) {
        named.push(...expandDayRange(day, nextDay));
        i += 1; // The range consumed the next token too.
        continue;
      }
      if (nextDay !== null && LIST_CONNECTOR.test(between)) {
        named.push(day);
        continue;
      }
    }
    named.push(day);
  }

  if (named.length > 0) {
    return { days: [...new Set(named)].sort((a, b) => a - b), explicit: true };
  }

  if (/\bweek\s?days?\b/.test(lower)) return { days: [...WEEKDAYS], explicit: true };
  if (/\bweek\s?ends?\b/.test(lower)) return { days: [...WEEKEND], explicit: true };

  // No day mentioned. Most pages that omit it mean "every day", but the guess
  // is why this path reports explicit: false and costs confidence.
  return { days: [...ALL_DAYS], explicit: false };
}

interface RawTime {
  hour: number;
  minute: number;
  meridiem: "am" | "pm" | null;
}

function normalizeMeridiem(raw: string | undefined): "am" | "pm" | null {
  if (!raw) return null;
  return raw.replace(/[.\s]/g, "").toLowerCase().startsWith("a") ? "am" : "pm";
}

function toMinutes(time: RawTime, assumed: "am" | "pm"): number {
  const meridiem = time.meridiem ?? assumed;
  let hour = time.hour % 12;
  if (meridiem === "pm") hour += 12;
  return hour * 60 + time.minute;
}

export interface ParsedTimeRange {
  startMin: number;
  endMin: number;
  /** True when at least one side of the range spelled out am/pm. */
  meridiemExplicit: boolean;
  /** True when the end came from "close" rather than a stated time. */
  endedAtClose: boolean;
}

const TIME_RANGE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|thru|through|til|till|until)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi;

/**
 * Replace time words with numeric equivalents so one regex handles them all.
 * "until close" is deliberately contextual — a bare "close" elsewhere in the
 * sentence ("close to the park") must not become a time.
 */
function normalizeTimeWords(text: string): { text: string; usedClose: boolean } {
  let usedClose = false;
  let normalized = text
    .replace(/\bnoon\b/gi, "12:00pm")
    .replace(/\bmidnight\b/gi, "12:00am");

  normalized = normalized.replace(
    /(-|–|—|to|thru|through|til|till|until)\s*(?:closing|close|last call)\b/gi,
    (_match, connector: string) => {
      usedClose = true;
      return `${connector} 2:00am`;
    },
  );

  return { text: normalized, usedClose };
}

export function parseTimeRanges(text: string): ParsedTimeRange[] {
  const { text: normalized, usedClose } = normalizeTimeWords(text);
  const ranges: ParsedTimeRange[] = [];

  for (const match of normalized.matchAll(TIME_RANGE)) {
    const startHour = Number(match[1]);
    const endHour = Number(match[4]);
    if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) continue;
    if (startHour < 1 || startHour > 24 || endHour < 1 || endHour > 24) continue;

    const start: RawTime = {
      hour: startHour === 24 ? 0 : startHour,
      minute: Number(match[2] ?? 0),
      meridiem: normalizeMeridiem(match[3]),
    };
    const end: RawTime = {
      hour: endHour === 24 ? 0 : endHour,
      minute: Number(match[5] ?? 0),
      meridiem: normalizeMeridiem(match[6]),
    };
    if (start.minute > 59 || end.minute > 59) continue;

    const meridiemExplicit = start.meridiem !== null || end.meridiem !== null;

    // "4-6pm": the unmarked side borrows the marked one. Happy hours skew
    // afternoon/evening, so an entirely unmarked range assumes pm.
    const assumed = end.meridiem ?? start.meridiem ?? "pm";
    let startMin = toMinutes(start, start.meridiem ?? assumed);
    let endMin = toMinutes(end, end.meridiem ?? assumed);

    if (endMin <= startMin && start.meridiem === null && end.meridiem === "pm") {
      // "11-2pm" reads as 11am to 2pm, not 11pm to 2pm.
      startMin = toMinutes(start, "am");
    }
    if (endMin <= startMin) {
      // Still inverted, so it runs past midnight: "10pm-2am".
      endMin += MINUTES_PER_DAY;
    }

    // A span this long is opening hours ("6am-11pm"), not a deal window. The
    // cap sits above a genuine all-day promotion ("noon to midnight") and
    // below a full trading day.
    if (endMin - startMin > 14 * 60) continue;

    ranges.push({
      startMin,
      endMin,
      meridiemExplicit,
      endedAtClose: usedClose,
    });
  }

  return ranges;
}

// Ordered most specific first: "$5 drafts" is a better answer than "$5", and
// the first pattern to match wins.
const PRICE_PATTERNS: RegExp[] = [
  // One optional adjective is allowed between the price and the noun, so
  // "$6 local pints" reads as well as "$6 pints".
  /\$\s?\d+(?:\.\d{2})?\s*(?:[a-z]+\s+)?(?:drafts?|draughts?|beers?|wells?|wines?|cocktails?|shots?|apps?|appetizers?|pints?|tacos?|oysters?|glasses?|pitchers?)\b/i,
  /\bhalf[-\s]?(?:off|price)\b/i,
  /\b(?:2|two)\s*for\s*(?:1|one)\b/i,
  /\bbogo\b/i,
  /\b\d{1,2}%\s*off\b/i,
  /\$\s?\d+(?:\.\d{2})?(?:\s*(?:off|and up|\+))?/i,
];

export function extractPriceText(text: string): string | null {
  for (const pattern of PRICE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0].trim();
  }
  return null;
}

const DRINK_WORDS =
  /\b(drinks?|beers?|drafts?|draughts?|wines?|cocktails?|wells?|pints?|margarita|sangria|spirits?|shots?|martini|whisk(?:e)?y|tequila|prosecco|bubbles)\b/i;
const FOOD_WORDS =
  /\b(food|apps?|appetizers?|small plates?|bites?|snacks?|tacos?|wings?|oysters?|pizza|burgers?|sliders?|nachos?|fries)\b/i;

export function classifyCategory(text: string): DealCategory {
  const hasDrink = DRINK_WORDS.test(text);
  const hasFood = FOOD_WORDS.test(text);
  if (hasDrink && !hasFood) return "drink";
  if (hasFood && !hasDrink) return "food";
  return "both";
}

const FINE_PRINT =
  /\b(dine[-\s]?in only|bar (?:area|seating) only|not valid|excludes?|except|no substitutions|while supplies last|holidays? excluded|21\+|with purchase)\b[^.\n]*/i;

const DEAL_KEYWORD = /\b(happy hour|specials?|deals?|hh)\b/i;

/** Break page text into units small enough that one deal doesn't bleed into the next. */
function candidateSegments(text: string): string[] {
  const segments: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 600) continue;
    // Long lines usually concatenate several claims; split on sentence ends
    // and bullets so each deal keeps its own days and times.
    if (trimmed.length > 160) {
      for (const part of trimmed.split(/(?<=[.!?])\s+|\s*[•|]\s*/)) {
        const piece = part.trim();
        if (piece) segments.push(piece);
      }
    } else {
      segments.push(trimmed);
    }
  }
  return segments;
}

function scoreConfidence(options: {
  hasKeyword: boolean;
  daysExplicit: boolean;
  meridiemExplicit: boolean;
  endedAtClose: boolean;
}): number {
  let score = 0.45;
  if (options.hasKeyword) score += 0.2;
  if (options.daysExplicit) score += 0.12;
  if (options.meridiemExplicit) score += 0.1;
  else score -= 0.12;
  if (options.endedAtClose) score -= 0.2;
  return Math.max(0.05, Math.min(0.95, Number(score.toFixed(2))));
}

function titleFor(segment: string, priceText: string | null): string {
  if (/happy hour/i.test(segment)) return "Happy Hour";
  if (priceText) return `${priceText} special`;
  if (/\bspecials?\b/i.test(segment)) return "Specials";
  return "Drink & food special";
}

export function extractDealsFromText(text: string): ExtractedDeal[] {
  const deals = new Map<string, ExtractedDeal>();

  for (const segment of candidateSegments(text)) {
    const ranges = parseTimeRanges(segment);
    if (ranges.length === 0) continue;

    const hasKeyword = DEAL_KEYWORD.test(segment);
    const { days, explicit: daysExplicit } = parseDays(segment);

    // Without a deal keyword, a bare time range is probably opening hours.
    if (!hasKeyword && !extractPriceText(segment)) continue;

    const priceText = extractPriceText(segment);
    const windows: DealWindow[] = [];
    let meridiemExplicit = false;
    let endedAtClose = false;

    for (const range of ranges) {
      meridiemExplicit ||= range.meridiemExplicit;
      endedAtClose ||= range.endedAtClose;
      for (const day of days) {
        windows.push({ dayOfWeek: day, startMin: range.startMin, endMin: range.endMin });
      }
    }
    if (windows.length === 0) continue;

    const title = titleFor(segment, priceText);
    const confidence = scoreConfidence({
      hasKeyword,
      daysExplicit,
      meridiemExplicit,
      endedAtClose,
    });

    const key = `${title}|${windows
      .map((w) => `${w.dayOfWeek}:${w.startMin}:${w.endMin}`)
      .sort()
      .join(",")}`;

    const existing = deals.get(key);
    if (existing) {
      // Same deal seen twice on the page; keep the better-evidenced parse.
      if (confidence > existing.confidence) existing.confidence = confidence;
      continue;
    }

    deals.set(key, {
      title,
      description: segment.slice(0, 400),
      priceText,
      category: classifyCategory(segment),
      finePrint: FINE_PRINT.exec(segment)?.[0]?.trim() ?? null,
      windows,
      confidence,
    });
  }

  return [...deals.values()];
}
