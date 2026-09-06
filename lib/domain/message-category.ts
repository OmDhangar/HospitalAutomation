/**
 * Reporting categories for outbound messages.
 *
 * Derived from the template and milestone already stored on every outbox row
 * rather than from a new column. Nothing needs to be written twice, and
 * historical rows categorise correctly without a backfill.
 */
export const MESSAGE_CATEGORIES = [
  'appointment_confirmation',
  'queue_notification',
  'booking_conversation',
  'owner_report',
  'other',
] as const;

export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export const MESSAGE_CATEGORY_LABELS: Record<MessageCategory, string> = {
  appointment_confirmation: 'Token and queue link',
  queue_notification: 'Queue reminders',
  booking_conversation: 'Booking conversation',
  owner_report: 'Monthly summary',
  other: 'Other',
};

/**
 * `templateCode` is the primary signal; `milestone` disambiguates the
 * conversation messages, which all share one template code but represent
 * distinct steps of a booking.
 */
export function categoriseMessage(args: {
  templateCode: string;
  milestone: string;
}): MessageCategory {
  if (args.templateCode === 'conversation') return 'booking_conversation';
  if (args.milestone.startsWith('conversation:')) return 'booking_conversation';

  switch (args.templateCode) {
    case 'queue_link':
      return 'appointment_confirmation';
    case 'queue_milestone':
      return 'queue_notification';
    case 'owner_monthly_report':
      return 'owner_report';
    default:
      return 'other';
  }
}

/**
 * Whether a message counts against the hospital's allowance.
 *
 * A message we never managed to send costs nothing and must not be billed —
 * Meta charges on delivery, not on intent. Suppressed messages are ones the
 * circuit breaker dropped deliberately, which likewise never reached anybody.
 */
export const isBillableStatus = (status: string): boolean => status === 'sent';
