import { describe, expect, it } from 'vitest';
import {
  FREQUENCY_DEFAULTS,
  isValidClockTime,
  getScheduleTimesForFrequency,
  calculateScheduledOccurrences,
  getTaskTimeCategory,
} from '@/lib/domain/ipd-schedule';

describe('ipd-schedule', () => {
  it('validates 24-hour clock time strings', () => {
    expect(isValidClockTime('08:00')).toBe(true);
    expect(isValidClockTime('00:00')).toBe(true);
    expect(isValidClockTime('23:59')).toBe(true);
    expect(isValidClockTime('24:00')).toBe(false);
    expect(isValidClockTime('8:00')).toBe(false);
    expect(isValidClockTime('invalid')).toBe(false);
  });

  it('returns default schedule times for standard frequencies', () => {
    expect(getScheduleTimesForFrequency('OD')).toEqual(['08:00']);
    expect(getScheduleTimesForFrequency('BD')).toEqual(['08:00', '20:00']);
    expect(getScheduleTimesForFrequency('TDS')).toEqual(['08:00', '14:00', '20:00']);
    expect(getScheduleTimesForFrequency('QID')).toEqual(['06:00', '12:00', '18:00', '00:00']);
    expect(getScheduleTimesForFrequency('Stat')).toEqual([]);
    expect(getScheduleTimesForFrequency('PRN')).toEqual([]);
    expect(getScheduleTimesForFrequency('SOS')).toEqual([]);
  });

  it('calculates scheduled dose occurrences within a time window', () => {
    const startsAt = new Date('2026-10-12T06:00:00+05:30');
    const endsAt = new Date('2026-10-15T06:00:00+05:30');
    const occurrences = calculateScheduledOccurrences({
      scheduleTimes: ['08:00', '20:00'],
      startsAt,
      endsAt,
      from: new Date('2026-10-12T00:00:00+05:30'),
      to: new Date('2026-10-13T00:00:00+05:30'),
      timezone: 'Asia/Kolkata',
    });

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].toISOString()).toBe(new Date('2026-10-12T08:00:00+05:30').toISOString());
    expect(occurrences[1].toISOString()).toBe(new Date('2026-10-12T20:00:00+05:30').toISOString());
  });

  it('classifies dose task into due_now, overdue, or upcoming', () => {
    const target = new Date('2026-10-12T08:30:00Z');
    // within 60m: [07:30, 09:30]
    expect(getTaskTimeCategory(new Date('2026-10-12T08:00:00Z'), target)).toBe('due_now');
    expect(getTaskTimeCategory(new Date('2026-10-12T07:30:00Z'), target)).toBe('due_now');
    expect(getTaskTimeCategory(new Date('2026-10-12T09:30:00Z'), target)).toBe('due_now');
    // older than 60m: before 07:30
    expect(getTaskTimeCategory(new Date('2026-10-12T07:00:00Z'), target)).toBe('overdue');
    // more than 60m in future: after 09:30
    expect(getTaskTimeCategory(new Date('2026-10-12T10:00:00Z'), target)).toBe('upcoming');
  });
});
