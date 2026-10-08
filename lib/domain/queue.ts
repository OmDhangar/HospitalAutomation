import type {
  AppointmentStatus,
  QueueAction,
  QueueContext,
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

/**
 * Whether an appointment in this status should count as occupying a booked
 * slot for availability purposes.
 *
 * Terminal states release their slot — a cancellation should make the time
 * bookable again. HELD does NOT release its slot: the appointment is
 * temporarily paused but still "alive", and giving its slot away while the
 * patient is getting a test done would be wrong.
 */
export const occupiesBookingSlot = (status: AppointmentStatus): boolean =>
  !TERMINAL.has(status);

/**
 * Whether an appointment in this status can be cancelled.
 * Terminal states cannot be cancelled (they already are, or are completed).
 */
export const canCancel = (status: AppointmentStatus): boolean =>
  TRANSITIONS[status].cancel !== undefined;

/**
 * Whether a doctor can pause (hold) an appointment in this status.
 * Only appointments currently being seen or waiting can be paused.
 */
export const canPause = (status: AppointmentStatus): boolean =>
  TRANSITIONS[status].hold !== undefined;

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

/* ------------------------------------------------------------ ordering */

/**
 * Default for `QueueContext.lateRejoinAfter`, matching the hospitals column
 * default. A late returner is seen after the next two patients who are here.
 */
export const DEFAULT_LATE_REJOIN_AFTER = 2;

const DEFAULT_CONTEXT: QueueContext = { lateRejoinAfter: DEFAULT_LATE_REJOIN_AFTER };

export const isEmergency = (entry: QueueEntry): boolean => Boolean(entry.isEmergency);

const isPriority = (entry: QueueEntry): boolean => entry.priority > 0 || Boolean(entry.isEmergency);

/**
 * Whether Next may call this patient right now: anyone WAITING.
 *
 * There is one queue. A patient who is not there when called is put on hold
 * (HELD) by the desk, which takes them out of the line; Resume brings them
 * back under the late-return rule. Held, skipped and terminal patients are
 * never eligible.
 */
export const isEligible = (entry: QueueEntry): boolean => entry.status === 'WAITING';

const isServing = (entry: QueueEntry): boolean =>
  entry.status === 'CALLED' || entry.status === 'IN_CONSULTATION';

const kindOf = (entry: QueueEntry): 'queue' | 'slot' => entry.sessionKind ?? 'queue';

/** What a patient and the desk see as the token: "S3" for a booked evening slot, "12" otherwise. */
export const tokenLabel = (sessionKind: 'queue' | 'slot' | null | undefined, tokenNumber: number): string =>
  sessionKind === 'slot' ? `S${tokenNumber}` : String(tokenNumber);

/**
 * Where a normal (non-priority) patient sits in line.
 *
 * Their own token, unless they came back after their turn had passed: then
 * just behind the token recorded in `queueAfterToken`. The half step puts them
 * after that token and before the next whole one, without rewriting any row.
 */
const normalKey = (entry: QueueEntry): number =>
  entry.queueAfterToken != null ? entry.queueAfterToken + 0.5 : entry.tokenNumber;

const NO_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * The single comparator for the serving order. Next and the ETA both use it.
 *
 * 1. Whoever is with the doctor (in consultation, then called).
 * 2. Emergency patients (isEmergency: true) — highest priority among waiting.
 * 3. Priority patients, first-come first-served by when priority was given.
 *    A newly prioritised patient never overtakes an earlier one. Legacy rows
 *    without a sequence fall back to enqueue time, after the sequenced ones.
 * 4. Everyone else by token — the token is a stable place in line, so an early
 *    arrival with a later token waits for earlier tokens who are present, but
 *    not for those who are not (that part is eligibility, not order).
 *    Live-queue tokens come before slot-session ones: the evening's booked
 *    slots follow whoever is left from the afternoon queue, and their S-numbers
 *    already run in slot-time order.
 */
function compare(a: QueueEntry, b: QueueEntry): number {
  const weight = STATUS_WEIGHT[a.status]! - STATUS_WEIGHT[b.status]!;
  if (weight !== 0) return weight;

  const aEmerg = isEmergency(a);
  const bEmerg = isEmergency(b);
  if (aEmerg !== bEmerg) return aEmerg ? -1 : 1;

  if (aEmerg) {
    return (
      (a.prioritySeq ?? NO_SEQ) - (b.prioritySeq ?? NO_SEQ) ||
      a.enqueuedAt.getTime() - b.enqueuedAt.getTime() ||
      a.tokenNumber - b.tokenNumber
    );
  }

  const aPriority = isPriority(a);
  const bPriority = isPriority(b);
  if (aPriority !== bPriority) return aPriority ? -1 : 1;

  if (aPriority) {
    return (
      (a.prioritySeq ?? NO_SEQ) - (b.prioritySeq ?? NO_SEQ) ||
      a.enqueuedAt.getTime() - b.enqueuedAt.getTime() ||
      a.tokenNumber - b.tokenNumber
    );
  }

  const kind = kindOf(a) === kindOf(b) ? 0 : kindOf(a) === 'queue' ? -1 : 1;
  return (
    kind ||
    normalKey(a) - normalKey(b) ||
    (a.rejoinSeq ?? 0) - (b.rejoinSeq ?? 0) ||
    a.tokenNumber - b.tokenNumber
  );
}

/** Active entries (with the doctor, then waiting) in the order they will be seen. */
export function orderQueue(entries: QueueEntry[]): QueueEntry[] {
  return entries.filter((entry) => isActive(entry.status)).sort(compare);
}

/**
 * The late-return frontier: the highest token among normal patients who have
 * been called today. A patient below it has had their turn pass them by.
 *
 * Priority patients are excluded — calling a priority token 90 early does not
 * mean tokens 41 to 89 have been passed. Measured within one number space:
 * calling S5 in the evening says nothing about live-queue token 3.
 */
export function lateFrontier(entries: QueueEntry[], sessionKind: 'queue' | 'slot' = 'queue'): number {
  return entries.reduce(
    (max, entry) =>
      entry.calledAt && !isPriority(entry) && kindOf(entry) === sessionKind
        ? Math.max(max, entry.tokenNumber)
        : max,
    0,
  );
}

/** Whether this patient, on becoming eligible again, came back after their turn passed. */
export const isLateReturn = (entries: QueueEntry[], entry: QueueEntry): boolean =>
  entry.tokenNumber < lateFrontier(entries, kindOf(entry));

/**
 * Where a late returner goes: behind the next N eligible normal patients.
 *
 * Returns the `queueAfterToken` marker to store, or null for "their own token
 * position" — used when N is 0, or when nobody is eligible (they are next
 * either way). With fewer than N eligible they go behind the last of them.
 *
 * The marker is the anchor's own sort key, so placing behind someone who is
 * themselves a late returner still lands after them (the larger `rejoinSeq`
 * breaks the tie).
 */
export function lateReturnAnchor(
  entries: QueueEntry[],
  selfId: string,
  ctx: QueueContext = DEFAULT_CONTEXT,
): number | null {
  if (ctx.lateRejoinAfter <= 0) return null;
  const self = entries.find((entry) => entry.appointmentId === selfId);
  // The anchor is a token in the returner's own number space.
  const line = orderQueue(entries).filter(
    (entry) =>
      entry.appointmentId !== selfId &&
      isEligible(entry) &&
      !isPriority(entry) &&
      (!self || kindOf(entry) === kindOf(self)),
  );
  if (line.length === 0) return null;
  const anchor = line[Math.min(ctx.lateRejoinAfter, line.length) - 1];
  return anchor.queueAfterToken ?? anchor.tokenNumber;
}

/** The patient Next would call now, or null if nobody present is waiting. */
export const nextEligible = (entries: QueueEntry[]): QueueEntry | null =>
  orderQueue(entries).find(isEligible) ?? null;

/**
 * How many patients will be seen before this one — the ETA's "ahead".
 *
 * Counted on the exact order Next uses: serving patients plus waiting
 * patients sorted before them. Held and skipped patients are not counted;
 * they are out of the line, so they are not workload ahead.
 *
 * For a held or skipped patient this is a projection: the place they would
 * take if resumed now, including the late-return placement a resume would
 * give them. Returns null for a patient who is finished with or not found.
 */
export function patientsAhead(
  entries: QueueEntry[],
  appointmentId: string,
  ctx: QueueContext = DEFAULT_CONTEXT,
): number | null {
  const self = entries.find((entry) => entry.appointmentId === appointmentId);
  if (!self || isTerminal(self.status)) return null;

  let projected = entries;
  if (!isServing(self) && !isEligible(self)) {
    const late = isLateReturn(entries, self);
    const asReturned: QueueEntry = {
      ...self,
      status: 'WAITING',
      ...(late
        ? { queueAfterToken: lateReturnAnchor(entries, self.appointmentId, ctx), rejoinSeq: NO_SEQ }
        : {}),
    };
    projected = entries.map((entry) => (entry === self ? asReturned : entry));
  }

  let ahead = 0;
  for (const entry of orderQueue(projected)) {
    if (entry.appointmentId === appointmentId) return ahead;
    if (isServing(entry) || isEligible(entry)) ahead += 1;
  }
  return null;
}

/**
 * The call number a patient has, or will get if things stay as they are.
 *
 * Called patients keep the number they were called with. Waiting patients get
 * the next numbers after the last one issued, in exactly the order Next will
 * call them — derived from `patientsAhead`, so the call number, Next and the
 * ETA can never disagree. Priority or a late return ahead can move a
 * projected number by one; the token never moves. Null when finished with.
 */
export function projectedCallNumber(
  entries: QueueEntry[],
  appointmentId: string,
  lastCallNumber: number,
  ctx: QueueContext = DEFAULT_CONTEXT,
): number | null {
  const self = entries.find((entry) => entry.appointmentId === appointmentId);
  if (!self || isTerminal(self.status)) return null;
  if (isServing(self)) return self.callNumber ?? null;
  const ahead = patientsAhead(entries, appointmentId, ctx);
  if (ahead === null) return null;
  const serving = entries.filter((entry) => isActive(entry.status) && isServing(entry)).length;
  return lastCallNumber + (ahead - serving) + 1;
}

/** 1-based place among waiting priority patients ("Priority #2"), or null. */
export function priorityRank(entries: QueueEntry[], appointmentId: string): number | null {
  const line = orderQueue(entries).filter(
    (entry) => entry.status === 'WAITING' && isPriority(entry),
  );
  const index = line.findIndex((entry) => entry.appointmentId === appointmentId);
  return index === -1 ? null : index + 1;
}

export const currentlyServing = (entries: QueueEntry[]): QueueEntry | null =>
  orderQueue(entries).find(isServing) ?? null;

/**
 * One-click "Next" for reception: finish whoever is with the doctor and call
 * the next waiting patient (priority first, then the queue order). Returns the
 * transitions to persist, so the caller can write them and their queue events
 * in a single database transaction.
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

  const next = nextEligible(entries);
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
