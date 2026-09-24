import type { AppointmentStatus } from './types';

/**
 * What to do with an already-booked appointment when a doctor becomes
 * unavailable for part of a day.
 *
 * Blocking an interval stops *new* bookings landing in that window. It says
 * nothing about the people already holding slots inside it, and they are the
 * ones who will otherwise travel to the hospital to find no doctor. Deciding
 * what happens to each of them is the whole of this file, and it is pure so
 * the rules can be argued about in tests rather than discovered in production.
 */

export type DisruptionAction =
  /** Not here yet. Free the slot and message them to rebook. */
  | 'cancel_and_notify'
  /** Physically in the building. A message alone would be insulting. */
  | 'needs_desk_action'
  /** Already with the doctor, or already finished. Leave it alone. */
  | 'leave_alone';

/**
 * The single most important rule here: presence beats scheduling.
 *
 * A patient whose status is ARRIVED or WAITING is standing in the waiting
 * room. Silently cancelling their appointment and sending a WhatsApp message
 * telling them to book another day would be worse than doing nothing — they
 * would read it while sitting fifteen feet from the reception desk. Those
 * cases are handed to reception to resolve face to face, which is the only
 * way that conversation goes well.
 *
 * CALLED and IN_CONSULTATION are already past the desk. If a doctor walks out
 * mid-consultation, no automated status change helps.
 */
export function disruptionActionFor(status: AppointmentStatus): DisruptionAction {
  switch (status) {
    case 'CREATED':
    case 'CONFIRMED':
      return 'cancel_and_notify';

    case 'ARRIVED':
    case 'WAITING':
    case 'HELD':
    case 'SKIPPED':
      return 'needs_desk_action';

    case 'CALLED':
    case 'IN_CONSULTATION':
    case 'COMPLETED':
    case 'CANCELLED':
    case 'NO_SHOW':
    case 'EXPIRED':
      return 'leave_alone';
  }
}

/**
 * Whether a booked slot falls inside a blocked window.
 *
 * Half-open on purpose: a block of 13:00–14:30 catches the 13:00 slot and
 * leaves the 14:30 one alone. A doctor who says "back by 2:30" means the 2:30
 * appointment is expected to happen, and cancelling it would be cancelling an
 * appointment the doctor intends to keep.
 *
 * Both bounds are minutes-from-midnight in the hospital's own timezone, which
 * is how `doctor_interval_blocks` stores them.
 */
export function slotIsInBlock(args: {
  slotMinutes: number;
  blockStartMinutes: number;
  blockEndMinutes: number;
}): boolean {
  return (
    args.slotMinutes >= args.blockStartMinutes && args.slotMinutes < args.blockEndMinutes
  );
}

/**
 * Minutes from midnight for an instant, in a given timezone.
 *
 * Formatted through Intl rather than by arithmetic on the UTC offset. The slot
 * generator elsewhere in this codebase hardcodes +05:30, which is correct for
 * IST and silently wrong for any hospital that is not; doing it properly here
 * costs nothing and does not inherit that bug.
 */
export function minutesOfDayIn(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');

  // Intl renders midnight as 24 in some locales/engines.
  return (hour % 24) * 60 + minute;
}

/**
 * Whether the patient may still call off their own appointment.
 *
 * The permissive end is deliberate. A patient who cancels ten minutes before
 * their slot is doing the hospital a favour — that slot can be offered to
 * somebody else, and the alternative is a no-show that helps nobody and
 * quietly inflates a metric the hospital is judged on. Making cancellation
 * awkward does not produce attendance, it produces no-shows.
 *
 * CALLED is still allowed: the patient is plainly not there, and an explicit
 * cancellation tells reception more, and sooner, than waiting for them to be
 * skipped. IN_CONSULTATION is where it stops — by then the appointment has
 * happened, and anything after that is a matter for the desk.
 */
export function isCancellableByPatient(status: AppointmentStatus): boolean {
  switch (status) {
    case 'CREATED':
    case 'CONFIRMED':
    case 'ARRIVED':
    case 'WAITING':
    case 'HELD':
    case 'SKIPPED':
    case 'CALLED':
      return true;

    case 'IN_CONSULTATION':
    case 'COMPLETED':
    case 'CANCELLED':
    case 'NO_SHOW':
    case 'EXPIRED':
      return false;
  }
}

export type DisruptionSummary = {
  cancelled: number;
  needsDeskAction: number;
  leftAlone: number;
};

export function summarise(actions: DisruptionAction[]): DisruptionSummary {
  return {
    cancelled: actions.filter((a) => a === 'cancel_and_notify').length,
    needsDeskAction: actions.filter((a) => a === 'needs_desk_action').length,
    leftAlone: actions.filter((a) => a === 'leave_alone').length,
  };
}

/**
 * The sentence reception is shown after blocking an interval.
 *
 * The existing UI says "Time between 13:00 and 14:30 is now unavailable",
 * which is true and dangerously incomplete — it reads as though the problem
 * has been handled while affected patients have been told nothing. This names
 * what happened to real people, and what is still owed to them.
 */
export function disruptionMessage(summary: DisruptionSummary): string {
  const parts: string[] = [];

  parts.push(
    summary.cancelled === 0
      ? 'No upcoming bookings were affected'
      : `${summary.cancelled} booking${summary.cancelled === 1 ? '' : 's'} cancelled, ` +
          `patient${summary.cancelled === 1 ? '' : 's'} messaged to rebook`,
  );

  if (summary.needsDeskAction > 0) {
    parts.push(
      `${summary.needsDeskAction} patient${
        summary.needsDeskAction === 1 ? ' is' : 's are'
      } already waiting — speak to them at the desk`,
    );
  }

  return `${parts.join('. ')}.`;
}
