import { describe, expect, it } from 'vitest';
import {
  categorizeAuditAction,
  groupConsecutiveEvents,
  isDestructiveAction,
} from '../audit';

describe('categorizeAuditAction', () => {
  it('categorizes known action prefixes correctly', () => {
    expect(categorizeAuditAction('auth.login')).toBe('auth');
    expect(categorizeAuditAction('session.start')).toBe('session');
    expect(categorizeAuditAction('opd.session.end')).toBe('session');
    expect(categorizeAuditAction('billing.invoice.create')).toBe('billing');
    expect(categorizeAuditAction('payment.recorded')).toBe('billing');
    expect(categorizeAuditAction('subscription.renew')).toBe('subscription');
    expect(categorizeAuditAction('support.impersonate')).toBe('support');
    expect(categorizeAuditAction('platform.access')).toBe('support');
    expect(categorizeAuditAction('config.update')).toBe('config');
    expect(categorizeAuditAction('settings.change')).toBe('config');
    expect(categorizeAuditAction('unknown.action')).toBe('other');
  });
});

describe('isDestructiveAction', () => {
  it('detects destructive action suffixes', () => {
    expect(isDestructiveAction('subscription.voided')).toBe(true);
    expect(isDestructiveAction('account.suspended')).toBe(true);
    expect(isDestructiveAction('plan.revoked')).toBe(true);
    expect(isDestructiveAction('user.deleted')).toBe(true);
    expect(isDestructiveAction('payment.failed')).toBe(true);
    expect(isDestructiveAction('subscription.renewed')).toBe(false);
    expect(isDestructiveAction('auth.login')).toBe(false);
  });
});

describe('groupConsecutiveEvents', () => {
  const baseTime = new Date('2026-10-25T10:00:00.000Z');

  it('handles a single event', () => {
    const events = [
      { id: '1', action: 'auth.login', actorName: 'Dr. Vinod', createdAt: baseTime },
    ];
    const groups = groupConsecutiveEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      category: 'auth',
      action: 'auth.login',
      actorName: 'Dr. Vinod',
      count: 1,
      firstAt: baseTime,
      lastAt: baseTime,
      isDestructive: false,
    });
  });

  it('groups two identical actions 30s apart into 1 group of count 2', () => {
    const t1 = new Date(baseTime.getTime() + 30_000);
    const t0 = baseTime;
    const events = [
      { id: '2', action: 'billing.payment.recorded', actorName: 'Reception', createdAt: t1 },
      { id: '1', action: 'billing.payment.recorded', actorName: 'Reception', createdAt: t0 },
    ];
    const groups = groupConsecutiveEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].firstAt).toEqual(t0);
    expect(groups[0].lastAt).toEqual(t1);
  });

  it('separates two identical actions 2 minutes apart into 2 groups', () => {
    const t1 = new Date(baseTime.getTime() + 120_000);
    const t0 = baseTime;
    const events = [
      { id: '2', action: 'auth.login', actorName: 'Dr. Vinod', createdAt: t1 },
      { id: '1', action: 'auth.login', actorName: 'Dr. Vinod', createdAt: t0 },
    ];
    const groups = groupConsecutiveEvents(events);
    expect(groups).toHaveLength(2);
    expect(groups[0].count).toBe(1);
    expect(groups[1].count).toBe(1);
  });

  it('separates different actions 5s apart into 2 groups', () => {
    const t1 = new Date(baseTime.getTime() + 5_000);
    const t0 = baseTime;
    const events = [
      { id: '2', action: 'auth.signout', actorName: 'Dr. Vinod', createdAt: t1 },
      { id: '1', action: 'auth.login', actorName: 'Dr. Vinod', createdAt: t0 },
    ];
    const groups = groupConsecutiveEvents(events);
    expect(groups).toHaveLength(2);
    expect(groups[0].action).toBe('auth.signout');
    expect(groups[1].action).toBe('auth.login');
  });

  it('merges two events with null actor if same action and within window', () => {
    const t1 = new Date(baseTime.getTime() + 15_000);
    const t0 = baseTime;
    const events = [
      { id: '2', action: 'subscription.renewed', actorName: null, createdAt: t1 },
      { id: '1', action: 'subscription.renewed', actorName: null, createdAt: t0 },
    ];
    const groups = groupConsecutiveEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].actorName).toBeNull();
  });

  it('handles empty input gracefully', () => {
    expect(groupConsecutiveEvents([])).toEqual([]);
  });
});
