import { describe, expect, it } from 'vitest';
import {
  ESCALATE_AFTER_MS,
  TestOrderError,
  directions,
  directionsLine,
  dueAt,
  followUpState,
  isClosingOutcome,
  minutesLabel,
  outcomeRefusal,
  parseServicePoint,
  summariseDay,
  type DayOrder,
} from '../test-orders';

const at = (hhmm: string) => new Date(`2026-10-10T${hhmm}:00+05:30`);

describe('the not-arrived clock (D-LABCLOCK)', () => {
  it('runs from the order, or from payment once paid', () => {
    expect(dueAt({ clockFrom: 'order', clockMinutes: 30, orderedAt: at('10:00'), paidAt: null })).toEqual(at('10:30'));
    expect(dueAt({ clockFrom: 'payment', clockMinutes: 30, orderedAt: at('10:00'), paidAt: null })).toBeNull();
    expect(dueAt({ clockFrom: 'payment', clockMinutes: 20, orderedAt: at('10:00'), paidAt: at('10:15') })).toEqual(at('10:35'));
  });
});

describe('follow-up state (D-LABFU)', () => {
  const order = { status: 'ordered' as const, dueAt: at('10:30'), escalatedAt: null };

  it('waits until the set time, then is the staff’s task', () => {
    expect(followUpState(order, null, at('10:29'))).toBe('waiting');
    expect(followUpState(order, null, at('10:30'))).toBe('task');
    expect(followUpState(order, null, at('10:44'))).toBe('task');
  });

  it('goes to the admin when nobody calls within 15 minutes of the task', () => {
    expect(followUpState(order, null, new Date(at('10:30').getTime() + ESCALATE_AFTER_MS))).toBe('escalated');
    // A call before the set time does not answer the task.
    expect(followUpState(order, at('10:10'), at('10:50'))).toBe('escalated');
  });

  it('is followed up once someone calls after the set time', () => {
    expect(followUpState(order, at('10:31'), at('10:50'))).toBe('followed_up');
    // Even after an escalation, a call shows the follow-up happened.
    expect(followUpState({ ...order, escalatedAt: at('10:45') }, at('10:47'), at('10:50'))).toBe('followed_up');
  });

  it('has nothing to chase once arrived, and nothing to start while unpaid', () => {
    expect(followUpState({ ...order, status: 'arrived' }, null, at('12:00'))).toBe('none');
    expect(followUpState({ ...order, dueAt: null }, null, at('12:00'))).toBe('awaiting_payment');
  });
});

describe('call outcomes', () => {
  it('closes the test only for went home and refusals, and wants a note for "other"', () => {
    expect(isClosingOutcome('went_home')).toBe(true);
    expect(isClosingOutcome('refused_cost')).toBe(true);
    expect(isClosingOutcome('will_come_later')).toBe(false);
    expect(isClosingOutcome('no_answer')).toBe(false);
    expect(outcomeRefusal('refused_other', null)).toMatch(/what the patient said/);
    expect(outcomeRefusal('refused_other', 'Will go to a private lab')).toBeNull();
    expect(outcomeRefusal('no_answer', null)).toBeNull();
  });
});

describe('service points', () => {
  const raw = {
    kind: 'lab',
    name: '  Pathology   lab ',
    nameMr: 'पॅथॉलॉजी लॅब',
    nameHi: '',
    floor: 'First floor',
    floorMr: 'पहिला मजला',
    section: 'Room 12, behind the pharmacy',
    clockFrom: 'order',
    clockMinutes: '30',
  };

  it('tidies the input and keeps blank translations empty', () => {
    const point = parseServicePoint(raw);
    expect(point.name).toBe('Pathology lab');
    expect(point.nameHi).toBeNull();
    expect(point.clockMinutes).toBe(30);
  });

  it('refuses a clock outside 5–240 minutes, a missing name, or an unknown kind', () => {
    expect(() => parseServicePoint({ ...raw, clockMinutes: '2' })).toThrow(TestOrderError);
    expect(() => parseServicePoint({ ...raw, clockMinutes: '30.5' })).toThrow(TestOrderError);
    expect(() => parseServicePoint({ ...raw, name: ' ' })).toThrow(/name/);
    expect(() => parseServicePoint({ ...raw, kind: 'pharmacy' })).toThrow(TestOrderError);
    expect(() => parseServicePoint({ ...raw, clockFrom: 'arrival' })).toThrow(TestOrderError);
  });

  it('gives the way in the patient’s language, falling back to English', () => {
    const point = parseServicePoint(raw);
    expect(directions(point, 'mr')).toEqual({ name: 'पॅथॉलॉजी लॅब', floor: 'पहिला मजला', section: 'Room 12, behind the pharmacy' });
    expect(directionsLine(point, 'hi')).toBe('Pathology lab · First floor · Room 12, behind the pharmacy');
  });
});

describe('the day summary', () => {
  const order = (over: Partial<DayOrder>): DayOrder => ({
    id: crypto.randomUUID(),
    servicePointId: 'lab',
    status: 'ordered',
    closedReason: null,
    taskRaisedAt: null,
    escalatedAt: null,
    ...over,
  });

  it('counts each lab as a funnel and each person’s work', () => {
    const { points, people } = summariseDay(
      [
        order({ status: 'reported' }),
        order({ status: 'done' }),
        order({ status: 'arrived', taskRaisedAt: new Date() }),
        order({ status: 'ordered', taskRaisedAt: new Date(), escalatedAt: new Date() }),
        order({ status: 'not_coming', closedReason: 'refused_cost' }),
        order({ servicePointId: 'xray', status: 'cancelled' }),
      ],
      [
        { orderId: 'x', servicePointId: 'lab', calledByUserId: 'asha', outcome: 'no_answer' },
        { orderId: 'x', servicePointId: 'lab', calledByUserId: 'asha', outcome: 'coming_now' },
        { orderId: 'y', servicePointId: 'lab', calledByUserId: 'ravi', outcome: 'refused_cost' },
      ],
      [
        { userId: 'asha', step: 'arrived' },
        { userId: 'asha', step: 'done' },
        { userId: 'asha', step: 'arrived' },
        { userId: 'asha', step: 'done' },
        { userId: 'ravi', step: 'reported' },
        { userId: 'ravi', step: 'arrived' },
      ],
    );
    expect(points.get('lab')).toEqual({
      ordered: 5, arrived: 3, done: 2, reported: 1, notComing: 1, cancelled: 0, pending: 3, tasksRaised: 2, escalated: 1, calls: 3,
    });
    expect(points.get('xray')).toMatchObject({ ordered: 1, cancelled: 1, pending: 0 });
    expect(people.get('asha')).toEqual({ calls: 2, reached: 1, arrivalsMarked: 2, testsDone: 2, reportsAdded: 0 });
    expect(people.get('ravi')).toEqual({ calls: 1, reached: 1, arrivalsMarked: 1, testsDone: 0, reportsAdded: 1 });
  });
});

describe('minutesLabel', () => {
  it('reads as minutes, then hours and minutes', () => {
    expect(minutesLabel(0, 59_000)).toBe('0 min');
    expect(minutesLabel(0, 23 * 60_000)).toBe('23 min');
    expect(minutesLabel(0, 65 * 60_000)).toBe('1 h 05 min');
  });
});
