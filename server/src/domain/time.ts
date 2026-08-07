/**
 * Happy hour windows are stored in the venue's *local* wall-clock time, because
 * that is how bars actually publish them ("Mon-Fri 4-6pm"). A window is
 * `(dayOfWeek, startMin, endMin)` where the minutes count from midnight of
 * `dayOfWeek`. `endMin` may exceed 1440 to express a window that runs past
 * midnight: "Fri 10pm-2am" is `(5, 1320, 1560)`, not two separate rows. Storing
 * it as one row keeps "how long until this ends?" a subtraction rather than a
 * join across midnight.
 */

export const MINUTES_PER_DAY = 1440;

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export interface DealWindow {
  dayOfWeek: DayOfWeek;
  startMin: number;
  endMin: number;
}

export interface LocalTime {
  dayOfWeek: DayOfWeek;
  minuteOfDay: number;
}

const WEEKDAY_INDEX: Record<string, DayOfWeek> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock day and minute at `instant`, as seen in `timeZone`. */
export function localTimeAt(instant: Date, timeZone: string): LocalTime {
  const parts = formatterFor(timeZone).formatToParts(instant);
  let weekday: string | undefined;
  let hour: string | undefined;
  let minute: string | undefined;
  for (const part of parts) {
    if (part.type === "weekday") weekday = part.value;
    else if (part.type === "hour") hour = part.value;
    else if (part.type === "minute") minute = part.value;
  }
  const dayOfWeek = weekday === undefined ? undefined : WEEKDAY_INDEX[weekday];
  if (dayOfWeek === undefined || hour === undefined || minute === undefined) {
    throw new Error(`Could not read local time for time zone ${timeZone}`);
  }
  return {
    dayOfWeek,
    minuteOfDay: Number(hour) * 60 + Number(minute),
  };
}

export function isValidWindow(window: DealWindow): boolean {
  return (
    Number.isInteger(window.startMin) &&
    Number.isInteger(window.endMin) &&
    window.startMin >= 0 &&
    window.startMin < MINUTES_PER_DAY &&
    window.endMin > window.startMin &&
    window.endMin <= 2 * MINUTES_PER_DAY
  );
}

/**
 * Project a window onto a minute axis anchored at midnight of `anchorDay`, so
 * windows on the day before/after the query can be compared with plain
 * arithmetic. Returns null when the window's day is more than one day from the
 * anchor and therefore cannot overlap a query of at most 24 hours.
 */
function projectOntoAnchor(
  window: DealWindow,
  anchorDay: DayOfWeek,
): { start: number; end: number } | null {
  for (const dayOffset of [-1, 0, 1] as const) {
    const day = (((anchorDay + dayOffset) % 7) + 7) % 7;
    if (day === window.dayOfWeek) {
      const shift = dayOffset * MINUTES_PER_DAY;
      return { start: window.startMin + shift, end: window.endMin + shift };
    }
  }
  return null;
}

export interface WindowMatch {
  window: DealWindow;
  /** Minutes until the window opens; 0 when it is already open. */
  minutesUntilStart: number;
  /** Minutes until the window closes, from the start of the query range. */
  minutesUntilEnd: number;
  /** True when the window is open at the exact start of the query range. */
  openAtQueryStart: boolean;
}

/**
 * Find the windows that overlap a query range, and how they sit relative to it.
 *
 * `durationMin` of 0 asks "open at exactly this moment"; a positive duration
 * asks "open at any point between now and now + duration", which is what the
 * app's time picker sends when someone plans to head out later.
 */
export function matchWindows(
  windows: readonly DealWindow[],
  queryStart: LocalTime,
  durationMin = 0,
): WindowMatch[] {
  const duration = Math.max(0, Math.min(durationMin, MINUTES_PER_DAY));
  const qStart = queryStart.minuteOfDay;
  const qEnd = qStart + duration;
  const matches: WindowMatch[] = [];

  for (const window of windows) {
    if (!isValidWindow(window)) continue;
    const projected = projectOntoAnchor(window, queryStart.dayOfWeek);
    if (!projected) continue;

    // A zero-length query is a point test (half-open, so a window ending at
    // 18:00 is not "open" at 18:00). A ranged query is an interval overlap.
    const overlaps =
      duration === 0
        ? projected.start <= qStart && qStart < projected.end
        : projected.start < qEnd && qStart < projected.end;
    if (!overlaps) continue;

    matches.push({
      window,
      minutesUntilStart: Math.max(0, projected.start - qStart),
      minutesUntilEnd: projected.end - qStart,
      openAtQueryStart:
        projected.start <= qStart && qStart < projected.end,
    });
  }

  matches.sort((a, b) => a.minutesUntilStart - b.minutesUntilStart);
  return matches;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function formatMinuteOfDay(minute: number): string {
  const wrapped = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour24 = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  const suffix = hour24 < 12 ? "am" : "pm";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minutes === 0
    ? `${hour12}${suffix}`
    : `${hour12}:${String(minutes).padStart(2, "0")}${suffix}`;
}

export function formatWindow(window: DealWindow): string {
  const day = DAY_LABELS[window.dayOfWeek] ?? "?";
  return `${day} ${formatMinuteOfDay(window.startMin)}–${formatMinuteOfDay(window.endMin)}`;
}
