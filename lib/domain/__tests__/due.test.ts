import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUE_SETTINGS,
  dueSettingsFrom,
  inQuietHours,
  instancesFor,
  parseClockTimes,
  shiftNow,
  slotOf,
  suggestTiming,
  timingOfGive,
  windowFor,
  type DueRecord,
  type LineForDue,
} from '../due';

const TZ = 'Asia/Kolkata';
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
const D = '2026-10-12';
const settings = DEFAULT_DUE_SETTINGS;
const tc = (timing: LineForDue['timing'], extra: Partial<LineForDue> = {}): LineForDue => ({
  timing,
  orderedAt: at(D, '07:00'),
  stoppedAt: null,
  windowBeforeMin: 30,
  windowAfterMin: 30,
  ...extra,
});
const given = (dueAt: Date | null, occurredAt: Date, id = crypto.randomUUID()): DueRecord => ({ id, dueAt, state: 'given', occurredAt });
const run = (line: LineForDue, records: DueRecord[], now: Date, snoozes?: { dueAt: Date; until: Date }[]) =>
  instancesFor({ line, records, from: at(D, '00:00'), to: at('2026-10-13', '08:00'), now, timezone: TZ, settings, snoozes });

describe('timing', () => {
  it('reads clock times as typed', () => {
    expect(parseClockTimes('08:00, 20:00')).toEqual([480, 1200]);
    expect(parseClockTimes('8 20')).toEqual([480, 1200]);
    expect(parseClockTimes('2000 0800')).toEqual([480, 1200]);
    expect(parseClockTimes('24')).toEqual([0]);
    expect(parseClockTimes('25:00')).toBeNull();
    expect(parseClockTimes('soon')).toBeNull();
  });

  it('suggests timing from the written frequency, for the doctor to change', () => {
    expect(suggestTiming('BD')).toEqual({ mode: 'clock', clockTimes: [480, 1200] });
    expect(suggestTiming('tds')).toEqual({ mode: 'clock', clockTimes: [360, 840, 1320] });
    expect(suggestTiming('q12h')).toEqual({ mode: 'interval', intervalMin: 720 });
    expect(suggestTiming('SOS')).toEqual({ mode: 'prn' });
    expect(suggestTiming('STAT')).toEqual({ mode: 'once' });
  });

  it('keeps settings inside bounds and windows per medicine', () => {
    expect(dueSettingsFrom({ tcWindowMin: 45, l1AfterMin: 0, junk: 1 })).toMatchObject({ tcWindowMin: 45, l1AfterMin: 15 });
    expect(windowFor({ timeCritical: true, medicineBefore: 15, medicineAfter: null, settings })).toEqual({ before: 15, after: 30 });
    expect(windowFor({ timeCritical: false, medicineBefore: 15, medicineAfter: 15, settings })).toEqual({ before: 60, after: 60 });
  });
});

describe('instances of a clock line', () => {
  const line = tc({ mode: 'clock', clockTimes: [480, 1200], latePolicy: 'keep' });

  it('walks through due soon, due now, overdue, and escalates past the window', () => {
    const status = (now: string) => run(line, [], at(D, now))[0];
    expect(status('07:00').status).toBe('due_soon'); // window opens 07:30, lead 30 min
    expect(status('06:50').status).toBe('upcoming');
    expect(status('08:20').status).toBe('due_now');
    expect(status('08:31')).toMatchObject({ status: 'overdue', escalation: 0 });
    expect(status('08:46')).toMatchObject({ status: 'overdue', escalation: 1, overdueMin: 16 });
    expect(status('09:16')).toMatchObject({ status: 'overdue', escalation: 2 });
  });

  it('marks doses on time, late, early and not given, by the due time they answer', () => {
    const late = given(at(D, '08:00'), at(D, '08:50'));
    const notGiven: DueRecord = { id: 'x', dueAt: at(D, '20:00'), state: 'refused', occurredAt: at(D, '20:05') };
    const list = run(line, [late, notGiven], at(D, '21:00'));
    expect(list.map((i) => i.status)).toEqual(['given_late', 'not_given']);
    expect(run(line, [given(at(D, '08:00'), at(D, '07:20'))], at(D, '09:00'))[0].status).toBe('given_early');
    expect(run(line, [given(at(D, '08:00'), at(D, '08:10'))], at(D, '09:00'))[0].status).toBe('given_on_time');
  });

  it('keeps the schedule after a late dose and warns when the next comes too close', () => {
    const veryLate = given(at(D, '08:00'), at(D, '14:30'));
    const [, evening] = run(line, [veryLate], at(D, '15:00'));
    expect(evening.dueAt).toEqual(at(D, '20:00'));
    expect(evening.closeToPrevious).toBe(true);
  });

  it('holds escalation while snoozed', () => {
    const [first] = run(line, [], at(D, '08:50'), [{ dueAt: at(D, '08:00'), until: at(D, '09:10') }]);
    expect(first).toMatchObject({ status: 'overdue', escalation: 0 });
  });

  it('starts after the order and ends when stopped', () => {
    const late = tc({ mode: 'clock', clockTimes: [480, 1200], latePolicy: 'keep' }, { orderedAt: at(D, '09:00'), stoppedAt: at('2026-10-13', '07:00') });
    expect(run(late, [], at(D, '09:00')).map((i) => i.dueAt)).toEqual([at(D, '20:00')]);
  });
});

describe('instances of an interval line', () => {
  it('shifts after a late dose by default: next = given + interval', () => {
    const line = tc({ mode: 'interval', intervalMin: 720, firstDueAt: at(D, '06:00'), latePolicy: 'shift' });
    const list = run(line, [given(at(D, '06:00'), at(D, '07:00'))], at(D, '08:00'));
    expect(list.map((i) => i.dueAt)).toEqual([at(D, '06:00'), at(D, '19:00'), at('2026-10-13', '07:00')]);
    expect(list[0].status).toBe('given_late');
  });

  it('keeps the grid when the doctor asks it to', () => {
    const line = tc({ mode: 'interval', intervalMin: 720, firstDueAt: at(D, '06:00'), latePolicy: 'keep' });
    expect(run(line, [given(at(D, '06:00'), at(D, '07:00'))], at(D, '08:00')).map((i) => i.dueAt)).toEqual([at(D, '06:00'), at(D, '18:00'), at('2026-10-13', '06:00')]);
  });

  it('is never due for SOS, once for STAT', () => {
    expect(run(tc({ mode: 'prn' }), [], at(D, '10:00'))).toEqual([]);
    expect(run(tc({ mode: 'once', firstDueAt: at(D, '07:00') }), [], at(D, '10:00')).map((i) => i.status)).toEqual(['overdue']);
  });
});

describe('timed tasks', () => {
  it('are completed by a chart reading inside the window', () => {
    const line = tc({ mode: 'interval', intervalMin: 240, firstDueAt: at(D, '08:00'), latePolicy: 'keep' }, { windowBeforeMin: 60, windowAfterMin: 60 });
    const reading: DueRecord = { id: 'r1', dueAt: null, state: 'given', occurredAt: at(D, '08:40'), fromChart: true };
    const [first, second] = run(line, [reading], at(D, '12:30'));
    expect(first.status).toBe('given_on_time');
    expect(second.status).toBe('due_now');
  });
});

describe('gives against the due time', () => {
  it('are on time inside the window, late or early outside it, with the delay', () => {
    const due = at(D, '08:00');
    expect(timingOfGive({ dueAt: due, occurredAt: at(D, '08:20'), windowBeforeMin: 30, windowAfterMin: 30 })).toEqual({ status: 'on_time', delayMin: 20 });
    expect(timingOfGive({ dueAt: due, occurredAt: at(D, '08:45'), windowBeforeMin: 30, windowAfterMin: 30 })).toEqual({ status: 'late', delayMin: 45 });
    expect(timingOfGive({ dueAt: due, occurredAt: at(D, '07:00'), windowBeforeMin: 30, windowAfterMin: 30 })).toEqual({ status: 'early', delayMin: -60 });
  });
});

describe('the board helpers', () => {
  it('puts a due time in its round column, and knows the shift and quiet hours', () => {
    expect(slotOf(at(D, '08:00'), TZ)).toBe(8);
    expect(slotOf(at(D, '09:30'), TZ)).toBe(8);
    expect(slotOf(at(D, '01:00'), TZ)).toBe(0);
    expect(shiftNow(at(D, '09:00'), TZ)).toEqual({ day: D, shift: 'morning' });
    expect(shiftNow(at(D, '03:00'), TZ)).toEqual({ day: '2026-10-11', shift: 'night' });
    expect(inQuietHours(at(D, '23:00'), TZ, '22:00', '06:00')).toBe(true);
    expect(inQuietHours(at(D, '12:00'), TZ, '22:00', '06:00')).toBe(false);
  });
});
