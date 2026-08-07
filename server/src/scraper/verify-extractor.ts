/**
 * Check that model extraction works, without running a crawl.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm run verify:extractor --workspace server
 *
 * Runs the real extractor against a page written to defeat the rule-based
 * parser — the schedule is in prose, the end time is implied, and there is a
 * decoy line of opening hours. If this prints a sensible schedule, the key
 * works and a crawl will use the model where the parser gives up.
 */

import { config } from "../config.ts";
import { formatWindow } from "../domain/time.ts";
import { extractDealsWithModel, isModelExtractionAvailable } from "./extract-model.ts";

const SAMPLE_PAGE = `
The Alder & Oak — Queen West, Toronto

We open our doors at eleven every morning and the kitchen runs until ten.

Unwind with us on weekday afternoons. From four until the dinner rush picks up
at half past six, our bartenders pour local drafts for six dollars and mix the
house cocktails for nine. The kitchen sends out every shared plate at half price
for the same stretch, Monday through Friday.

On Friday and Saturday nights the whole thing comes back once the late crowd
arrives — from ten until we close, drafts are five dollars.

Bar and patio seating only. Not available on holidays.

Private events: enquire at events@example.com.
`;

async function main(): Promise<void> {
  if (!isModelExtractionAvailable()) {
    console.error(
      "ANTHROPIC_API_KEY is not set.\n\n" +
        "  Get a key at https://console.anthropic.com/settings/keys, then either\n" +
        "  put it in server/.env or run:\n\n" +
        "    ANTHROPIC_API_KEY=sk-ant-... npm run verify:extractor --workspace server\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Model: ${config.extractionModel}`);
  console.log("Extracting from a sample page the rule-based parser cannot read…\n");

  const started = Date.now();
  const result = await extractDealsWithModel({
    venueName: "The Alder & Oak",
    timeZone: "America/Toronto",
    url: "https://example.com/happy-hour",
    pageText: SAMPLE_PAGE,
  });

  if (result.refusal) {
    console.error(`The model declined this request: ${result.refusal}`);
    process.exitCode = 1;
    return;
  }

  if (result.deals.length === 0) {
    console.error(
      "The call succeeded but returned no deals. The key works; the extraction\n" +
        "prompt may need attention. Re-run with the page text in hand.",
    );
    process.exitCode = 1;
    return;
  }

  for (const deal of result.deals) {
    console.log(`  ${deal.title}${deal.priceText ? ` — ${deal.priceText}` : ""}`);
    console.log(`    category   ${deal.category}`);
    console.log(`    confidence ${deal.confidence}`);
    for (const window of deal.windows) {
      console.log(`    ${formatWindow(window)}`);
    }
    if (deal.finePrint) console.log(`    fine print: ${deal.finePrint}`);
    console.log();
  }

  console.log(
    `Extracted ${result.deals.length} deal(s) in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(${result.inputTokens} in, ${result.outputTokens} out, ` +
      `${result.cacheReadTokens} cached).`,
  );
  console.log(
    "\nExpected: a weekday happy hour Mon-Fri 4:00pm-6:30pm, and a Fri/Sat late\n" +
      "window from 10pm running past midnight. The opening hours (11am-10pm) and\n" +
      "the private events line must NOT appear as deals.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
