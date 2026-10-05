import { describe, expect, it } from 'vitest';
import {
  callNext,
  isEligible,
  isLateReturn,
  lateFrontier,
  lateReturnAnchor,
  nextEligible,
  orderQueue,
  patientsAhead,
  priorityRank,
} from '../queue';
import type { AppointmentStatus, QueueContext, QueueEntry } from '../types';

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 8, minutes));

type Opts = {
  status?: AppointmentStatus;
  arrived?: boolean;
  priority?: number;
  prioritySeq?: number;
  called?: boolean;
  after?: number;
  rejoinSeq?: number;
  enqueued?: number;
};

/** Token-named entries: id `t60` is token 60. */
const e = (token: number, opts: Opts = {}): QueueEntry => ({
  appointmentId: `t${token}`,
  tokenNumber: token,
  status: opts.status ?? 'WAITING',
  priority: opts.priority ?? 0,
  prioritySeq: opts.prioritySeq ?? null,
  enqueuedAt: at(opts.enqueued ?? token % 60),
  arrivedAt: opts.arrived === false ? null : at(0),
  calledAt: opts.called ? at(1) : null,
  queueAfterToken: opts.after ?? null,
  rejoinSeq: opts.rejoinSeq ?? null,
});

const ids = (entries: QueueEntry[]) => entries.map((x) => x.appointmentId);
const ctx = (n: number): QueueContext => ({ lateRejoinAfter: n });

/**
 * Plays Next repeatedly and returns the order patients are called in.
 * This is the ground truth the ETA's "ahead" count must agree with.
 */
function simulateCalls(start: QueueEntry[]): string[] {
  let entries = start.map((x) => ({ ...x }));
  const called: string[] = [];
  for (let i = 0; i < entries.length + 2; i += 1) {
    const transitions = callNext(entries);
    if (transitions.length === 0) break;
    entries = entries.map((x) => {
      const t = transitions.find((tr) => tr.appointmentId === x.appointmentId);
      return t ? { ...x, status: t.to, calledAt: t.action === 'call' ? at(59) : x.calledAt } : x;
    });
    const call = transitions.find((t) => t.action === 'call');
    if (call) called.push(call.appointmentId);
  }
  return called;
}

describe('arrival eligibility', () => {
  it('only arrived WAITING patients are eligible', () => {
    expect(isEligible(e(1))).toBe(true);
    expect(isEligible(e(1, { arrived: false }))).toBe(false);
    expect(isEligible(e(1, { status: 'HELD' }))).toBe(false);
    expect(isEligible(e(1, { status: 'SKIPPED' }))).toBe(false);
    expect(isEligible(e(1, { status: 'NO_SHOW' }))).toBe(false);
  });

  it('Next passes over absent earlier tokens: 57, then 59, then 60', () => {
    const queue = [
      e(55, { arrived: false }),
      e(56, { arrived: false }),
      e(57),
      e(58, { arrived: false }),
      e(59),
      e(60),
    ];
    expect(simulateCalls(queue)).toEqual(['t57', 't59', 't60']);
  });

  it('serves a later token early without changing any token', () => {
    const queue = [e(55, { arrived: false }), e(56, { arrived: false }), e(57, { arrived: false }), e(60)];
    const before = queue.map((x) => x.tokenNumber);
    expect(callNext(queue)).toEqual([
      { appointmentId: 't60', action: 'call', from: 'WAITING', to: 'CALLED' },
    ]);
    expect(queue.map((x) => x.tokenNumber)).toEqual(before);
  });

  it('calls nobody when no one present is waiting, but still completes the consultation', () => {
    const queue = [e(1, { status: 'IN_CONSULTATION' }), e(2, { arrived: false })];
    expect(callNext(queue).map((t) => t.action)).toEqual(['complete']);
    expect(nextEligible(queue)).toBeNull();
  });

  it('keeps absent patients in order without marking them arrived', () => {
    const queue = [e(2, { arrived: false }), e(1)];
    expect(ids(orderQueue(queue))).toEqual(['t1', 't2']);
    callNext(queue);
    expect(queue[0].arrivedAt).toBeNull();
  });
});

describe('priority is FIFO by assignment', () => {
  it('a later-prioritised patient does not overtake an earlier one', () => {
    // A (token 30, enqueued late) prioritised first; B (token 5, enqueued early) second.
    const queue = [
      e(5, { priority: 10, prioritySeq: 2, enqueued: 0 }),
      e(30, { priority: 10, prioritySeq: 1, enqueued: 40 }),
      e(1),
    ];
    expect(ids(orderQueue(queue))).toEqual(['t30', 't5', 't1']);
    expect(priorityRank(queue, 't30')).toBe(1);
    expect(priorityRank(queue, 't5')).toBe(2);
    expect(priorityRank(queue, 't1')).toBeNull();
  });

  it('an early arrival does not bypass priority patients', () => {
    const queue = [e(40, { priority: 10, prioritySeq: 1 }), e(50, { priority: 10, prioritySeq: 2 }), e(60)];
    expect(simulateCalls(queue)).toEqual(['t40', 't50', 't60']);
  });

  it('a priority patient who has not arrived is not called', () => {
    const queue = [e(40, { priority: 10, prioritySeq: 1, arrived: false }), e(60)];
    expect(nextEligible(queue)?.appointmentId).toBe('t60');
  });

  it('legacy priority rows without a sequence come after sequenced ones', () => {
    const queue = [e(3, { priority: 10, enqueued: 0 }), e(9, { priority: 10, prioritySeq: 1, enqueued: 50 })];
    expect(ids(orderQueue(queue))).toEqual(['t9', 't3']);
  });
});

describe('late return placement', () => {
  const serving40 = [e(39, { status: 'COMPLETED', called: true }), e(40, { status: 'IN_CONSULTATION', called: true })];

  it('frontier is the highest normal token called; priority calls do not move it', () => {
    expect(lateFrontier([...serving40, e(90, { priority: 10, prioritySeq: 1, status: 'COMPLETED', called: true })])).toBe(40);
  });

  it('token below the frontier is late; equal or above is not', () => {
    const queue = [...serving40, e(10, { status: 'SKIPPED', called: true }), e(41)];
    expect(isLateReturn(queue, queue[2])).toBe(true);
    expect(isLateReturn(queue, e(40))).toBe(false);
    expect(isLateReturn(queue, queue[3])).toBe(false);
  });

  it('a skipped token 10 recalled while 40 is served goes after the next N=2 (behind 42)', () => {
    const queue = [...serving40, e(10, { status: 'SKIPPED', called: true }), e(41), e(42), e(43)];
    expect(lateReturnAnchor(queue, 't10', ctx(2))).toBe(42);
    const recalled = queue.map((x) =>
      x.appointmentId === 't10' ? { ...x, status: 'WAITING' as const, queueAfterToken: 42, rejoinSeq: 1 } : x,
    );
    expect(simulateCalls(recalled)).toEqual(['t41', 't42', 't10', 't43']);
  });

  it('with fewer than N eligible the returner goes last; with none, next', () => {
    const one = [...serving40, e(10, { status: 'SKIPPED', called: true }), e(41)];
    expect(lateReturnAnchor(one, 't10', ctx(2))).toBe(41);
    const none = [...serving40, e(10, { status: 'SKIPPED', called: true }), e(41, { arrived: false })];
    expect(lateReturnAnchor(none, 't10', ctx(2))).toBeNull();
  });

  it('N=0 returns them straight to their token position', () => {
    const queue = [...serving40, e(10, { status: 'SKIPPED', called: true }), e(41)];
    expect(lateReturnAnchor(queue, 't10', ctx(0))).toBeNull();
  });

  it('two late returners behind the same anchor keep FIFO order', () => {
    const queue = [
      ...serving40,
      e(41),
      e(42),
      e(12, { after: 42, rejoinSeq: 7 }),
      e(11, { after: 42, rejoinSeq: 3 }),
      e(43),
    ];
    expect(simulateCalls(queue)).toEqual(['t41', 't42', 't11', 't12', 't43']);
  });

  it('placing behind a late returner lands after them', () => {
    const queue = [...serving40, e(41), e(11, { after: 41, rejoinSeq: 1 }), e(12, { status: 'SKIPPED', called: true })];
    expect(lateReturnAnchor(queue, 't12', ctx(2))).toBe(41);
    const placed = queue.map((x) =>
      x.appointmentId === 't12' ? { ...x, status: 'WAITING' as const, queueAfterToken: 41, rejoinSeq: 2 } : x,
    );
    expect(simulateCalls(placed)).toEqual(['t41', 't11', 't12']);
  });

  it('never uses a priority patient as the anchor, and never jumps priority', () => {
    const queue = [...serving40, e(70, { priority: 10, prioritySeq: 1 }), e(41), e(10, { after: 41, rejoinSeq: 1 })];
    expect(lateReturnAnchor(queue, 'x', ctx(1))).toBe(41);
    expect(simulateCalls(queue)).toEqual(['t70', 't41', 't10']);
  });

  it('token 55 checking in while 60 is served is late, not next', () => {
    const queue = [
      e(60, { status: 'IN_CONSULTATION', called: true }),
      e(55, { arrived: false }),
      e(61),
      e(62),
      e(63),
    ];
    expect(isLateReturn(queue, queue[1])).toBe(true);
    expect(lateReturnAnchor(queue, 't55', ctx(2))).toBe(62);
  });

  it('an early check-in (token above the frontier) keeps its token position', () => {
    const queue = [e(40, { status: 'IN_CONSULTATION', called: true }), e(41), e(45, { arrived: false }), e(46)];
    expect(isLateReturn(queue, queue[2])).toBe(false);
    expect(patientsAhead(queue, 't45')).toBe(2);
  });
});

describe('ETA ahead-count uses the exact order Next uses', () => {
  /** For an eligible patient: serving count + their index in the simulated call order. */
  const expectAheadMatchesCalls = (queue: QueueEntry[], c: QueueContext = ctx(2)) => {
    const calls = simulateCalls(queue);
    const serving = queue.filter((x) => x.status === 'CALLED' || x.status === 'IN_CONSULTATION').length;
    for (const x of queue.filter(isEligible)) {
      expect(patientsAhead(queue, x.appointmentId, c), x.appointmentId).toBe(
        serving + calls.indexOf(x.appointmentId),
      );
    }
  };

  it('with priority patients', () => {
    const queue = [e(40, { priority: 10, prioritySeq: 1 }), e(50, { priority: 10, prioritySeq: 2 }), e(30)];
    expect(patientsAhead(queue, 't30')).toBe(2);
    expectAheadMatchesCalls(queue);
  });

  it('with a late returner (token 10 behind N=2): exactly 2 ahead plus the serving patient', () => {
    const queue = [
      e(40, { status: 'IN_CONSULTATION', called: true }),
      e(41),
      e(42),
      e(10, { after: 42, rejoinSeq: 1, called: true }),
      e(43),
    ];
    expect(patientsAhead(queue, 't10')).toBe(3);
    expectAheadMatchesCalls(queue);
  });

  it('with patients who have not arrived', () => {
    const queue = [
      e(55, { arrived: false }),
      e(56, { arrived: false }),
      e(57),
      e(58, { arrived: false }),
      e(59),
      e(60),
    ];
    expect(patientsAhead(queue, 't57')).toBe(0);
    expect(patientsAhead(queue, 't60')).toBe(2);
    // Projection for absent 58: counts arrived 57, not absent 55/56.
    expect(patientsAhead(queue, 't58')).toBe(1);
    expectAheadMatchesCalls(queue);
  });

  it('projection for an absent late patient applies the late-return placement', () => {
    const queue = [e(60, { status: 'IN_CONSULTATION', called: true }), e(55, { arrived: false }), e(61), e(62), e(63)];
    // If 55 checked in now it would go behind 62: serving + 61 + 62.
    expect(patientsAhead(queue, 't55', ctx(2))).toBe(3);
  });

  it('with priority, late return and absent patients combined', () => {
    const queue = [
      e(20, { status: 'COMPLETED', called: true }),
      e(21, { status: 'IN_CONSULTATION', called: true }),
      e(22, { arrived: false }),
      e(23),
      e(24),
      e(25),
      e(5, { after: 24, rejoinSeq: 1, called: true }),
      e(30, { priority: 10, prioritySeq: 2 }),
      e(35, { priority: 10, prioritySeq: 1 }),
      e(36, { priority: 10, prioritySeq: 3, arrived: false }),
    ];
    expect(simulateCalls(queue)).toEqual(['t35', 't30', 't23', 't24', 't5', 't25']);
    expect(patientsAhead(queue, 't5')).toBe(5);
    expectAheadMatchesCalls(queue);
  });

  it('holds for random queues', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 200; run += 1) {
      const size = 3 + Math.floor(rand() * 12);
      const queue: QueueEntry[] = [];
      let seq = 0;
      for (let token = 1; token <= size; token += 1) {
        const roll = rand();
        const status: AppointmentStatus =
          roll < 0.1 ? 'COMPLETED' : roll < 0.15 ? 'HELD' : roll < 0.2 ? 'SKIPPED' : 'WAITING';
        const prio = rand() < 0.2;
        queue.push(
          e(token, {
            status,
            arrived: rand() < 0.7,
            priority: prio ? 10 : 0,
            prioritySeq: prio ? (seq += 1) + Math.floor(rand() * 3) * 10 : undefined,
            after: !prio && rand() < 0.15 ? Math.floor(rand() * size) + 1 : undefined,
            rejoinSeq: Math.floor(rand() * 5),
            called: status === 'COMPLETED',
          }),
        );
      }
      if (rand() < 0.5) queue.push(e(size + 1, { status: 'IN_CONSULTATION', called: true }));
      expectAheadMatchesCalls(queue);
    }
  });
});
