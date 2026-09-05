import { describe, expect, it } from 'vitest';
import { confidenceFor, estimateEta, median } from '../eta';

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
      currentDelayMinutes: 0,
      now,
    });
    expect(eta.waitMinutes).toBe(60);
    expect(eta.basisConsultMinutes).toBe(10);
    expect(eta.confidence).toBe('high');
  });

  it('adds the doctor running late to the wait', () => {
    const eta = estimateEta({
      patientsAhead: 3,
      consultDurations: durations,
      currentDelayMinutes: 25,
      now,
    });
    expect(eta.waitMinutes).toBe(55);
  });

  it('falls back to a configured duration before enough data exists', () => {
    const eta = estimateEta({
      patientsAhead: 4,
      consultDurations: [],
      currentDelayMinutes: 0,
      fallbackConsultMinutes: 15,
      now,
    });
    expect(eta.waitMinutes).toBe(60);
    expect(eta.sampleSize).toBe(0);
    expect(eta.confidence).toBe('low');
  });

  it('gives a wider window when confidence is low', () => {
    const shared = { patientsAhead: 10, currentDelayMinutes: 0, now };
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
      currentDelayMinutes: 0,
      now,
    });
    expect(eta.waitMinutes).toBe(0);
    expect(eta.windowStart.getTime()).toBeGreaterThanOrEqual(now.getTime() - 5 * 60_000);
  });

  it('clamps a negative delay rather than producing a negative wait', () => {
    const eta = estimateEta({
      patientsAhead: 1,
      consultDurations: durations,
      currentDelayMinutes: -60,
      now,
    });
    expect(eta.waitMinutes).toBe(0);
  });

  it('reports a range, never a single timestamp', () => {
    const eta = estimateEta({
      patientsAhead: 5,
      consultDurations: durations,
      currentDelayMinutes: 0,
      now,
    });
    expect(eta.windowEnd.getTime()).toBeGreaterThan(eta.windowStart.getTime());
  });

  it('uses only the most recent 50 consultations', () => {
    const eta = estimateEta({
      patientsAhead: 1,
      consultDurations: [...Array(80).fill(60), ...Array(50).fill(10)],
      currentDelayMinutes: 0,
      now,
    });
    expect(eta.basisConsultMinutes).toBe(10);
    expect(eta.sampleSize).toBe(50);
  });

  it('rounds the window to five-minute boundaries', () => {
    const eta = estimateEta({
      patientsAhead: 7,
      consultDurations: [9, 11, 10, 12, 8, 10, 11, 9, 10, 10],
      currentDelayMinutes: 3,
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
        currentDelayMinutes: 0,
        now: at,
      });
      expect(eta.windowStart.getTime()).toBeGreaterThanOrEqual(at.getTime());
      expect(eta.windowEnd.getTime()).toBeGreaterThan(eta.windowStart.getTime());
    }
  });
});
