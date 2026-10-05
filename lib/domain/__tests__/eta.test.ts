import { describe, expect, it } from 'vitest';
import {
  confidenceFor,
  estimateEta,
  etaState,
  isMeaningfulEtaShift,
  median,
  resolveEta,
} from '../eta';

const now = new Date(Date.UTC(2026, 8, 4, 10, 0));
const minutesFromNow = (date: Date) => (date.getTime() - now.getTime()) / 60_000;

describe('median', () => {
  it('handles odd and even sample counts', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('is unmoved by a single extreme outlier, unlike a mean', () => {
    expect(median([8, 9, 10, 11, 240])).toBe(10);
  });

  it('returns null with no samples', () => {
    expect(median([])).toBeNull();
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

describe('estimateEta', () => {
  const durations = Array.from({ length: 30 }, () => 10);

  it('multiplies patients ahead by the median consultation time', () => {
    const eta = estimateEta({
      patientsAhead: 6,
      consultDurations: durations,
      now,
    });
    expect(eta.waitMinutes).toBe(60);
    expect(eta.basisConsultMinutes).toBe(10);
    expect(eta.confidence).toBe('high');
  });

  it('counts from now once OPD is live and never adds a delay on top', () => {
    const eta = estimateEta({
      patientsAhead: 3,
      consultDurations: durations,
      scheduledStartAt: new Date(now.getTime() - 25 * 60_000),
      sessionStartedAt: new Date(now.getTime() - 5 * 60_000),
      now,
    });
    expect(eta.waitMinutes).toBe(30);
    expect(eta.state).toBe('live');
    expect(eta.basis.delayMinutes).toBe(20);
  });

  it('falls back to a configured duration before enough data exists', () => {
    const eta = estimateEta({
      patientsAhead: 4,
      consultDurations: [],
      fallbackConsultMinutes: 15,
      now,
    });
    expect(eta.waitMinutes).toBe(60);
    expect(eta.sampleSize).toBe(0);
    expect(eta.confidence).toBe('low');
  });

  it('gives a wider window when confidence is low', () => {
    const shared = { patientsAhead: 10, now };
    const low = estimateEta({ ...shared, consultDurations: [10, 10] });
    const high = estimateEta({ ...shared, consultDurations: durations });

    const width = (e: { windowStart: Date; windowEnd: Date }) =>
      minutesFromNow(e.windowEnd) - minutesFromNow(e.windowStart);

    expect(width(low)).toBeGreaterThan(width(high));
  });

  it('never promises a time in the past', () => {
    const eta = estimateEta({
      patientsAhead: 0,
      consultDurations: durations,
      now,
    });
    expect(eta.waitMinutes).toBe(0);
    expect(eta.windowStart.getTime()).toBeGreaterThanOrEqual(now.getTime() - 5 * 60_000);
  });

  it('never produces a negative wait for the front of the line', () => {
    const eta = estimateEta({
      patientsAhead: 0,
      consultDurations: durations,
      scheduledStartAt: new Date(now.getTime() - 10 * 60_000),
      now,
    });
    expect(eta.waitMinutes).toBe(0);
    expect(eta.windowStart.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it('reports a range, never a single timestamp', () => {
    const eta = estimateEta({
      patientsAhead: 5,
      consultDurations: durations,
      now,
    });
    expect(eta.windowEnd.getTime()).toBeGreaterThan(eta.windowStart.getTime());
  });

  it('uses only the most recent 50 consultations', () => {
    const eta = estimateEta({
      patientsAhead: 1,
      consultDurations: [...Array(80).fill(60), ...Array(50).fill(10)],
      now,
    });
    expect(eta.basisConsultMinutes).toBe(10);
    expect(eta.sampleSize).toBe(50);
  });

  it('rounds the window to five-minute boundaries', () => {
    const eta = estimateEta({
      patientsAhead: 7,
      consultDurations: [9, 11, 10, 12, 8, 10, 11, 9, 10, 10],
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
        consultDurations: [9, 11, 10, 12, 8, 10, 11, 9, 10, 10],
        now: at,
      });
      expect(eta.windowStart.getTime()).toBeGreaterThanOrEqual(at.getTime());
      expect(eta.windowEnd.getTime()).toBeGreaterThan(eta.windowStart.getTime());
    }
  });
});

describe('start-time anchored states', () => {
  const durations = Array.from({ length: 30 }, () => 10);
  const start = new Date(Date.UTC(2026, 9, 5, 8, 30)); // 2:00 pm IST
  const minutes = (m: number) => new Date(start.getTime() + m * 60_000);

  it('before the scheduled start, counts from the start, not from now', () => {
    const eta = estimateEta({ patientsAhead: 5, consultDurations: durations, scheduledStartAt: start, now: minutes(-60) });
    expect(eta.state).toBe('planned');
    expect(eta.basis.anchor).toBe('scheduled_start');
    expect(eta.waitMinutes).toBe(110); // 60 until start + 5 × 10
  });

  it('a planned window holds still as the clock moves', () => {
    const at = (m: number) =>
      estimateEta({ patientsAhead: 5, consultDurations: durations, scheduledStartAt: start, now: minutes(m) });
    expect(at(-60).windowStart).toEqual(at(-30).windowStart);
    expect(at(-30).windowEnd).toEqual(at(10).windowEnd);
  });

  it('becomes not_started after the grace period, with no window promised', () => {
    const input = { patientsAhead: 5, consultDurations: durations, scheduledStartAt: start };
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
      consultDurations: durations,
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
    const base = { patientsAhead: 2, consultDurations: durations, scheduledStartAt: start, now: minutes(60) };
    const late30 = estimateEta({ ...base, sessionStartedAt: minutes(30) });
    const late45 = estimateEta({ ...base, sessionStartedAt: minutes(45) });
    expect(late30.waitMinutes).toBe(20);
    expect(late45.waitMinutes).toBe(20);
    expect(late45.basis.delayMinutes).toBe(45);
  });

  it('without a configured start time, behaves as before (live from now)', () => {
    expect(etaState({ now: start })).toBe('live');
    expect(estimateEta({ patientsAhead: 2, consultDurations: durations, now: start }).waitMinutes).toBe(20);
  });

  it('only a meaningful shift is worth telling the patient', () => {
    const base = { patientsAhead: 2, consultDurations: durations, now: start };
    const a = estimateEta(base);
    const small = estimateEta({ ...base, patientsAhead: 3 });
    const big = estimateEta({ ...base, patientsAhead: 5 });
    expect(isMeaningfulEtaShift(a, small)).toBe(false);
    expect(isMeaningfulEtaShift(a, big)).toBe(true);
    const stalled = resolveEta({ ...base, scheduledStartAt: minutes(-30) });
    expect(isMeaningfulEtaShift(a, stalled)).toBe(true);
  });
});
