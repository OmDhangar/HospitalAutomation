/**
 * Test orders and follow-up (IPD sheets plan C4a, Rev 5.1; migration 0047). Pure.
 *
 * The doctor sends a patient for a test. The test is done at a service point
 * (a lab or a room) whose staff watch a worklist. If the patient has not
 * arrived within the service point's set time — counted from the order, or
 * from payment (D-LABCLOCK) — a "not arrived" task is raised for that staff;
 * if nobody calls within 15 more minutes it is raised to the admin (D-LABFU).
 * Calls only, no WhatsApp (D-LABMSG).
 */

export class TestOrderError extends Error {}

export const SERVICE_POINT_KINDS = {
  lab: 'Lab',
  imaging: 'X-ray / scan',
  room: 'Room',
  other: 'Other',
} as const;
export type ServicePointKind = keyof typeof SERVICE_POINT_KINDS;
export const isServicePointKind = (value: string): value is ServicePointKind => value in SERVICE_POINT_KINDS;

export const CLOCK_FROM = {
  order: 'From the doctor’s order',
  payment: 'From payment',
} as const;
export type ClockFrom = keyof typeof CLOCK_FROM;

export const DEFAULT_CLOCK_MINUTES = 30;
export const MIN_CLOCK_MINUTES = 5;
export const MAX_CLOCK_MINUTES = 240;

/** D-LABFU: a raised task nobody has called about goes to the admin after this long. */
export const ESCALATE_AFTER_MS = 15 * 60_000;

export const ORDER_STATUSES = {
  ordered: 'Not arrived',
  arrived: 'Arrived',
  done: 'Test done',
  reported: 'Report added',
  not_coming: 'Not coming',
  cancelled: 'Cancelled',
} as const;
export type TestOrderStatus = keyof typeof ORDER_STATUSES;

/** Still on a worklist: not arrived, waiting for the test, or waiting for the report. */
export const OPEN_STATUSES = ['ordered', 'arrived', 'done'] as const satisfies readonly TestOrderStatus[];
export const isOpenStatus = (status: TestOrderStatus): boolean => (OPEN_STATUSES as readonly string[]).includes(status);

/** What the patient said on the phone. The last four close the order as "not coming". */
export const CALL_OUTCOMES = {
  no_answer: 'No answer',
  coming_now: 'Coming now',
  told_the_way: 'Told the way',
  will_come_later: 'Will come later',
  went_home: 'Went home',
  refused_cost: 'Refused — cost',
  refused_fear: 'Refused — fear',
  refused_other: 'Refused — other reason',
} as const;
export type CallOutcome = keyof typeof CALL_OUTCOMES;
export const isCallOutcome = (value: string): value is CallOutcome => value in CALL_OUTCOMES;

export const CLOSING_OUTCOMES = ['went_home', 'refused_cost', 'refused_fear', 'refused_other'] as const satisfies readonly CallOutcome[];
export type ClosingOutcome = (typeof CLOSING_OUTCOMES)[number];
export const isClosingOutcome = (outcome: CallOutcome): outcome is ClosingOutcome =>
  (CLOSING_OUTCOMES as readonly string[]).includes(outcome);

/** A call outcome is only for a patient who has not arrived yet. */
export function outcomeRefusal(outcome: CallOutcome, note: string | null): string | null {
  if (outcome === 'refused_other' && !note) return 'Write what the patient said';
  return null;
}

/* ---------------------------------------------------------------- the clock */

/** When the clock starts: the order, or the payment (null until paid). */
export function clockStart(order: { clockFrom: ClockFrom; orderedAt: Date; paidAt: Date | null }): Date | null {
  return order.clockFrom === 'order' ? order.orderedAt : order.paidAt;
}

/** When the "not arrived" task falls due; null while a payment-clock test is unpaid. */
export function dueAt(order: { clockFrom: ClockFrom; clockMinutes: number; orderedAt: Date; paidAt: Date | null }): Date | null {
  const start = clockStart(order);
  return start ? new Date(start.getTime() + order.clockMinutes * 60_000) : null;
}

export type FollowUpState =
  /** Arrived, done, reported, or closed: nothing to chase. */
  | 'none'
  /** Payment clock, not paid yet: the clock has not started. */
  | 'awaiting_payment'
  /** The clock is running. */
  | 'waiting'
  /** Past the set time and nobody has called since: the staff's task. */
  | 'task'
  /** Past the set time and someone has called since. */
  | 'followed_up'
  /** Nobody called within 15 minutes of the task: the admin's. */
  | 'escalated';

/**
 * Where an order stands in follow-up at `now`. Computed from the stored
 * stamps and the time of the last call, so a screen is right between sweeps;
 * the sweep stamps the same moments on the order for the evidence log.
 */
export function followUpState(
  order: { status: TestOrderStatus; dueAt: Date | null; escalatedAt: Date | null },
  lastCallAt: Date | null,
  now: Date,
): FollowUpState {
  if (order.status !== 'ordered') return 'none';
  if (!order.dueAt) return 'awaiting_payment';
  if (now < order.dueAt) return 'waiting';
  const calledSinceDue = lastCallAt !== null && lastCallAt >= order.dueAt;
  if (calledSinceDue) return 'followed_up';
  if (order.escalatedAt || now.getTime() >= order.dueAt.getTime() + ESCALATE_AFTER_MS) return 'escalated';
  return 'task';
}

/** "12 min", "1 h 05 min": how long the patient has been sent for, for the worklist. */
export function minutesLabel(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/* ------------------------------------------------------------ service points */

export type Lang = 'en' | 'mr' | 'hi';

export type ServicePointText = {
  name: string;
  nameMr: string | null;
  nameHi: string | null;
  floor: string | null;
  floorMr: string | null;
  floorHi: string | null;
  section: string | null;
  sectionMr: string | null;
  sectionHi: string | null;
};

/** The way to a service point in one language, falling back to English where a translation is missing. */
export function directions(point: ServicePointText, lang: Lang): { name: string; floor: string | null; section: string | null } {
  const pick = (en: string | null, mr: string | null, hi: string | null) => (lang === 'mr' ? mr : lang === 'hi' ? hi : en) ?? en;
  return {
    name: pick(point.name, point.nameMr, point.nameHi)!,
    floor: pick(point.floor, point.floorMr, point.floorHi),
    section: pick(point.section, point.sectionMr, point.sectionHi),
  };
}

/** One line to read out on the phone: "Pathology lab · First floor · Room 12, behind the pharmacy". */
export function directionsLine(point: ServicePointText, lang: Lang): string {
  const d = directions(point, lang);
  return [d.name, d.floor, d.section].filter(Boolean).join(' · ');
}

const clean = (value: string | null | undefined, max: number, label: string): string | null => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > max) throw new TestOrderError(`${label} is too long (at most ${max} letters)`);
  return text;
};

export type ServicePointInput = ServicePointText & {
  kind: ServicePointKind;
  clockFrom: ClockFrom;
  clockMinutes: number;
};

/** Checks and tidies what the owner typed for a service point. Throws TestOrderError. */
export function parseServicePoint(raw: {
  kind: string;
  name: string;
  nameMr?: string | null;
  nameHi?: string | null;
  floor?: string | null;
  floorMr?: string | null;
  floorHi?: string | null;
  section?: string | null;
  sectionMr?: string | null;
  sectionHi?: string | null;
  clockFrom: string;
  clockMinutes: number | string;
}): ServicePointInput {
  if (!isServicePointKind(raw.kind)) throw new TestOrderError('Choose what kind of place it is');
  const name = clean(raw.name, 60, 'Name');
  if (!name || name.length < 2) throw new TestOrderError('Give the lab or room a name');
  if (raw.clockFrom !== 'order' && raw.clockFrom !== 'payment') throw new TestOrderError('Choose when the clock starts');
  const minutes = typeof raw.clockMinutes === 'number' ? raw.clockMinutes : Number(String(raw.clockMinutes).trim());
  if (!Number.isInteger(minutes) || minutes < MIN_CLOCK_MINUTES || minutes > MAX_CLOCK_MINUTES) {
    throw new TestOrderError(`The time must be whole minutes from ${MIN_CLOCK_MINUTES} to ${MAX_CLOCK_MINUTES}`);
  }
  return {
    kind: raw.kind,
    name,
    nameMr: clean(raw.nameMr, 60, 'Marathi name'),
    nameHi: clean(raw.nameHi, 60, 'Hindi name'),
    floor: clean(raw.floor, 40, 'Floor'),
    floorMr: clean(raw.floorMr, 40, 'Marathi floor'),
    floorHi: clean(raw.floorHi, 40, 'Hindi floor'),
    section: clean(raw.section, 80, 'Section'),
    sectionMr: clean(raw.sectionMr, 80, 'Marathi section'),
    sectionHi: clean(raw.sectionHi, 80, 'Hindi section'),
    clockFrom: raw.clockFrom,
    clockMinutes: minutes,
  };
}

/* ------------------------------------------------------------- the day view */

export type DayOrder = {
  id: string;
  servicePointId: string;
  status: TestOrderStatus;
  closedReason: ClosingOutcome | null;
  taskRaisedAt: Date | null;
  escalatedAt: Date | null;
};

export type DayCall = { orderId: string; servicePointId: string; calledByUserId: string | null; outcome: CallOutcome };

/** A step someone marked at a lab on the day, whenever its test was ordered. */
export type DayStep = { userId: string; step: 'arrived' | 'done' | 'reported' };

export type PointDay = {
  ordered: number;
  arrived: number;
  done: number;
  reported: number;
  notComing: number;
  cancelled: number;
  /** Still open at the end of the day: not arrived, or waiting for the test or the report. */
  pending: number;
  tasksRaised: number;
  escalated: number;
  calls: number;
};

export type PersonDay = { calls: number; reached: number; arrivalsMarked: number; testsDone: number; reportsAdded: number };

export const emptyPointDay = (): PointDay => ({
  ordered: 0, arrived: 0, done: 0, reported: 0, notComing: 0, cancelled: 0, pending: 0, tasksRaised: 0, escalated: 0, calls: 0,
});
const emptyPerson = (): PersonDay => ({ calls: 0, reached: 0, arrivalsMarked: 0, testsDone: 0, reportsAdded: 0 });

/**
 * The admin's Today screen: per service point, what was ordered that day and
 * where it got to ("Arrived" counts every order that got at least that far, so
 * the columns read as a funnel); per person, the calls they made and the steps
 * they marked that day — on any day's orders.
 */
export function summariseDay(orders: readonly DayOrder[], calls: readonly DayCall[], steps: readonly DayStep[] = []) {
  const points = new Map<string, PointDay>();
  const people = new Map<string, PersonDay>();
  const point = (id: string) => points.get(id) ?? points.set(id, emptyPointDay()).get(id)!;
  const person = (id: string) => people.get(id) ?? people.set(id, emptyPerson()).get(id)!;

  for (const order of orders) {
    const p = point(order.servicePointId);
    p.ordered += 1;
    if (['arrived', 'done', 'reported'].includes(order.status)) p.arrived += 1;
    if (['done', 'reported'].includes(order.status)) p.done += 1;
    if (order.status === 'reported') p.reported += 1;
    if (order.status === 'not_coming') p.notComing += 1;
    if (order.status === 'cancelled') p.cancelled += 1;
    if (isOpenStatus(order.status)) p.pending += 1;
    if (order.taskRaisedAt) p.tasksRaised += 1;
    if (order.escalatedAt) p.escalated += 1;
  }
  for (const { userId, step } of steps) {
    const who = person(userId);
    if (step === 'arrived') who.arrivalsMarked += 1;
    else if (step === 'done') who.testsDone += 1;
    else who.reportsAdded += 1;
  }
  for (const call of calls) {
    point(call.servicePointId).calls += 1;
    if (!call.calledByUserId) continue;
    const who = person(call.calledByUserId);
    who.calls += 1;
    if (call.outcome !== 'no_answer') who.reached += 1;
  }
  return { points, people };
}
