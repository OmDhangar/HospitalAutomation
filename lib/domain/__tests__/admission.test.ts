import { describe, expect, it } from 'vitest';
import {
  ADMISSION_STATUSES,
  UNDO_SHIFT_WINDOW_MS,
  canMoveAdmission,
  dayOfStay,
  isInBed,
  isLiveAdmission,
  shortPatientName,
  sinceLabel,
  tidyReason,
  undoShiftRefusal,
} from '../admission';

const TZ = 'Asia/Kolkata';

describe('canMoveAdmission', () => {
  it('admits from awaiting bed, and cancels only before a bed', () => {
    expect(canMoveAdmission('awaiting_bed', 'admitted')).toBe(true);
    expect(canMoveAdmission('awaiting_bed', 'cancelled')).toBe(true);
    expect(canMoveAdmission('admitted', 'cancelled')).toBe(false);
  });

  it('lets the doctor say ready and take it back, then the desk discharges', () => {
    expect(canMoveAdmission('admitted', 'discharge_ready')).toBe(true);
    expect(canMoveAdmission('discharge_ready', 'admitted')).toBe(true);
    expect(canMoveAdmission('discharge_ready', 'discharged')).toBe(true);
  });

  it('never moves out of an ending', () => {
    for (const to of ADMISSION_STATUSES) {
      expect(canMoveAdmission('discharged', to)).toBe(false);
      expect(canMoveAdmission('cancelled', to)).toBe(false);
    }
  });
});

describe('isLiveAdmission and isInBed', () => {
  it('counts a waiting patient as live but not yet in a bed', () => {
    expect(isLiveAdmission('awaiting_bed')).toBe(true);
    expect(isInBed('awaiting_bed')).toBe(false);
    expect(isInBed('discharge_ready')).toBe(true);
    expect(isLiveAdmission('discharged')).toBe(false);
  });
});

describe('undoShiftRefusal', () => {
  const requestedAt = new Date('2026-10-20T10:00:00Z');

  it('allows undo of a fresh, untouched request', () => {
    expect(
      undoShiftRefusal({ status: 'awaiting_bed', requestedAt, careEntryCount: 0, now: new Date('2026-10-20T10:05:00Z') }),
    ).toBeNull();
  });

  it('refuses once a bed is assigned, after ten minutes, or with entries', () => {
    expect(
      undoShiftRefusal({ status: 'admitted', requestedAt, careEntryCount: 0, now: requestedAt }),
    ).toBe('not_awaiting_bed');
    expect(
      undoShiftRefusal({
        status: 'awaiting_bed',
        requestedAt,
        careEntryCount: 0,
        now: new Date(requestedAt.getTime() + UNDO_SHIFT_WINDOW_MS + 1),
      }),
    ).toBe('too_late');
    expect(
      undoShiftRefusal({ status: 'awaiting_bed', requestedAt, careEntryCount: 1, now: requestedAt }),
    ).toBe('has_entries');
  });
});

describe('dayOfStay', () => {
  it('counts calendar days in the hospital’s timezone, admission day being Day 1', () => {
    const admitted = new Date('2026-10-20T17:00:00Z'); // 22:30 IST on the 20th
    expect(dayOfStay(admitted, new Date('2026-10-20T18:00:00Z'), TZ)).toBe(1); // 23:30 IST
    expect(dayOfStay(admitted, new Date('2026-10-20T19:00:00Z'), TZ)).toBe(2); // 00:30 IST on the 21st
    expect(dayOfStay(admitted, new Date('2026-10-22T06:00:00Z'), TZ)).toBe(3);
  });

  it('never reads below Day 1, even with a fast clock', () => {
    expect(dayOfStay(new Date('2026-10-21T00:00:00Z'), new Date('2026-10-20T00:00:00Z'), TZ)).toBe(1);
  });
});

describe('shortPatientName', () => {
  it('keeps the first name and the last initial', () => {
    expect(shortPatientName('Rahul Patil')).toBe('Rahul P.');
    expect(shortPatientName('  Rahul  Shankar   Patil ')).toBe('Rahul P.');
    expect(shortPatientName('Rahul')).toBe('Rahul');
  });
});

describe('sinceLabel', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  it('reads naturally at each scale', () => {
    expect(sinceLabel(now, now)).toBe('just now');
    expect(sinceLabel(new Date(now.getTime() - 12 * 60_000), now)).toBe('12 min ago');
    expect(sinceLabel(new Date(now.getTime() - 3 * 3_600_000), now)).toBe('3 h ago');
    expect(sinceLabel(new Date(now.getTime() - 26 * 3_600_000), now)).toBe('1 day ago');
  });
});

describe('tidyReason', () => {
  it('trims to one line of at most 200 characters, or nothing', () => {
    expect(tidyReason('  Fever,   dehydration ')).toBe('Fever, dehydration');
    expect(tidyReason('   ')).toBeNull();
    expect(tidyReason('x'.repeat(250))).toHaveLength(200);
  });
});
