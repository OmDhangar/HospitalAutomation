import type {
  AppointmentStatus,
  QueueAction,
  QueueEntry,
  QueueTransition,
} from './types';

export class QueueTransitionError extends Error {
  constructor(
    readonly from: AppointmentStatus,
    readonly action: QueueAction,
  ) {
    super(`Cannot ${action} an appointment in state ${from}`);
    this.name = 'QueueTransitionError';
  }
}

/**
 * The full appointment state machine.
 *
 * Note there is no RECALLED state: recalling a skipped patient returns them to
 * WAITING, which is what "recalled" actually means behaviourally. The fact that
 * a recall happened lives in the queue_events log, not in the status column.
 */
const TRANSITIONS: Record<
  AppointmentStatus,
  Partial<Record<QueueAction, AppointmentStatus>>
> = {
  CREATED: { confirm: 'CONFIRMED', cancel: 'CANCELLED', expire: 'EXPIRED' },
  CONFIRMED: {
    arrive: 'ARRIVED',
    enqueue: 'WAITING',
    cancel: 'CANCELLED',
    mark_no_show: 'NO_SHOW',
    expire: 'EXPIRED',
  },
  ARRIVED: {
    enqueue: 'WAITING',
    cancel: 'CANCELLED',
    mark_no_show: 'NO_SHOW',
    expire: 'EXPIRED',
  },
  WAITING: {
    call: 'CALLED',
    hold: 'HELD',
    skip: 'SKIPPED',
    cancel: 'CANCELLED',
    mark_no_show: 'NO_SHOW',
    expire: 'EXPIRED',
  },
  CALLED: {
    start_consultation: 'IN_CONSULTATION',
    complete: 'COMPLETED',
    skip: 'SKIPPED',
    hold: 'HELD',
    cancel: 'CANCELLED',
    expire: 'EXPIRED',
  },
  IN_CONSULTATION: { complete: 'COMPLETED', hold: 'HELD' },
  SKIPPED: {
    recall: 'WAITING',
    mark_no_show: 'NO_SHOW',
    cancel: 'CANCELLED',
    expire: 'EXPIRED',
  },
  HELD: {
    resume: 'WAITING',
    cancel: 'CANCELLED',
    mark_no_show: 'NO_SHOW',
    expire: 'EXPIRED',
  },
  COMPLETED: {},
  CANCELLED: {},
  NO_SHOW: {},
  EXPIRED: {},
};

const TERMINAL: ReadonlySet<AppointmentStatus> = new Set([
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
  'EXPIRED',
]);

/** Statuses that occupy a live position in the queue. */
const ACTIVE: ReadonlySet<AppointmentStatus> = new Set([
  'WAITING',
  'CALLED',
  'IN_CONSULTATION',
]);

/** In-progress patients always sort ahead of waiting ones, whatever their priority. */
const STATUS_WEIGHT: Partial<Record<AppointmentStatus, number>> = {
  IN_CONSULTATION: 0,
  CALLED: 1,
  WAITING: 2,
};

export const isTerminal = (status: AppointmentStatus): boolean =>
  TERMINAL.has(status);

export const isActive = (status: AppointmentStatus): boolean =>
  ACTIVE.has(status);

export const canTransition = (
  from: AppointmentStatus,
  action: QueueAction,
): boolean => TRANSITIONS[from][action] !== undefined;

export function applyAction(
  from: AppointmentStatus,
  action: QueueAction,
): AppointmentStatus {
  const to = TRANSITIONS[from][action];
  if (to === undefined) throw new QueueTransitionError(from, action);
  return to;
}

/** Active entries in the order they will actually be seen. */
export function orderQueue(entries: QueueEntry[]): QueueEntry[] {
  return entries
    .filter((entry) => isActive(entry.status))
    .sort(
      (a, b) =>
        STATUS_WEIGHT[a.status]! - STATUS_WEIGHT[b.status]! ||
        b.priority - a.priority ||
        a.enqueuedAt.getTime() - b.enqueuedAt.getTime() ||
        a.tokenNumber - b.tokenNumber,
    );
}

/**
 * How many patients are genuinely ahead of this one right now.
 * Returns null when the appointment is not in the active queue.
 */
export function patientsAhead(
  entries: QueueEntry[],
  appointmentId: string,
): number | null {
  const index = orderQueue(entries).findIndex(
    (entry) => entry.appointmentId === appointmentId,
  );
  return index === -1 ? null : index;
}

export const currentlyServing = (entries: QueueEntry[]): QueueEntry | null =>
  orderQueue(entries).find(
    (entry) => entry.status === 'CALLED' || entry.status === 'IN_CONSULTATION',
  ) ?? null;

/**
 * One-click "Next" for reception: finish whoever is with the doctor and call
 * the next waiting patient. Returns the transitions to persist, so the caller
 * can write them and their queue events in a single database transaction.
 */
export function callNext(entries: QueueEntry[]): QueueTransition[] {
  const transitions: QueueTransition[] = [];

  const serving = currentlyServing(entries);
  if (serving) {
    transitions.push({
      appointmentId: serving.appointmentId,
      action: 'complete',
      from: serving.status,
      to: applyAction(serving.status, 'complete'),
    });
  }

  const next = orderQueue(entries).find((entry) => entry.status === 'WAITING');
  if (next) {
    transitions.push({
      appointmentId: next.appointmentId,
      action: 'call',
      from: next.status,
      to: applyAction(next.status, 'call'),
    });
  }

  return transitions;
}

/** Tokens are allocated monotonically and never reused within a doctor-day. */
export const nextTokenNumber = (entries: QueueEntry[]): number =>
  entries.reduce((max, entry) => Math.max(max, entry.tokenNumber), 0) + 1;
