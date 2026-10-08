/**
 * Booking trace: how each token came to exist, and whether the allocation
 * followed the rules in force at that moment.
 *
 * Built for one recurring argument — "an online patient got a reserved token"
 * — which used to take half a dozen hand-written SQL queries to settle. Every
 * conclusion here is derived from records the system already keeps
 * (appointments, queue events, the outbox, WhatsApp conversations, capacity
 * changes in the audit log), so the page shows evidence, not opinion.
 *
 * Pure: the service gathers the rows, this module decides what they mean.
 */

export type BookingOrigin =
  | 'desk_walk_in'
  | 'desk_slot'
  | 'whatsapp_queue'
  | 'whatsapp_slot'
  | 'web_slot'
  | 'unknown';

export const ORIGIN_LABEL: Record<BookingOrigin, string> = {
  desk_walk_in: 'Desk walk-in',
  desk_slot: 'Desk slot booking',
  whatsapp_queue: 'Online: WhatsApp queue',
  whatsapp_slot: 'Online: WhatsApp slot',
  web_slot: 'Online: booking page',
  unknown: 'Unknown',
};

export const isOnline = (origin: BookingOrigin): boolean =>
  origin === 'whatsapp_queue' || origin === 'whatsapp_slot' || origin === 'web_slot';

/**
 * Where a booking came from, from the records it left behind.
 *
 * `source` alone cannot say it: WhatsApp and the booking page are both stored
 * as `whatsapp`, and a WhatsApp chat slot and a booking-page slot run through
 * the same code. The chat leaves its own confirmation (an outbox row with
 * template `conversation`), which is the tell.
 */
export function describeOrigin(args: {
  source: 'walk_in' | 'reception' | 'whatsapp';
  scheduledSlotAt: Date | null;
  confirmedInChat: boolean;
}): BookingOrigin {
  if (args.source === 'walk_in' || args.source === 'reception') {
    return args.scheduledSlotAt ? 'desk_slot' : 'desk_walk_in';
  }
  if (args.source === 'whatsapp') {
    if (!args.scheduledSlotAt) return 'whatsapp_queue';
    return args.confirmedInChat ? 'whatsapp_slot' : 'web_slot';
  }
  return 'unknown';
}

/** The capacity settings a doctor had, as recorded by each change in the audit log. */
export type CapacitySettings = { walkInReserved: number; quota: number | null };
export type CapacityChange = { at: Date; before: CapacitySettings; after: CapacitySettings };

/**
 * The settings in force at `at`.
 *
 * The last change at or before that moment, else the "before" side of the
 * first change after it, else today's settings (never changed). `source` says
 * which, so the page can be honest about how it knows.
 */
export function capacityAt(
  changes: CapacityChange[],
  current: CapacitySettings,
  at: Date,
): CapacitySettings & { source: 'change_log' | 'current' } {
  const sorted = [...changes].sort((a, b) => a.at.getTime() - b.at.getTime());
  let found: CapacitySettings | null = null;
  for (const change of sorted) {
    if (change.at.getTime() <= at.getTime()) found = change.after;
  }
  if (found) return { ...found, source: 'change_log' };
  const next = sorted.find((c) => c.at.getTime() > at.getTime());
  if (next) return { ...next.before, source: 'change_log' };
  return { ...current, source: 'current' };
}

export type TraceVerdict = {
  level: 'ok' | 'fault' | 'note';
  message: string;
};

/**
 * Whether a token was allocated correctly, in words a hospital owner can read.
 *
 * The one rule that can be broken: an online patient must never hold a number
 * inside the walk-in reserve (1..W) that was in force when they booked. Slot
 * session numbers (S1, S2…) are their own space and cannot break it.
 */
export function traceVerdict(args: {
  origin: BookingOrigin;
  tokenNumber: number;
  sessionKind: 'queue' | 'slot';
  quotaPool: 'reserved' | 'shared' | 'extra' | null;
  reserveAtBooking: number;
  queueLinkSentToPhone: boolean;
}): TraceVerdict[] {
  const verdicts: TraceVerdict[] = [];
  const online = isOnline(args.origin);
  const W = args.reserveAtBooking;

  if (online && args.sessionKind === 'queue' && W > 0 && args.tokenNumber <= W) {
    verdicts.push({
      level: 'fault',
      message: `Online booking was given token ${args.tokenNumber}, inside the walk-in reserve (1–${W}) in force at the time.`,
    });
  } else if (online && args.sessionKind === 'queue' && W > 0) {
    verdicts.push({
      level: 'ok',
      message: `Online booking took token ${args.tokenNumber}, above the walk-in reserve (1–${W}), as intended.`,
    });
  } else if (online) {
    verdicts.push({ level: 'ok', message: 'Online booking; no walk-in reserve applied to it.' });
  }

  if (!online && args.origin !== 'unknown') {
    verdicts.push({
      level: 'ok',
      message:
        args.quotaPool === 'reserved'
          ? `Entered at the desk and given reserved token ${args.tokenNumber}, which is what the reserve is for.`
          : `Entered at the desk.`,
    });
    if (args.queueLinkSentToPhone) {
      verdicts.push({
        level: 'note',
        message:
          'The patient received a WhatsApp message with their queue link because the desk entered their mobile number. ' +
          'Every walk-in with a phone number gets this; it does not mean they booked online.',
      });
    }
  }

  if (args.quotaPool === 'extra') {
    verdicts.push({ level: 'note', message: 'Issued as an extra token after the day’s quota was full.' });
  }
  return verdicts;
}

/** "+91 98765 •••• 10": enough to recognise a number, not enough to copy it around. */
export function maskPhone(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  if (digits.length < 6) return '••••';
  return `+${digits.slice(0, digits.length - 10 || 2)} ${digits.slice(-10, -5)} •••${digits.slice(-2)}`;
}
