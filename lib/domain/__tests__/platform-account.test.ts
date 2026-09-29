import { describe, expect, it } from 'vitest';
import {
  accountStanding,
  discountedPaise,
  entitlementAxis,
  needsAttention,
  normalisedMrrPaise,
  STANDING_RANK,
  termView,
  type StandingInput,
} from '../platform-account';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = utc('2026-09-30');

const base: StandingInput = {
  hospitalActive: true,
  subscriptionStatus: 'active',
  endsAt: utc('2026-12-31'),
  overLimit: false,
  now: NOW,
};

describe('accountStanding', () => {
  it('reports a paying hospital with room to spare as healthy', () => {
    expect(accountStanding(base)).toBe('healthy');
  });

  /**
   * The two suspension levers are independent and this is the one that has to
   * win: a hospital we switched off is off even while its subscription row
   * still says active, because that row is only what they agreed to pay.
   */
  it('treats an inactive hospital as suspended whatever the subscription says', () => {
    expect(accountStanding({ ...base, hospitalActive: false })).toBe('suspended');
    expect(
      accountStanding({ ...base, hospitalActive: false, subscriptionStatus: 'active' }),
    ).toBe('suspended');
  });

  it('reports a suspended subscription as suspended', () => {
    expect(accountStanding({ ...base, subscriptionStatus: 'suspended' })).toBe('suspended');
  });

  it.each(['expired', 'cancelled'] as const)('reports %s as expired', (status) => {
    expect(accountStanding({ ...base, subscriptionStatus: status })).toBe('expired');
  });

  /**
   * A hospital that was onboarded and never put on a plan is our billing
   * omission rather than their payment failure, and must not be filed under
   * the same label as a customer who lapsed.
   */
  it('distinguishes never-billed from lapsed', () => {
    expect(accountStanding({ ...base, subscriptionStatus: null })).toBe('unbilled');
  });

  it('flags a term inside a week as lapsing', () => {
    expect(accountStanding({ ...base, endsAt: utc('2026-10-04') })).toBe('lapsing');
  });

  it('does not flag a term a month out', () => {
    expect(accountStanding({ ...base, endsAt: utc('2026-10-25') })).toBe('healthy');
  });

  it('reports a past end date as expired even while the status says active', () => {
    expect(accountStanding({ ...base, endsAt: utc('2026-09-01') })).toBe('expired');
  });

  /**
   * The cascade, stated directly: an expiring plan outranks an entitlement
   * breach, because one cuts service off this week and the other costs the
   * customer nothing today.
   */
  it('prefers lapsing over over_limit when both apply', () => {
    expect(
      accountStanding({ ...base, endsAt: utc('2026-10-02'), overLimit: true }),
    ).toBe('lapsing');
  });

  it('reports over_limit when the term is comfortable', () => {
    expect(accountStanding({ ...base, overLimit: true })).toBe('over_limit');
  });

  it('reports a trial as a trial', () => {
    expect(accountStanding({ ...base, subscriptionStatus: 'trial' })).toBe('trial');
  });

  it('ranks worst first', () => {
    expect(STANDING_RANK.suspended).toBeLessThan(STANDING_RANK.lapsing);
    expect(STANDING_RANK.lapsing).toBeLessThan(STANDING_RANK.healthy);
  });
});

describe('needsAttention', () => {
  it('excludes the two standings that are working as sold', () => {
    expect(needsAttention('healthy')).toBe(false);
    expect(needsAttention('trial')).toBe(false);
    expect(needsAttention('lapsing')).toBe(true);
    expect(needsAttention('unbilled')).toBe(true);
  });
});

describe('entitlementAxis', () => {
  it('treats a null limit as unlimited rather than as zero', () => {
    const axis = entitlementAxis('branches', 12, null);
    expect(axis.limit).toBeNull();
    expect(axis.percent).toBeNull();
    expect(axis.atLimit).toBe(false);
    expect(axis.level).toBe('normal');
  });

  /**
   * At the cap, not past it — the flag exists to answer "can they add one
   * more", and three of three doctors cannot.
   */
  it('is at the limit when used equals the limit', () => {
    expect(entitlementAxis('doctors', 3, 3).atLimit).toBe(true);
    expect(entitlementAxis('doctors', 2, 3).atLimit).toBe(false);
  });

  /**
   * Over the limit is a legitimate state — a downgrade, or a cap introduced
   * after the hospital was already set up — so it is reported, never repaired.
   */
  it('reports being over the limit without clamping', () => {
    const axis = entitlementAxis('staff', 7, 5);
    expect(axis.used).toBe(7);
    expect(axis.atLimit).toBe(true);
    expect(axis.level).toBe('exhausted');
  });

  it('warns before the cap is reached', () => {
    expect(entitlementAxis('doctors', 8, 10).level).toBe('warning');
  });
});

describe('termView', () => {
  it('describes an expiring term', () => {
    const view = termView(utc('2026-10-02'), NOW);
    expect(view.bucket).toBe('within_3_days');
    expect(view.daysRemaining).toBe(2);
  });

  it('carries nulls through for a hospital with no plan', () => {
    expect(termView(null, NOW)).toEqual({
      endsAt: null,
      bucket: null,
      daysRemaining: null,
    });
  });
});

describe('normalisedMrrPaise', () => {
  /**
   * The whole point: an annual plan is sold at ten months for twelve, so
   * dividing by twelve is what makes a mixed-cycle portfolio total honest.
   * Reading the monthly rate card would overstate every annual customer.
   */
  it('spreads an annual price over twelve months', () => {
    expect(normalisedMrrPaise({ pricePaise: 1_200_000, billingCycle: 'annual' })).toBe(100_000);
  });

  it('passes a monthly price through untouched', () => {
    expect(normalisedMrrPaise({ pricePaise: 149_900, billingCycle: 'monthly' })).toBe(149_900);
  });
});

describe('discountedPaise', () => {
  it('applies a founding-customer rate', () => {
    expect(discountedPaise(100_000, 20)).toBe(80_000);
  });

  it('clamps nonsense rather than producing negative revenue', () => {
    expect(discountedPaise(100_000, 150)).toBe(0);
    expect(discountedPaise(100_000, -10)).toBe(100_000);
  });
});
