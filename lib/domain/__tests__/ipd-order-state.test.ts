import { describe, expect, it } from 'vitest';
import {
  isOrderActionable,
  validateOrderTransition,
  IPD_ORDER_STATUSES,
  IPD_ORDER_ACTIONS,
} from '@/lib/domain/ipd-order-state';

describe('ipd-order-state', () => {
  it('exports valid statuses and actions matching specification', () => {
    expect(IPD_ORDER_STATUSES).toEqual([
      'draft',
      'active',
      'on_hold',
      'discontinued',
      'completed',
      'superseded',
      'voided',
    ]);
    expect(IPD_ORDER_ACTIONS).toEqual([
      'sign',
      'hold',
      'resume',
      'discontinue',
      'modify',
      'renew',
      'expire',
      'void',
    ]);
  });

  it('determines if order is actionable at runtime', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    expect(isOrderActionable({ status: 'active', endsAt: new Date('2026-10-12T13:00:00Z') }, now)).toBe(true);
    expect(isOrderActionable({ status: 'active', endsAt: null }, now)).toBe(true);
    // Expired by time even if status still active
    expect(isOrderActionable({ status: 'active', endsAt: new Date('2026-10-12T11:00:00Z') }, now)).toBe(false);
    // Non-active states
    expect(isOrderActionable({ status: 'draft' }, now)).toBe(false);
    expect(isOrderActionable({ status: 'on_hold' }, now)).toBe(false);
    expect(isOrderActionable({ status: 'discontinued' }, now)).toBe(false);
    expect(isOrderActionable({ status: 'voided' }, now)).toBe(false);
    expect(isOrderActionable({ status: 'completed' }, now)).toBe(false);
    expect(isOrderActionable({ status: 'superseded' }, now)).toBe(false);
  });

  it('validates signing draft orders', () => {
    const res = validateOrderTransition({
      currentStatus: 'draft',
      action: 'sign',
      doctorId: 'doc-123',
      now: new Date(),
    });
    expect(res.valid).toBe(true);
    expect(res.nextStatus).toBe('active');

    const invalid = validateOrderTransition({
      currentStatus: 'draft',
      action: 'sign',
      doctorId: null,
      now: new Date(),
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toContain('doctor');
  });

  it('requires structured reason for hold, resume, discontinue, void', () => {
    expect(validateOrderTransition({ currentStatus: 'active', action: 'hold', reason: null, now: new Date() }).valid).toBe(false);
    expect(validateOrderTransition({ currentStatus: 'active', action: 'hold', reason: 'ab', now: new Date() }).valid).toBe(false); // < 3 chars
    expect(validateOrderTransition({ currentStatus: 'active', action: 'hold', reason: 'NPO for surgery', now: new Date() }).valid).toBe(true);

    expect(validateOrderTransition({ currentStatus: 'on_hold', action: 'resume', reason: 'Post-op cleared', now: new Date() }).valid).toBe(true);
    expect(validateOrderTransition({ currentStatus: 'active', action: 'discontinue', reason: 'Adverse reaction', now: new Date() }).valid).toBe(true);
    expect(validateOrderTransition({ currentStatus: 'active', action: 'void', reason: 'Wrong patient chart', now: new Date() }).valid).toBe(true);
  });

  it('validates modify and renew actions transition to superseded', () => {
    const modifyRes = validateOrderTransition({
      currentStatus: 'active',
      action: 'modify',
      reason: 'Dose titration 1g to 2g',
      successorOrderId: 'new-order-uuid',
      now: new Date(),
    });
    expect(modifyRes.valid).toBe(true);
    expect(modifyRes.nextStatus).toBe('superseded');

    const renewRes = validateOrderTransition({
      currentStatus: 'active',
      action: 'renew',
      reason: 'Extend antibiotic 3 more days',
      successorOrderId: 'new-order-uuid-2',
      now: new Date(),
    });
    expect(renewRes.valid).toBe(true);
    expect(renewRes.nextStatus).toBe('superseded');
  });

  it('transitions active to completed upon expiration', () => {
    const now = new Date('2026-10-12T15:00:00Z');
    const endsAt = new Date('2026-10-12T14:00:00Z');
    const res = validateOrderTransition({
      currentStatus: 'active',
      action: 'expire',
      endsAt,
      now,
    });
    expect(res.valid).toBe(true);
    expect(res.nextStatus).toBe('completed');
  });
});
