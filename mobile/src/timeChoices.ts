/**
 * The "when" control.
 *
 * People do not think in timestamps when deciding where to drink — they think
 * "now", "after work", "later tonight". Each choice maps to an instant plus a
 * tolerance window, which is exactly what the API takes.
 */

export interface TimeChoice {
  id: string;
  label: string;
  /** Description shown once selected, so the mapping is never a mystery. */
  describe: (at: Date) => string;
  resolve: (now: Date) => { at: Date; windowMin: number };
}

function atHourToday(now: Date, hour: number): Date {
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  // If that hour has already passed, the user means tomorrow.
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function clockLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export const TIME_CHOICES: TimeChoice[] = [
  {
    id: "now",
    label: "Now",
    describe: () => "Open right now",
    resolve: (now) => ({ at: now, windowMin: 0 }),
  },
  {
    id: "soon",
    label: "Next 2 hrs",
    describe: (at) => `Anytime between ${clockLabel(at)} and two hours from now`,
    resolve: (now) => ({ at: now, windowMin: 120 }),
  },
  {
    id: "plus1",
    label: "In an hour",
    describe: (at) => `Around ${clockLabel(at)}`,
    resolve: (now) => ({
      at: new Date(now.getTime() + 60 * 60_000),
      // A little slack either side, since "in an hour" is not a precise plan.
      windowMin: 30,
    }),
  },
  {
    id: "dinner",
    label: "7pm",
    describe: (at) => `Around ${clockLabel(at)}`,
    resolve: (now) => ({ at: atHourToday(now, 19), windowMin: 60 }),
  },
  {
    id: "late",
    label: "Late night",
    describe: (at) => `From ${clockLabel(at)} onwards`,
    resolve: (now) => ({ at: atHourToday(now, 22), windowMin: 180 }),
  },
];

export const DEFAULT_TIME_CHOICE = TIME_CHOICES[0] as TimeChoice;
