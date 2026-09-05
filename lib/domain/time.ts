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
