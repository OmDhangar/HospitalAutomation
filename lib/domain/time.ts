/**
 * A hospital's "today" is not the server's today. A queue that rolls over at
 * UTC midnight would reset itself at 5:30am Indian time, mid-morning-OPD in the
 * worst case, so every service date is resolved in the hospital's timezone.
 */
export function serviceDateIn(timezone: string, at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is also Postgres's date literal format.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function formatTimeIn(timezone: string, at: Date, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

/** "5:15 – 5:30 pm", the only form of ETA we ever show a patient. */
export function formatWindowIn(
  timezone: string,
  start: Date,
  end: Date,
  locale = 'en-IN',
): string {
  return `${formatTimeIn(timezone, start, locale)} – ${formatTimeIn(timezone, end, locale)}`;
}

export const minutesBetween = (from: Date, to: Date): number =>
  (to.getTime() - from.getTime()) / 60_000;

/**
 * How far behind the doctor is running. Positive means late. Returns 0 before
 * the session starts, so a queue that has not opened yet does not report a
 * delay it cannot possibly have accrued.
 */
export function currentDelayMinutes(args: {
  scheduledStartAt: Date | null;
  sessionStartedAt: Date | null;
  now?: Date;
}): number {
  const { scheduledStartAt, sessionStartedAt } = args;
  if (!scheduledStartAt) return 0;

  const reference = sessionStartedAt ?? args.now ?? new Date();
  return Math.max(0, Math.round(minutesBetween(scheduledStartAt, reference)));
}

/** Offset of `timezone` from UTC at instant `at`, in milliseconds. */
function offsetMs(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant a wall-clock time on a service date happens in a timezone:
 * "2026-10-05" + "14:00" in Asia/Kolkata → 08:30Z.
 *
 * Replaces hard-coding +05:30, which is right for India and silently wrong for
 * every other timezone a hospital could be configured with.
 */
export function zonedTimeToUtc(serviceDate: string, time: string, timezone: string): Date {
  const [y, mo, d] = serviceDate.split('-').map(Number);
  const [h, mi, s = 0] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes settle the offset across a DST change.
  let result = guess - offsetMs(timezone, new Date(guess));
  result = guess - offsetMs(timezone, new Date(result));
  return new Date(result);
}
