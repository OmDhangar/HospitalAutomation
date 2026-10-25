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
    const activeTerm = term('active', addDays(now, 10));
    expect(planAccess({ current: activeTerm, latest: null, now })).toEqual({
      state: 'open',
      hasAssignedPlan: true,
      endsAt: activeTerm.endsAt,
    });

    const trialTerm = term('trial', addDays(now, 2));
    expect(planAccess({ current: trialTerm, latest: null, now })).toEqual({
      state: 'open',
      hasAssignedPlan: true,
      endsAt: trialTerm.endsAt,
    });
  });

  it('revokes an administratively suspended plan at once', () => {
    const suspended = term('suspended', addDays(now, 10));
    expect(planAccess({ current: suspended, latest: suspended, now })).toEqual({
      state: 'revoked',
      hasAssignedPlan: true,
      reason: 'suspended',
      endedAt: null,
    });

    expect(planAccess({ current: null, latest: null, now, isAdministrativeSuspension: true })).toEqual({
      state: 'revoked',
      hasAssignedPlan: true,
      reason: 'revoked',
      endedAt: null,
    });
  });

  it(`gives a plan that ran out ${LAPSE_GRACE_DAYS} days of grace, then transitions to soft_locked`, () => {
    const endedYesterday = term('expired', addDays(now, -1));
    expect(planAccess({ current: null, latest: endedYesterday, now })).toEqual({
      state: 'grace',
      hasAssignedPlan: true,
      endedAt: endedYesterday.endsAt,
      locksAt: addDays(endedYesterday.endsAt, LAPSE_GRACE_DAYS),
    });

    const endedLongAgo = term('expired', addDays(now, -(LAPSE_GRACE_DAYS + 1)));
    expect(planAccess({ current: null, latest: endedLongAgo, now })).toEqual({
      state: 'soft_locked',
      hasAssignedPlan: true,
      reason: 'lapsed',
      endedAt: endedLongAgo.endsAt,
      locksAt: addDays(endedLongAgo.endsAt, LAPSE_GRACE_DAYS),
    });
  });

  it('treats a trial that ended exactly like a paid plan that ended', () => {
    const trial = term('trial', addDays(now, -(LAPSE_GRACE_DAYS + 1)));
    expect(planAccess({ current: null, latest: trial, now })).toEqual({
      state: 'soft_locked',
      hasAssignedPlan: true,
      reason: 'lapsed',
      endedAt: trial.endsAt,
      locksAt: addDays(trial.endsAt, LAPSE_GRACE_DAYS),
    });
  });

  it('treats scheduled cancellation as open until endsAt, then grace and soft_locked', () => {
    const activeCancelled = term('cancelled', addDays(now, 5));
    expect(planAccess({ current: activeCancelled, latest: activeCancelled, now })).toEqual({
      state: 'open',
      hasAssignedPlan: true,
      endsAt: activeCancelled.endsAt,
    });

    const endedCancelled = term('cancelled', addDays(now, -1));
    expect(planAccess({ current: null, latest: endedCancelled, now })).toEqual({
      state: 'grace',
      hasAssignedPlan: true,
      endedAt: endedCancelled.endsAt,
      locksAt: addDays(endedCancelled.endsAt, LAPSE_GRACE_DAYS),
    });
  });

  it('never locks a hospital that was never put on a plan', () => {
    expect(planAccess({ current: null, latest: null, now })).toEqual({
      state: 'open',
      hasAssignedPlan: false,
      endsAt: null,
    });
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
