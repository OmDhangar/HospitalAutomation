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
 * `tokenNumber` is an identifier, never rewritten: cancelling, arriving early,
 * being prioritised or returning late must not renumber anything. The serving
 * order is derived from these fields by `orderQueue` in ./queue.ts, which is
 * the only place that ordering is defined.
 */
export type QueueEntry = {
  appointmentId: string;
  tokenNumber: number;
  status: AppointmentStatus;
  /** Any value above 0 means "priority". Priority patients are seen FIFO by `prioritySeq`. */
  priority: number;
  /** True if patient was admitted through emergency. Takes top precedence in queue. */
  isEmergency?: boolean;
  enqueuedAt: Date;
  /** Order in which priority was assigned, per doctor-day. Null for legacy rows. */
  prioritySeq?: number | null;
  /** When the patient last left the waiting line by being called. Drives the late-return frontier. */
  calledAt?: Date | null;
  /** Late-return marker: this patient is served right after this token's place in line. */
  queueAfterToken?: number | null;
  /** FIFO among late returners placed behind the same token. */
  rejoinSeq?: number | null;
  /**
   * The serving sequence for the day: 1 for the first patient called, 2 for
   * the next, whatever their tokens. Set when the patient is called. Shown to
   * patients so that serving order reads as order, and a token served early
   * never looks like it jumped the line.
   */
  callNumber?: number | null;
  /**
   * `slot`: booked into a slot-only session, numbered S1, S2… by slot time
   * in a number space of its own. Seen after the live queue, in slot order.
   */
  sessionKind?: 'queue' | 'slot';
};

/**
 * Per-doctor-day settings the ordering needs beyond the rows themselves.
 * Shared by Next and by the ETA so the two can never disagree.
 */
export type QueueContext = {
  /** How many eligible patients a late returner is placed behind. */
  lateRejoinAfter: number;
};

export type QueueTransition = {
  appointmentId: string;
  action: QueueAction;
  from: AppointmentStatus;
  to: AppointmentStatus;
};
