import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BACK_HOURS,
  CHART_HOURS,
  FRONT_HOURS,
  TprInputError,
  addDays,
  chartDayOf,
  chartDayWindow,
  flagOf,
  formatTemperature,
  hourLabel,
  ioTotals,
  isLateEntry,
  localHour,
  parseBloodPressure,
  parseTemperature,
  parseTprBatch,
  shiftOf,
} from '../tpr';

const TZ = 'Asia/Kolkata';
// 10 Oct 2026 in India, built from UTC (IST = UTC+5:30).
const ist = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour - 5, minute - 30));

describe('temperature', () => {
  it('reads °F as typed and °C converted, stored as tenths of °F', () => {
    expect(parseTemperature('98.6')).toBe(986);
    expect(parseTemperature('100')).toBe(1000);
    expect(parseTemperature('37')).toBe(986);
    expect(parseTemperature('37.8')).toBe(1000);
    expect(parseTemperature('99,7')).toBe(997);
    expect(parseTemperature('')).toBeNull();
    expect(formatTemperature(986)).toBe('98.6');
  });

  it('refuses typing slips', () => {
    for (const raw of ['986', '9.86', '115', 'abc', '30']) expect(() => parseTemperature(raw), raw).toThrow(TprInputError);
  });
});

describe('blood pressure', () => {
  it('reads 120/80 in the ways it is written', () => {
    expect(parseBloodPressure('110/70')).toEqual({ systolic: 110, diastolic: 70 });
    expect(parseBloodPressure('110 70')).toEqual({ systolic: 110, diastolic: 70 });
    expect(parseBloodPressure(' 100-60 ')).toEqual({ systolic: 100, diastolic: 60 });
    expect(parseBloodPressure('')).toBeNull();
  });

  it('refuses the numbers the wrong way round or out of range', () => {
    for (const raw of ['70/110', '110', '400/80', '110/70/50']) expect(() => parseBloodPressure(raw), raw).toThrow(TprInputError);
  });
});

describe('the batch the phone sends', () => {
  const base = () => ({ clientId: randomUUID(), admissionId: randomUUID(), observedAt: '2026-10-10T08:00:00+05:30' });

  it('accepts a reading with any one value', () => {
    expect(parseTprBatch({ entries: [{ ...base(), pulse: 79 }] }).ok).toBe(true);
    expect(parseTprBatch({ entries: [{ ...base(), urineMl: 600 }] }).ok).toBe(true);
    expect(parseTprBatch({ entries: [{ ...base(), note: 'Patient sleeping' }] }).ok).toBe(true);
  });

  it('refuses an empty reading, half a B.P., values out of range, and unknown fields', () => {
    expect(parseTprBatch({ entries: [base()] })).toMatchObject({ ok: false, error: expect.stringMatching(/at least one/) });
    expect(parseTprBatch({ entries: [{ ...base(), bpSystolic: 110 }] })).toMatchObject({ ok: false });
    expect(parseTprBatch({ entries: [{ ...base(), bpSystolic: 70, bpDiastolic: 110 }] })).toMatchObject({ ok: false });
    expect(parseTprBatch({ entries: [{ ...base(), pulse: 400 }] })).toMatchObject({ ok: false });
    expect(parseTprBatch({ entries: [{ ...base(), pulse: 80, price: 1 }] })).toMatchObject({ ok: false });
    expect(parseTprBatch({ entries: [] })).toMatchObject({ ok: false });
  });
});

describe('flags', () => {
  it('flags values outside adult ranges, as text-able low/high', () => {
    expect(flagOf('pulse', 79)).toBeNull();
    expect(flagOf('pulse', 120)).toBe('high');
    expect(flagOf('spo2', 91)).toBe('low');
    expect(flagOf('spo2', 100)).toBeNull();
    expect(flagOf('tempFTenths', 1000)).toBe('high');
    expect(flagOf('pulse', null)).toBeNull();
  });
});

describe('the chart day', () => {
  it('runs 8 am to 8 am, so 7:59 am belongs to the day before and 8:00 am to today', () => {
    expect(chartDayOf(ist(10, 7, 59), TZ)).toBe('2026-10-09');
    expect(chartDayOf(ist(10, 8, 0), TZ)).toBe('2026-10-10');
    expect(chartDayOf(ist(10, 23, 30), TZ)).toBe('2026-10-10');
  });

  it('covers exactly 24 hours from 8 am', () => {
    const { from, to } = chartDayWindow('2026-10-10', TZ);
    expect(from).toEqual(ist(10, 8));
    expect(to).toEqual(ist(11, 8));
  });

  it('moves across month ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('has the paper’s rows: 8 am–10 pm on the front, 11 pm–7 am on the back', () => {
    expect(FRONT_HOURS.map(hourLabel)).toEqual([
      '8 am', '9 am', '10 am', '11 am', '12 pm', '1 pm', '2 pm', '3 pm', '4 pm', '5 pm', '6 pm', '7 pm', '8 pm', '9 pm', '10 pm',
    ]);
    expect(BACK_HOURS.map(hourLabel)).toEqual(['11 pm', '12 am', '1 am', '2 am', '3 am', '4 am', '5 am', '6 am', '7 am']);
    expect(CHART_HOURS).toHaveLength(24);
    expect(localHour(ist(10, 15, 40), TZ)).toBe(15);
  });
});

describe('intake and output', () => {
  it('totals by shift and for the day, with the balance', () => {
    const totals = ioTotals([
      { hour: 8, oralMl: 200, ivMl: 0 },
      { hour: 10, urineMl: 600 },
      { hour: 13, ivMl: 250 },
      { hour: 14, urineMl: 400, oralMl: 200 },
      { hour: 22, oralMl: 200, drainMl: 50 },
      { hour: 3, urineMl: 300, rtAspirateMl: 20 },
    ]);
    expect(totals.byShift.morning).toEqual({ intakeMl: 450, outputMl: 600, balanceMl: -150 });
    expect(totals.byShift.evening).toEqual({ intakeMl: 200, outputMl: 400, balanceMl: -200 });
    expect(totals.byShift.night).toEqual({ intakeMl: 200, outputMl: 370, balanceMl: -170 });
    expect(totals.day).toEqual({ intakeMl: 850, outputMl: 1370, balanceMl: -520 });
  });

  it('puts each hour in its shift', () => {
    expect([8, 13, 14, 19, 20, 0, 7].map(shiftOf)).toEqual(['morning', 'morning', 'evening', 'evening', 'night', 'night', 'night']);
  });
});

describe('late entries', () => {
  it('marks a reading entered more than two hours after it was taken', () => {
    expect(isLateEntry(ist(10, 8), ist(10, 10))).toBe(false);
    expect(isLateEntry(ist(10, 8), ist(10, 10, 1))).toBe(true);
  });
});
