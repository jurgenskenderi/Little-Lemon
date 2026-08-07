/**
 * Model-based extraction, used for pages the heuristic parser can't read —
 * deals in tables, image captions, or prose like "join us for our afternoon
 * unwind, weekdays before dinner service".
 *
 * The schema is enforced by the API (structured outputs), so the response is
 * either valid against `ExtractionSchema` or an error — there is no JSON
 * parsing or repair loop here. Every window is still re-validated locally
 * before it reaches the database, because a schema-valid answer can still be a
 * wrong one.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { config } from "../config.ts";
import { isValidWindow, type DayOfWeek, type DealWindow } from "../domain/time.ts";
import type { ExtractedDeal } from "./extract-heuristic.ts";

const WindowSchema = z.object({
  dayOfWeek: z
    .number()
    .int()
    .describe("Day of week the window falls on. 0 = Sunday through 6 = Saturday."),
  startMin: z
    .number()
    .int()
    .describe("Start time as minutes after local midnight. 16:00 is 960."),
  endMin: z
    .number()
    .int()
    .describe(
      "End time as minutes after the same midnight. For a window running past " +
        "midnight, keep counting: 2am the next morning is 1560, not 120.",
    ),
});

const DealSchema = z.object({
  title: z.string().describe("Short label, e.g. 'Happy Hour' or '$5 Draft Night'."),
  description: z
    .string()
    .nullable()
    .describe("One sentence on what is included, quoted or closely paraphrased from the page."),
  priceText: z
    .string()
    .nullable()
    .describe("Price as written on the page, e.g. '$5 drafts', 'half off apps'."),
  category: z
    .enum(["drink", "food", "both"])
    .describe("Whether the deal covers drinks, food, or both."),
  finePrint: z
    .string()
    .nullable()
    .describe("Restrictions such as 'bar area only' or 'excludes holidays'."),
  confidence: z
    .number()
    .describe(
      "0 to 1. How confident you are that this deal, with these exact days and " +
        "times, is stated on the page. Use below 0.5 when you inferred the days " +
        "or times rather than reading them.",
    ),
  windows: z.array(WindowSchema).describe("One entry per day the deal runs."),
});

const ExtractionSchema = z.object({
  deals: z
    .array(DealSchema)
    .describe("Every distinct happy hour or recurring deal on the page. Empty if none."),
});

/**
 * Stable across every page, so it sits first in the request and carries the
 * cache breakpoint — each page then only pays for its own text.
 */
const SYSTEM_PROMPT = `You extract recurring food and drink deals from restaurant and bar web pages.

You will be given the visible text of one page, along with the venue's name and
time zone. Return every recurring deal the page states, and nothing else.

## What counts as a deal

Include: happy hours, daily or weekly specials, discounted drinks or food that
recur on a schedule, and late-night or early-bird menus with a stated time range.

Exclude: the venue's opening hours, one-off events with a calendar date, private
event or catering information, delivery promotions, loyalty programmes, and
anything without a recurring time window. Opening hours are the most common
false positive — "Open Mon-Fri 11am-11pm" is not a deal, even on a page that
also lists deals.

## Encoding the schedule

Times are minutes after local midnight on the day the window opens. 4pm is 960,
5:30pm is 1050. When a window runs past midnight, keep counting from the same
midnight rather than wrapping: "Friday 10pm to 2am" is one window with
dayOfWeek 5, startMin 1320, endMin 1560. Do not split it into two windows, and
do not record the end as 120.

Emit one window per day. "Mon-Fri 4-6pm" is five windows with identical times,
not one window with a range of days. A deal with two sittings on the same day
("3-6pm and again 9pm-close") is one deal with two windows on that day.

Interpret times as the venue's local wall-clock time. Ignore the time zone for
arithmetic — it is given only so you can read phrases like "before sunset"
sensibly if they appear. Never convert to UTC.

## Reading ambiguous copy

"Until close" or "till late" has no stated end time. Use 2am the following
morning as the end (endMin 1560 for a window opening the previous evening) and
set confidence at or below 0.4 to mark the guess.

When a page states times without am/pm, prefer the reading that produces a
plausible happy hour: "4-6" is 4pm to 6pm, "11-2" is 11am to 2pm.

When the page names no days at all but clearly describes a recurring deal,
treat it as every day and set confidence at or below 0.4.

## Confidence and honesty

Confidence reflects whether the page actually says what you recorded, not how
good the deal is. Above 0.8 means the days, times, and offer are stated
plainly. Around 0.5 means you resolved a genuine ambiguity. Below 0.4 means you
guessed part of the schedule.

Do not invent a deal that the page does not describe, do not fill in a schedule
the page leaves out, and do not merge two separate offers into one entry. A page
with no qualifying deals must return an empty list — that is a correct answer,
and it is a better one than a plausible-looking guess.`;

export interface ModelExtractionResult {
  deals: ExtractedDeal[];
  /** Populated when the model declined the request rather than answering. */
  refusal: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

const EMPTY: ModelExtractionResult = {
  deals: [],
  refusal: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
};

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!config.anthropicApiKey) return null;
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

export function isModelExtractionAvailable(): boolean {
  return config.anthropicApiKey !== null;
}

/** Keep the page text bounded; deals live in the copy, not in a 200KB footer dump. */
const MAX_PAGE_CHARS = 24_000;

export async function extractDealsWithModel(input: {
  venueName: string;
  timeZone: string;
  url: string;
  pageText: string;
}): Promise<ModelExtractionResult> {
  const anthropic = getClient();
  if (!anthropic) return EMPTY;

  const pageText = input.pageText.slice(0, MAX_PAGE_CHARS);
  if (pageText.trim().length < 40) return EMPTY;

  const response = await anthropic.messages.parse({
    model: config.extractionModel,
    // Thinking is on by default on Opus 5 and shares this budget with the
    // response, so this is sized for both rather than for the JSON alone.
    max_tokens: 8000,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // The prompt is identical for every page, so it is cached once and
        // read back on each subsequent extraction in the run.
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      // Extraction is routine structured work — low effort keeps a bulk crawl
      // affordable without measurably hurting the parse.
      effort: "low",
      format: zodOutputFormat(ExtractionSchema),
    },
    messages: [
      {
        role: "user",
        content: `Venue: ${input.venueName}
Time zone: ${input.timeZone}
Page: ${input.url}

Page text:
"""
${pageText}
"""`,
      },
    ],
  });

  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
  };

  // Safety classifiers can decline a request outright. That is a normal
  // outcome for a bulk crawl over pages we do not control: skip the page and
  // keep going rather than failing the run.
  if (response.stop_reason === "refusal") {
    return {
      ...usage,
      deals: [],
      refusal: response.stop_details?.explanation ?? "model declined the request",
    };
  }

  const parsed = response.parsed_output;
  if (!parsed) return { ...usage, deals: [], refusal: null };

  return { ...usage, refusal: null, deals: normalizeDeals(parsed.deals) };
}

/**
 * Schema conformance is not correctness: a well-formed window can still say
 * `endMin` 120 for a 10pm start. Drop what can't be true rather than storing
 * a deal the app would render as ending before it began.
 */
function normalizeDeals(deals: z.infer<typeof ExtractionSchema>["deals"]): ExtractedDeal[] {
  const normalized: ExtractedDeal[] = [];

  for (const deal of deals) {
    const windows: DealWindow[] = [];
    for (const window of deal.windows) {
      if (!Number.isInteger(window.dayOfWeek) || window.dayOfWeek < 0 || window.dayOfWeek > 6) {
        continue;
      }
      const candidate: DealWindow = {
        dayOfWeek: window.dayOfWeek as DayOfWeek,
        startMin: window.startMin,
        endMin: window.endMin,
      };
      if (isValidWindow(candidate)) windows.push(candidate);
    }

    if (windows.length === 0) continue;
    if (!deal.title.trim()) continue;

    normalized.push({
      title: deal.title.trim().slice(0, 120),
      description: deal.description?.trim().slice(0, 400) ?? null,
      priceText: deal.priceText?.trim().slice(0, 80) ?? null,
      category: deal.category,
      finePrint: deal.finePrint?.trim().slice(0, 200) ?? null,
      windows,
      confidence: Math.max(0, Math.min(1, Number(deal.confidence.toFixed(2)))),
    });
  }

  return normalized;
}
