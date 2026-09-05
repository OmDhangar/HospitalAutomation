export const APPOINTMENT_STATUSES = [
  'CREATED',
  'CONFIRMED',
  'ARRIVED',
  'WAITING',
  'CALLED',
  'IN_CONSULTATION',
  'COMPLETED',
  'SKIPPED',
  'HELD',
  'CANCELLED',
  'NO_SHOW',
  'EXPIRED',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const QUEUE_ACTIONS = [
  'confirm',
  'arrive',
  'enqueue',
  'call',
  'start_consultation',
  'complete',
  'skip',
  'recall',
  'hold',
  'resume',
  'cancel',
  'mark_no_show',
  'expire',
] as const;

export type QueueAction = (typeof QUEUE_ACTIONS)[number];

/**
 * A single patient's place in one doctor's queue for one service date.
 *
 * `tokenNumber` is an identifier, never a rank: cancelling a token must not
 * renumber anything. Ordering is derived from `priority` + `enqueuedAt`.
 */
export type QueueEntry = {
  appointmentId: string;
  tokenNumber: number;
  status: AppointmentStatus;
  /** Higher sorts earlier. 0 is normal; reception raises it for an explicit priority insert. */
  priority: number;
  enqueuedAt: Date;
};

export type QueueTransition = {
  appointmentId: string;
  action: QueueAction;
  from: AppointmentStatus;
  to: AppointmentStatus;
};
