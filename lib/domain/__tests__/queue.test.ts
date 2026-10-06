import { describe, expect, it } from 'vitest';
import {
  applyAction,
  callNext,
  canCancel,
  canPause,
  canTransition,
  currentlyServing,
  isActive,
  isTerminal,
  nextTokenNumber,
  occupiesBookingSlot,
  orderQueue,
  patientsAhead,
  QueueTransitionError,
} from '../queue';
import type { AppointmentStatus, QueueEntry } from '../types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 4, 9, minutes));

const entry = (
  id: string,
  token: number,
  status: AppointmentStatus,
  minutes: number,
  priority = 0,
): QueueEntry => ({
  appointmentId: id,
  tokenNumber: token,
  status,
  priority,
  enqueuedAt: at(minutes),
});

describe('state machine', () => {
  it('walks the happy path to completion', () => {
    let status: AppointmentStatus = 'CREATED';
    for (const action of ['confirm', 'arrive', 'enqueue', 'call', 'start_consultation', 'complete'] as const) {
      status = applyAction(status, action);
    }
    expect(status).toBe('COMPLETED');
  });

  it('recalls a skipped patient back into the waiting pool', () => {
    expect(applyAction('SKIPPED', 'recall')).toBe('WAITING');
  });

  it('resumes a held patient back into the waiting pool', () => {
    expect(applyAction('HELD', 'resume')).toBe('WAITING');
  });

  it('refuses illegal transitions rather than silently ignoring them', () => {
    expect(() => applyAction('COMPLETED', 'call')).toThrow(QueueTransitionError);
    expect(() => applyAction('WAITING', 'start_consultation')).toThrow(QueueTransitionError);
    expect(canTransition('CANCELLED', 'recall')).toBe(false);
  });

  it('treats terminal states as terminal', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] as const) {
      expect(isTerminal(status)).toBe(true);
      expect(isActive(status)).toBe(false);
      expect(occupiesBookingSlot(status)).toBe(false);
      expect(canCancel(status)).toBe(false);
      expect(canPause(status)).toBe(false);
    }
  });

  it('determines pause and cancel capability correctly for non-terminal states', () => {
    expect(canPause('IN_CONSULTATION')).toBe(true);
    expect(canPause('WAITING')).toBe(true);
    expect(canPause('CALLED')).toBe(true);
    expect(canPause('CREATED')).toBe(false);
    expect(canPause('CONFIRMED')).toBe(false);
    expect(canPause('HELD')).toBe(false);

    expect(canCancel('CREATED')).toBe(true);
    expect(canCancel('CONFIRMED')).toBe(true);
    expect(canCancel('ARRIVED')).toBe(true);
    expect(canCancel('WAITING')).toBe(true);
    expect(canCancel('CALLED')).toBe(true);
    expect(canCancel('SKIPPED')).toBe(true);
    expect(canCancel('HELD')).toBe(true);
    expect(canCancel('IN_CONSULTATION')).toBe(false);

    expect(occupiesBookingSlot('CREATED')).toBe(true);
    expect(occupiesBookingSlot('CONFIRMED')).toBe(true);
    expect(occupiesBookingSlot('ARRIVED')).toBe(true);
    expect(occupiesBookingSlot('WAITING')).toBe(true);
    expect(occupiesBookingSlot('CALLED')).toBe(true);
    expect(occupiesBookingSlot('IN_CONSULTATION')).toBe(true);
    expect(occupiesBookingSlot('HELD')).toBe(true);
    expect(occupiesBookingSlot('SKIPPED')).toBe(true);
  });

  it('does not count held or skipped patients as occupying the active queue', () => {
    expect(isActive('HELD')).toBe(false);
    expect(isActive('SKIPPED')).toBe(false);
  });
});

describe('ordering and patients ahead', () => {
  const queue = [
    entry('c', 3, 'WAITING', 20),
    entry('a', 1, 'IN_CONSULTATION', 0),
    entry('d', 4, 'WAITING', 30),
    entry('b', 2, 'WAITING', 10),
  ];

  it('puts the in-progress patient first and the rest in arrival order', () => {
    expect(orderQueue(queue).map((e) => e.appointmentId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('derives patients ahead from queue state, not token number', () => {
    expect(patientsAhead(queue, 'a')).toBe(0);
    expect(patientsAhead(queue, 'd')).toBe(3);
  });

  it('returns null for a patient who is not in the active queue', () => {
    const withCancellation = [...queue, entry('x', 5, 'CANCELLED', 5)];
    expect(patientsAhead(withCancellation, 'x')).toBeNull();
  });

  it('excludes cancelled patients without renumbering the survivors', () => {
    const withCancellation = [...queue, entry('x', 5, 'CANCELLED', 5)];
    expect(patientsAhead(withCancellation, 'd')).toBe(3);
    expect(orderQueue(withCancellation).map((e) => e.tokenNumber)).toEqual([1, 2, 3, 4]);
  });

  it('lets a priority insert jump the waiting line but not the consultation', () => {
    const withPriority = [...queue, entry('vip', 9, 'WAITING', 40, 10)];
    expect(orderQueue(withPriority).map((e) => e.appointmentId)).toEqual(['a', 'vip', 'b', 'c', 'd']);
    expect(patientsAhead(withPriority, 'vip')).toBe(1);
  });

  it('places an emergency patient ahead of standard priority and regular patients', () => {
    const emergEntry: QueueEntry = {
      ...entry('emerg', 10, 'WAITING', 45, 0),
      isEmergency: true,
    };
    const withEmergency = [
      ...queue,
      entry('vip', 9, 'WAITING', 40, 10),
      emergEntry,
    ];
    // Order: 'a' (in consultation), 'emerg' (emergency), 'vip' (priority), 'b', 'c', 'd'
    expect(orderQueue(withEmergency).map((e) => e.appointmentId)).toEqual([
      'a',
      'emerg',
      'vip',
      'b',
      'c',
      'd',
    ]);
    expect(patientsAhead(withEmergency, 'emerg')).toBe(1);
    expect(patientsAhead(withEmergency, 'vip')).toBe(2);
  });

  it('sequences multiple emergency patients FIFO by prioritySeq / arrival', () => {
    const emerg1: QueueEntry = {
      ...entry('emerg1', 11, 'WAITING', 45, 0),
      isEmergency: true,
      prioritySeq: 1,
    };
    const emerg2: QueueEntry = {
      ...entry('emerg2', 12, 'WAITING', 46, 0),
      isEmergency: true,
      prioritySeq: 2,
    };
    const withMultipleEmerg = [...queue, emerg2, emerg1];
    expect(orderQueue(withMultipleEmerg).map((e) => e.appointmentId)).toEqual([
      'a',
      'emerg1',
      'emerg2',
      'b',
      'c',
      'd',
    ]);
  });

  it('identifies who is currently with the doctor', () => {
    expect(currentlyServing(queue)?.appointmentId).toBe('a');
    expect(currentlyServing([entry('b', 2, 'WAITING', 10)])).toBeNull();
  });
});

describe('callNext', () => {
  it('completes the current patient and calls the next in one step', () => {
    const queue = [entry('a', 1, 'IN_CONSULTATION', 0), entry('b', 2, 'WAITING', 10)];
    expect(callNext(queue)).toEqual([
      { appointmentId: 'a', action: 'complete', from: 'IN_CONSULTATION', to: 'COMPLETED' },
      { appointmentId: 'b', action: 'call', from: 'WAITING', to: 'CALLED' },
    ]);
  });

  it('is a pure function, so two concurrent callers compute the same transitions', () => {
    const queue = [entry('a', 1, 'CALLED', 0), entry('b', 2, 'WAITING', 10)];
    expect(callNext(queue)).toEqual(callNext(queue));
  });

  it('still completes the current patient when nobody is waiting', () => {
    const queue = [entry('a', 1, 'IN_CONSULTATION', 0)];
    expect(callNext(queue).map((t) => t.action)).toEqual(['complete']);
  });

  it('does nothing on an empty queue', () => {
    expect(callNext([])).toEqual([]);
    expect(callNext([entry('a', 1, 'COMPLETED', 0)])).toEqual([]);
  });

  it('skips over held and skipped patients', () => {
    const queue = [
      entry('held', 1, 'HELD', 0),
      entry('skipped', 2, 'SKIPPED', 5),
      entry('next', 3, 'WAITING', 10),
    ];
    expect(callNext(queue)).toEqual([
      { appointmentId: 'next', action: 'call', from: 'WAITING', to: 'CALLED' },
    ]);
  });
});

describe('token allocation', () => {
  it('never reuses a token, even after cancellations', () => {
    const queue = [entry('a', 1, 'CANCELLED', 0), entry('b', 2, 'COMPLETED', 5)];
    expect(nextTokenNumber(queue)).toBe(3);
  });

  it('starts at 1 for a fresh doctor-day', () => {
    expect(nextTokenNumber([])).toBe(1);
  });
});
