import { serviceDateIn } from './time';

/**
 * Which days of a stay carry a room charge, and in which bed (IPD plan
 * §T1.10, decision D-BD). Pure.
 *
 * The rule, until the pilot says otherwise:
 *
 *   * every calendar day the patient is in a bed is charged, in the
 *     hospital's timezone, starting with the day of admission;
 *   * the day of discharge is not charged — unless admission and discharge
 *     fall on the same day, which is charged once;
 *   * after a transfer, a day is charged to the bed the patient was in at
 *     the start of that day (the admission day: the first bed).
 *
 * A stay still running is charged up to and including today, so the
 * running bill is current; tomorrow is charged tomorrow. The result is the
 * whole list every time: the caller inserts what is missing and the
 * "one line per bed per day" index ignores the rest, so a re-run is free.
 */

export type BedSpell = { assignmentId: string; fromAt: Date; toAt: Date | null };

export type BedDay = { serviceDate: string; assignmentId: string };

/** "2026-10-20" + n days, in calendar arithmetic (no timezone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function chargeableBedDays(args: {
  admittedAt: Date;
  /** When the stay ended (discharge), or null while it runs. */
  endedAt: Date | null;
  spells: readonly BedSpell[];
  now: Date;
  timezone: string;
}): BedDay[] {
  if (args.spells.length === 0) return [];
  const spells = [...args.spells].sort((a, b) => a.fromAt.getTime() - b.fromAt.getTime());
  const day = (at: Date) => serviceDateIn(args.timezone, at);

  const first = day(args.admittedAt);
  let last: string;
  if (args.endedAt) {
    const ended = day(args.endedAt);
    last = ended === first ? first : addDays(ended, -1);
  } else {
    last = day(args.now);
  }
  if (last < first) return [];

  const days: BedDay[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const spell =
      date === first
        ? spells[0]
        : // In a bed that began before this day and had not ended before it.
          (spells.find((s) => day(s.fromAt) < date && (s.toAt === null || day(s.toAt) >= date)) ??
          // A gap (should not happen; beds change in one transaction): the
          // latest bed taken on or before this day.
          [...spells].reverse().find((s) => day(s.fromAt) <= date));
    if (spell) days.push({ serviceDate: date, assignmentId: spell.assignmentId });
  }
  return days;
}
