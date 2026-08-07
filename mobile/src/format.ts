import type { ApiDeal } from "./api/types";

export function formatDistance(kilometres: number): string {
  if (kilometres < 0.05) return "steps away";
  // Metres up to a kilometre, rounded to the nearest 50 so it reads as an
  // estimate rather than false precision from a phone GPS fix.
  if (kilometres < 1) return `${Math.round((kilometres * 1000) / 50) * 50} m`;
  return `${kilometres.toFixed(1)} km`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

/**
 * The urgency line on a card. "Ends in 25 min" is the thing that decides
 * whether someone leaves now, so it outranks everything else when a deal is
 * close to closing.
 */
export function statusLine(deal: ApiDeal): { text: string; tone: "live" | "soon" | "later" } {
  if (deal.activeNow) {
    return deal.minutesUntilEnd <= 45
      ? { text: `Ends in ${formatMinutes(deal.minutesUntilEnd)}`, tone: "soon" }
      : { text: `On now until ${endLabel(deal)}`, tone: "live" };
  }
  return {
    text: `Starts in ${formatMinutes(deal.minutesUntilStart)}`,
    tone: "later",
  };
}

function endLabel(deal: ApiDeal): string {
  // The window label is "Fri 4pm–6pm"; the end time is the readable half.
  const parts = deal.matchedWindow.label.split("–");
  return parts[1]?.trim() ?? "close";
}

export function categoryLabel(category: ApiDeal["category"]): string {
  if (category === "drink") return "Drinks";
  if (category === "food") return "Food";
  return "Food & drinks";
}

/**
 * Deals carry an extraction confidence. Anything uncertain is labelled in the
 * UI rather than hidden, so people know to call ahead instead of trusting a
 * scraped time that might be stale.
 */
export function confidenceNote(deal: ApiDeal): string | null {
  if (deal.extractedBy === "seed" || deal.extractedBy === "manual") return null;
  if (deal.confidence >= 0.75) return null;
  if (deal.confidence >= 0.5) return "Times may have changed — worth a quick call";
  return "Unconfirmed times — call ahead";
}
