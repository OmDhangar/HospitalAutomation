import { describe, it, expect } from 'vitest';
import { OpdClosedError } from '../queue';

describe('OpdClosedError domain error', () => {
  it('constructs from Date with backward-compatible defaults', () => {
    const testDate = new Date('2026-10-24T10:00:00Z');
    const err = new OpdClosedError(testDate);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OpdClosedError');
    expect(err.stoppedAt).toEqual(testDate);
    expect(err.closureType).toBe('stop_today');
    expect(err.isMultiDay).toBe(false);
    expect(err.serviceDate).toBeNull();
    expect(err.reopenDate).toBeNull();
    expect(err.reason).toBeNull();
    expect(err.publicReason).toBeNull();
    expect(err.message).toBe('OPD is closed for today');
  });

  it('constructs from blackout OpdClosureInfo with rich context', () => {
    const err = new OpdClosedError({
      closureType: 'blackout',
      isMultiDay: true,
      serviceDate: '2026-10-25',
      endDate: '2026-10-27',
      reopenDate: '2026-10-28',
      reason: 'Diwali Holidays maintenance',
      publicReason: 'Diwali Holiday',
    });

    expect(err.closureType).toBe('blackout');
    expect(err.isMultiDay).toBe(true);
    expect(err.serviceDate).toBe('2026-10-25');
    expect(err.endDate).toBe('2026-10-27');
    expect(err.reopenDate).toBe('2026-10-28');
    expect(err.reason).toBe('Diwali Holidays maintenance');
    expect(err.publicReason).toBe('Diwali Holiday');
    expect(err.stoppedAt).toBeNull();
    expect(err.message).toBe('OPD is closed on 2026-10-25');
  });

  it('constructs from stop_today OpdClosureInfo', () => {
    const testDate = new Date('2026-10-24T12:00:00Z');
    const err = new OpdClosedError({
      closureType: 'stop_today',
      stoppedAt: testDate,
      reason: 'Doctor called away for surgery',
    });

    expect(err.closureType).toBe('stop_today');
    expect(err.stoppedAt).toEqual(testDate);
    expect(err.reason).toBe('Doctor called away for surgery');
    expect(err.publicReason).toBe('Doctor called away for surgery');
    expect(err.message).toBe('OPD is closed for today');
  });
});
