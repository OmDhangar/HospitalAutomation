import { describe, expect, it } from 'vitest';
import { LAPSE_GRACE_DAYS, addDays, parseTrialDays, planAccess } from '../subscription';

const now = new Date('2026-10-04T12:00:00.000Z');
const term = (status: 'trial' | 'active' | 'expired' | 'cancelled' | 'suspended', endsAt: Date) => ({
  status,
  startsAt: addDays(endsAt, -30),
  endsAt,
});

describe('planAccess', () => {
  it('lets a hospital with a live plan or trial in', () => {
    expect(planAccess({ current: term('active', addDays(now, 10)), latest: null, now })).toEqual({ state: 'open' });
    expect(planAccess({ current: term('trial', addDays(now, 2)), latest: null, now })).toEqual({ state: 'open' });
  });

  it('locks a revoked or suspended plan at once', () => {
    const revoked = term('cancelled', addDays(now, 10));
    expect(planAccess({ current: revoked, latest: revoked, now })).toMatchObject({ state: 'locked', reason: 'revoked' });
    const suspended = term('suspended', addDays(now, 10));
    expect(planAccess({ current: suspended, latest: suspended, now })).toMatchObject({ state: 'locked', reason: 'suspended' });
  });

  it(`gives a plan that ran out ${LAPSE_GRACE_DAYS} days of grace, then locks it`, () => {
    const endedYesterday = term('expired', addDays(now, -1));
    expect(planAccess({ current: null, latest: endedYesterday, now })).toEqual({
      state: 'grace',
      endedAt: endedYesterday.endsAt,
      locksAt: addDays(endedYesterday.endsAt, LAPSE_GRACE_DAYS),
    });

    const endedLongAgo = term('expired', addDays(now, -(LAPSE_GRACE_DAYS + 1)));
    expect(planAccess({ current: null, latest: endedLongAgo, now })).toMatchObject({ state: 'locked', reason: 'lapsed' });
  });

  it('treats a trial that ended exactly like a paid plan that ended', () => {
    const trial = term('trial', addDays(now, -(LAPSE_GRACE_DAYS + 1)));
    expect(planAccess({ current: null, latest: trial, now })).toMatchObject({ state: 'locked', reason: 'lapsed' });
  });

  it('locks a revoked plan even inside the grace days', () => {
    const revoked = term('cancelled', addDays(now, -1));
    expect(planAccess({ current: null, latest: revoked, now })).toMatchObject({ state: 'locked', reason: 'revoked' });
  });

  it('never locks a hospital that was never put on a plan', () => {
    expect(planAccess({ current: null, latest: null, now })).toEqual({ state: 'open' });
  });
});

describe('parseTrialDays', () => {
  it('reads whole days from 1 to 90', () => {
    expect(parseTrialDays('15')).toBe(15);
    expect(parseTrialDays(' 20 ')).toBe(20);
    expect(parseTrialDays('90')).toBe(90);
  });

  it('refuses nothing, zero, fractions, words and too long', () => {
    for (const input of ['', '0', '7.5', 'ten', '-3', '91']) expect(parseTrialDays(input)).toBeNull();
  });
});
