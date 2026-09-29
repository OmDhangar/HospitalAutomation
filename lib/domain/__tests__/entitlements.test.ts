import { describe, expect, it } from 'vitest';
import {
  checkLimit,
  hasFeature,
  limitFor,
  limitMessage,
  supportLabel,
  type Entitlements,
} from '../entitlements';

const plan = (over: Partial<Entitlements> = {}): Entitlements => ({
  maxBranches: 1,
  maxDoctors: 3,
  maxStaffLogins: 4,
  hasDisplayBoard: true,
  hasOwnerReport: false,
  hasAdvancedReports: false,
  hasDataExport: false,
  hasAuditLog: false,
  supportTier: 'email_24h',
  ...over,
});

describe('limits', () => {
  it('allows another while below the limit', () => {
    expect(checkLimit({ entitlements: plan(), kind: 'doctors', current: 2 })).toEqual({
      allowed: true,
    });
  });

  it('refuses at the limit, not one past it', () => {
    // Three doctors on a three-doctor plan means the next one is the fourth.
    const check = checkLimit({ entitlements: plan(), kind: 'doctors', current: 3 });
    expect(check.allowed).toBe(false);
  });

  it('treats null as unlimited rather than as zero', () => {
    const unlimited = plan({ maxDoctors: null });
    expect(checkLimit({ entitlements: unlimited, kind: 'doctors', current: 9999 })).toEqual({
      allowed: true,
    });
    expect(limitFor(unlimited, 'doctors')).toBeNull();
  });

  it('leaves a hospital already over its limit alone, and only stops the next one', () => {
    /**
     * This happens legitimately: a downgrade, or a limit introduced after the
     * hospital was already set up. Removing their fourth doctor because the
     * rate card changed would be indefensible, so the rule is only ever about
     * the *next* addition.
     */
    const check = checkLimit({ entitlements: plan(), kind: 'doctors', current: 7 });
    expect(check).toEqual({ allowed: false, limit: 3, current: 7, kind: 'doctors' });
  });

  it('reads each axis independently', () => {
    const p = plan();
    expect(limitFor(p, 'branches')).toBe(1);
    expect(limitFor(p, 'doctors')).toBe(3);
    expect(limitFor(p, 'staff')).toBe(4);
  });
});

describe('features', () => {
  it('reports what the tier withholds', () => {
    const p = plan();
    expect(hasFeature(p, 'display_board')).toBe(true);
    expect(hasFeature(p, 'owner_report')).toBe(false);
    expect(hasFeature(p, 'audit_log')).toBe(false);
  });
});

describe('the message somebody actually reads', () => {
  const refused = { allowed: false, limit: 3, current: 3, kind: 'doctors' } as const;

  it('names both numbers and the plan that lifts the limit', () => {
    const message = limitMessage(refused, {
      name: 'Practice',
      limit: 6,
      monthlyPricePaise: 499900,
    });

    expect(message).toContain('3 doctors');
    expect(message).toContain('Practice');
    expect(message).toContain('6 doctors');
    // Indian digit grouping, because the reader is pricing it in rupees.
    expect(message).toContain('₹4,999/month');
  });

  it('says unlimited rather than printing a number for the top tier', () => {
    const message = limitMessage(refused, {
      name: 'Multi-branch',
      limit: null,
      monthlyPricePaise: 1299900,
    });
    expect(message).toContain('unlimited doctors');
  });

  it('still says something useful when no higher plan exists', () => {
    const message = limitMessage(refused);
    expect(message).toContain('3 doctors');
    expect(message).not.toContain('upgrade');
  });

  it('gets the singular right, since a one-branch plan is the common case', () => {
    const message = limitMessage(
      { allowed: false, limit: 1, current: 1, kind: 'branches' },
      { name: 'Hospital', limit: 3, monthlyPricePaise: 699900 },
    );
    expect(message).toContain('1 branch');
    expect(message).toContain('3 branches');
  });
});

describe('support labels', () => {
  it('describes each tier, and falls back rather than showing a raw code', () => {
    expect(supportLabel('whatsapp_4h')).toBe('WhatsApp support, 4-hour response');
    expect(supportLabel('dedicated')).toBe('Dedicated account manager');
    expect(supportLabel('something_new')).toBe('Email support');
  });
});
