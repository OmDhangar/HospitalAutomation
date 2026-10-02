import { describe, expect, it } from 'vitest';
import { addDays, chargeableBedDays } from '../bed-days';

const TZ = 'Asia/Kolkata';
/** An instant at a given IST wall-clock time. */
const ist = (date: string, time = '10:00') => new Date(`${date}T${time}:00+05:30`);

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});

describe('chargeableBedDays', () => {
  const one = [{ assignmentId: 'a', fromAt: ist('2026-10-20', '22:30'), toAt: null }];

  it('charges a running stay from the admission day up to today', () => {
    const days = chargeableBedDays({
      admittedAt: ist('2026-10-20', '22:30'),
      endedAt: null,
      spells: one,
      now: ist('2026-10-22', '09:00'),
      timezone: TZ,
    });
    expect(days.map((d) => d.serviceDate)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });

  it('does not charge the discharge day', () => {
    const days = chargeableBedDays({
      admittedAt: ist('2026-10-20'),
      endedAt: ist('2026-10-23', '11:00'),
      spells: [{ assignmentId: 'a', fromAt: ist('2026-10-20'), toAt: ist('2026-10-23', '11:00') }],
      now: ist('2026-10-25'),
      timezone: TZ,
    });
    expect(days.map((d) => d.serviceDate)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });

  it('charges a same-day admission and discharge once', () => {
    const days = chargeableBedDays({
      admittedAt: ist('2026-10-20', '09:00'),
      endedAt: ist('2026-10-20', '18:00'),
      spells: [{ assignmentId: 'a', fromAt: ist('2026-10-20', '09:00'), toAt: ist('2026-10-20', '18:00') }],
      now: ist('2026-10-21'),
      timezone: TZ,
    });
    expect(days).toEqual([{ serviceDate: '2026-10-20', assignmentId: 'a' }]);
  });

  it('charges a transfer day to the bed occupied at the start of that day', () => {
    const days = chargeableBedDays({
      admittedAt: ist('2026-10-20', '10:00'),
      endedAt: null,
      spells: [
        { assignmentId: 'general', fromAt: ist('2026-10-20', '10:00'), toAt: ist('2026-10-21', '15:00') },
        { assignmentId: 'icu', fromAt: ist('2026-10-21', '15:00'), toAt: null },
      ],
      now: ist('2026-10-22', '08:00'),
      timezone: TZ,
    });
    expect(days).toEqual([
      { serviceDate: '2026-10-20', assignmentId: 'general' },
      { serviceDate: '2026-10-21', assignmentId: 'general' },
      { serviceDate: '2026-10-22', assignmentId: 'icu' },
    ]);
  });

  it('charges the admission day to the first bed, even after a same-day transfer', () => {
    const days = chargeableBedDays({
      admittedAt: ist('2026-10-20', '09:00'),
      endedAt: null,
      spells: [
        { assignmentId: 'first', fromAt: ist('2026-10-20', '09:00'), toAt: ist('2026-10-20', '12:00') },
        { assignmentId: 'second', fromAt: ist('2026-10-20', '12:00'), toAt: null },
      ],
      now: ist('2026-10-21'),
      timezone: TZ,
    });
    expect(days).toEqual([
      { serviceDate: '2026-10-20', assignmentId: 'first' },
      { serviceDate: '2026-10-21', assignmentId: 'second' },
    ]);
  });

  it('uses the hospital’s calendar, not UTC', () => {
    // 00:30 IST on the 21st is still the 20th in UTC.
    const days = chargeableBedDays({
      admittedAt: ist('2026-10-21', '00:30'),
      endedAt: null,
      spells: [{ assignmentId: 'a', fromAt: ist('2026-10-21', '00:30'), toAt: null }],
      now: ist('2026-10-21', '01:00'),
      timezone: TZ,
    });
    expect(days.map((d) => d.serviceDate)).toEqual(['2026-10-21']);
  });

  it('charges nothing without a bed', () => {
    expect(chargeableBedDays({ admittedAt: ist('2026-10-20'), endedAt: null, spells: [], now: ist('2026-10-21'), timezone: TZ })).toEqual([]);
  });
});
