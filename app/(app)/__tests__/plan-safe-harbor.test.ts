import { describe, expect, it } from 'vitest';
import { PlanAccess, addDays } from '@/lib/domain/subscription';
import { getFeatureDecision } from '@/lib/domain/plan-policy';
import { can, StaffRole } from '@/lib/domain/permissions';

describe('plan safe harbor end-to-end policy verification', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');

  const softLockedAccess: PlanAccess = {
    state: 'soft_locked',
    hasAssignedPlan: true,
    reason: 'lapsed',
    endedAt: addDays(now, -10),
    locksAt: addDays(now, -3),
  };

  const revokedAccess: PlanAccess = {
    state: 'revoked',
    hasAssignedPlan: true,
    reason: 'suspended',
    endedAt: null,
  };

  it('permits doctors to conduct OPD consultations and write prescriptions during soft-lock', () => {
    const role: StaffRole = 'doctor';
    expect(can(role, 'clinical.write')).toBe(true);
    expect(can(role, 'queue.mutate')).toBe(true);
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'clinical.opd' })).toBe('allow');
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'clinical.records' })).toBe('allow');
  });

  it('permits receptionists to operate queue walk-ins and collect billing payments during soft-lock', () => {
    const role: StaffRole = 'receptionist';
    expect(can(role, 'queue.mutate')).toBe(true);
    expect(can(role, 'billing.collect')).toBe(true);
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'clinical.opd' })).toBe('allow');
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'operations.billing' })).toBe('allow');
  });

  it('permits nurses to record bedside vitals and MAR during soft-lock', () => {
    const role: StaffRole = 'nurse';
    expect(can(role, 'ipd.record')).toBe(true);
    expect(can(role, 'ipd.view')).toBe(true);
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'clinical.ipd' })).toBe('allow');
  });

  it('permits viewing historical reports while blocking exports during soft-lock', () => {
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'reports.history_view' })).toBe('allow');
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'reports.export' })).toBe('blocked');
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'reports.advanced' })).toBe('blocked');
  });

  it('allows transactional messaging while pausing broadcast campaigns and scheduled reminders during soft-lock', () => {
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'messaging.transactional' })).toBe('allow');
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'messaging.reminders' })).toBe('blocked');
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'messaging.campaigns' })).toBe('blocked');
  });

  it('permits owners to view and renew plan during soft-lock, but pauses ordinary staff onboarding', () => {
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'subscription.view' })).toBe('allow');
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'subscription.renew' })).toBe('allow');
    expect(getFeatureDecision({ access: softLockedAccess, feature: 'hospital.staff_onboard' })).toBe('blocked');
  });

  it('blocks self-service online renewal when plan is administratively revoked', () => {
    expect(getFeatureDecision({ access: revokedAccess, feature: 'subscription.view' })).toBe('allow');
    expect(getFeatureDecision({ access: revokedAccess, feature: 'subscription.renew' })).toBe('blocked');
    // Clinical care still preserved
    expect(getFeatureDecision({ access: revokedAccess, feature: 'clinical.opd' })).toBe('allow');
    expect(getFeatureDecision({ access: revokedAccess, feature: 'clinical.ipd' })).toBe('allow');
  });
});
