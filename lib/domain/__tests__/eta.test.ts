import { describe, expect, it } from 'vitest';
import {
  confidenceFor,
  effectivePace,
  estimateEta,
  etaState,
  foldPaceSample,
  isMeaningfulEtaShift,
  paceSample,
  resolveEta,
} from '../eta';

const now = new Date(Date.UTC(2026, 8, 4, 10, 0));
const minutesFromNow = (date: Date) => (date.getTime() - now.getTime()) / 60_000;

const minutesAfter = (date: Date, m: number) => new Date(date.getTime() + m * 60_000);

describe('pace', () => {
  it('uses the configured minutes until the day has evidence', () => {
    expect(effectivePace({ configuredMinutes: 10 })).toBe(10);
    expect(effectivePace({ paceMinutes: null, paceSamples: 0, configuredMinutes: 12 })).toBe(12);
    expect(effectivePace({})).toBe(10);
  });

  it('one quick consultation cannot collapse the estimate', () => {
    // Regression: a single 3-minute sample used to replace the configured 10.
    expect(effectivePace({ paceMinutes: 3, paceSamples: 1, configuredMinutes: 10 })).toBeCloseTo(8.83, 2);
  });

  it('converges on the observed pace as evidence accrues', () => {
    expect(effectivePace({ paceMinutes: 14, paceSamples: 45, configuredMinutes: 10 })).toBeCloseTo(13.6, 1);
  });

  it('measures call to call and skips intervals that are not fair samples', () => {
    const base = { lastCalledAt: now, now: minutesAfter(now, 12), previousWasSeen: true, calledEnqueuedAt: minutesAfter(now, -30), configuredMinutes: 10 };
    expect(paceSample(base)).toBe(12);
    // First call of the day, or after a break.
    expect(paceSample({ ...base, lastCalledAt: null })).toBeNull();
    // The previous patient was held or skipped, not seen.
    expect(paceSample({ ...base, previousWasSeen: false })).toBeNull();
    // The doctor sat idle until this patient joined.
    expect(paceSample({ ...base, calledEnqueuedAt: minutesAfter(now, 5) })).toBeNull();
    // A gap over an hour: a break or the gap between sessions.
    expect(paceSample({ ...base, now: minutesAfter(now, 61) })).toBeNull();
  });

  it('clips odd intervals to a band around the configured minutes', () => {
    const base = { lastCalledAt: now, previousWasSeen: true, calledEnqueuedAt: null, configuredMinutes: 10 };
    expect(paceSample({ ...base, now: minutesAfter(now, 0.5) })).toBe(3);
    expect(paceSample({ ...base, now: minutesAfter(now, 45) })).toBe(30);
  });

  it('folds samples into a running mean, then an exponential average', () => {
    let pace = { paceMinutes: null as number | null, paceSamples: 0 };
    for (const sample of [10, 12, 14]) pace = foldPaceSample(pace, sample);
    expect(pace.paceMinutes).toBeCloseTo(12, 6);
    expect(pace.paceSamples).toBe(3);
    // Past the window, a new sample moves the pace by 1/20 of the difference.
    const settled = { paceMinutes: 10, paceSamples: 40 };
    expect(foldPaceSample(settled, 30).paceMinutes).toBeCloseTo(11, 6);
  });
});

describe('confidence', () => {
  it('scales with how much evidence we actually have', () => {
    expect(confidenceFor(0)).toBe('low');
    expect(confidenceFor(4)).toBe('low');
    expect(confidenceFor(5)).toBe('medium');
    expect(confidenceFor(19)).toBe('medium');
    expect(confidenceFor(20)).toBe('high');
  });
});

const steady = { paceMinutes: 10, paceSamples: 30, configuredMinutes: 10 };

describe('estimateEta', () => {
  it('multiplies patients ahead by the pace', () => {
    const eta = estimateEta({
      patientsAhead: 6,
      ...steady,
      now,
    });
    expect(eta.waitMinutes).toBe(60);
    expect(eta.basisConsultMinutes).toBe(10);
    expect(eta.confidence).toBe('high');
  });

  it('counts from now once OPD is live and never adds a delay on top', () => {
    const eta = estimateEta({
      patientsAhead: 3,
      ...steady,
      scheduledStartAt: new Date(now.getTime() - 25 * 60_000),
      sessionStartedAt: new Date(now.getTime() - 5 * 60_000),
      now,
    });
    expect(eta.waitMinutes).toBe(30);
    expect(eta.state).toBe('live');
    expect(eta.basis.delayMinutes).toBe(20);
  });

  it('uses the configured duration before any data exists', () => {
    const eta = estimateEta({
      patientsAhead: 4,
      configuredMinutes: 15,
      now,
    });
    expect(eta.waitMinutes).toBe(60);
    expect(eta.sampleSize).toBe(0);
    expect(eta.confidence).toBe('low');
  });

  it('gives a wider window when confidence is low', () => {
    const shared = { patientsAhead: 10, now };
    const low = estimateEta({ ...shared, paceMinutes: 10, paceSamples: 2 });
    const high = estimateEta({ ...shared, ...steady });

    const width = (e: { windowStart: Date; windowEnd: Date }) =>
      minutesFromNow(e.windowEnd) - minutesFromNow(e.windowStart);

    expect(width(low)).toBeGreaterThan(width(high));
  });

  it('never promises a time in the past', () => {
    const eta = estimateEta({
      patientsAhead: 0,
      ...steady,
      now,
    });
    expect(eta.waitMinutes).toBe(0);
    expect(eta.windowStart.getTime()).toBeGreaterThanOrEqual(now.getTime() - 5 * 60_000);
  });

  it('never produces a negative wait for the front of the line', () => {
    const eta = estimateEta({
      patientsAhead: 0,
      ...steady,
      scheduledStartAt: new Date(now.getTime() - 10 * 60_000),
      now,
    });
    expect(eta.waitMinutes).toBe(0);
    expect(eta.windowStart.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it('reports a range, never a single timestamp', () => {
    const eta = estimateEta({
      patientsAhead: 5,
      ...steady,
      now,
    });
    expect(eta.windowEnd.getTime()).toBeGreaterThan(eta.windowStart.getTime());
  });

  it('never tells a patient to come much before their estimated turn', () => {
    // Regression: the window used to open at least ten minutes before the
    // estimate, and patients arrived at the window start.
    for (const ahead of [1, 2, 3, 6, 12]) {
      const eta = estimateEta({ patientsAhead: ahead, ...steady, now });
      const centre = now.getTime() + eta.waitMinutes * 60_000;
      expect(centre - eta.windowStart.getTime()).toBeLessThanOrEqual(ahead * 10 * 0.05 * 60_000);
      expect(eta.windowEnd.getTime()).toBeGreaterThan(centre);
    }
  });

  it('rounds the window to five-minute boundaries', () => {
    const eta = estimateEta({
      patientsAhead: 7,
      paceMinutes: 10,
      paceSamples: 10,
      now,
    });
    expect(eta.windowStart.getUTCMinutes() % 5).toBe(0);
    expect(eta.windowEnd.getUTCMinutes() % 5).toBe(0);
  });
});

describe('the window never starts in the past', () => {
  // Regression: clamping the start to `now` and then rounding *down* to a
  // five-minute boundary produced windows that had already begun, which a
  // patient reads as a broken promise.
  it('keeps windowStart at or after now for any queue length', () => {
    const at = new Date(Date.UTC(2026, 8, 4, 14, 18));
    for (let ahead = 0; ahead <= 30; ahead += 1) {
      const eta = estimateEta({
        patientsAhead: ahead,
        paceMinutes: 10,
      paceSamples: 10,
        now: at,
      });
      expect(eta.windowStart.getTime()).toBeGreaterThanOrEqual(at.getTime());
      expect(eta.windowEnd.getTime()).toBeGreaterThan(eta.windowStart.getTime());
    }
  });
});

describe('start-time anchored states', () => {
  const start = new Date(Date.UTC(2026, 9, 5, 8, 30)); // 2:00 pm IST
  const minutes = (m: number) => new Date(start.getTime() + m * 60_000);

  it('before the scheduled start, counts from the start, not from now', () => {
    const eta = estimateEta({ patientsAhead: 5, ...steady, scheduledStartAt: start, now: minutes(-60) });
    expect(eta.state).toBe('planned');
    expect(eta.basis.anchor).toBe('scheduled_start');
    expect(eta.waitMinutes).toBe(110); // 60 until start + 5 × 10
  });

  it('a planned window holds still as the clock moves', () => {
    const at = (m: number) =>
      estimateEta({ patientsAhead: 5, ...steady, scheduledStartAt: start, now: minutes(m) });
    expect(at(-60).windowStart).toEqual(at(-30).windowStart);
    expect(at(-30).windowEnd).toEqual(at(10).windowEnd);
  });

  it('becomes not_started after the grace period, with no window promised', () => {
    const input = { patientsAhead: 5, ...steady, scheduledStartAt: start };
    expect(etaState({ ...input, now: minutes(14) })).toBe('planned');
    expect(etaState({ ...input, now: minutes(15) })).toBe('not_started');
    const result = resolveEta({ ...input, now: minutes(40) });
    expect(result.state).toBe('not_started');
    expect('windowStart' in result).toBe(false);
    expect(result.basis.delayMinutes).toBe(40);
  });

  it('goes live after Start OPD and does not double-count the late start', () => {
    const eta = resolveEta({
      patientsAhead: 3,
      ...steady,
      scheduledStartAt: start,
      sessionStartedAt: minutes(30),
      now: minutes(45),
    });
    expect(eta.state).toBe('live');
    if (eta.state === 'not_started') throw new Error('unexpected');
    expect(eta.waitMinutes).toBe(30);
    expect(eta.basis.delayMinutes).toBe(30);
  });

  it('a later start replaces an earlier delay rather than compounding it', () => {
    const base = { patientsAhead: 2, ...steady, scheduledStartAt: start, now: minutes(60) };
    const late30 = estimateEta({ ...base, sessionStartedAt: minutes(30) });
    const late45 = estimateEta({ ...base, sessionStartedAt: minutes(45) });
    expect(late30.waitMinutes).toBe(20);
    expect(late45.waitMinutes).toBe(20);
    expect(late45.basis.delayMinutes).toBe(45);
  });

  it('without a configured start time, behaves as before (live from now)', () => {
    expect(etaState({ now: start })).toBe('live');
    expect(estimateEta({ patientsAhead: 2, ...steady, now: start }).waitMinutes).toBe(20);
  });

  it('only a meaningful shift is worth telling the patient', () => {
    const base = { patientsAhead: 2, ...steady, now: start };
    const a = estimateEta(base);
    const small = estimateEta({ ...base, patientsAhead: 3 });
    const big = estimateEta({ ...base, patientsAhead: 5 });
    expect(isMeaningfulEtaShift(a, small)).toBe(false);
    expect(isMeaningfulEtaShift(a, big)).toBe(true);
    const stalled = resolveEta({ ...base, scheduledStartAt: minutes(-30) });
    expect(isMeaningfulEtaShift(a, stalled)).toBe(true);
  });
});
