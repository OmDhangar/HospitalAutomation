import { describe, expect, it } from 'vitest';
import {
  OrderType,
  OrderStatus,
  PriorityTag,
  TaskStatus,
  HoldReasons,
  RefusedReasons,
  NotAvailableReasons,
  LateReasons,
  StopReasons,
  OverrideReasons,
  AdmissionStatus,
  BadgeColors,
} from '../clinical';

describe('Clinical Constants', () => {
  it('defines all clinical order types, statuses, and reasons verbatim', () => {
    expect(OrderType.MEDICATION).toBe('MEDICATION');
    expect(OrderStatus.ACTIVE).toBe('ACTIVE');
    expect(PriorityTag.EMERGENCY).toBe('EMERGENCY');
    expect(TaskStatus.OVERDUE).toBe('OVERDUE');
    expect(HoldReasons).toContain('NPO');
    expect(RefusedReasons).toContain('Patient refused');
    expect(NotAvailableReasons).toContain('Out of stock');
    expect(LateReasons).toContain('Patient away from ward');
    expect(StopReasons).toContain('Course complete');
    expect(OverrideReasons).toContain('Benefit outweighs risk');
    expect(AdmissionStatus.ADMITTED).toBe('Admitted');
    expect(BadgeColors.green).toContain('emerald');
  });
});
