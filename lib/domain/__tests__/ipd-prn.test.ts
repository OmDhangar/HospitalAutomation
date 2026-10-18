import { describe, expect, it } from 'vitest';
import {
  checkPrnEligibility,
  getChartDayWindow,
  getPrnChainLockKey,
} from '@/lib/domain/ipd-prn';

describe('ipd-prn', () => {
  it('generates stable advisory lock key for order chain', () => {
    const chainId = '11111111-2222-3333-4444-555555555555';
    expect(getPrnChainLockKey(chainId)).toBe('ipd_prn_chain:11111111-2222-3333-4444-555555555555');
  });

  it('calculates chart day window from 08:00 to 08:00', () => {
    // 10:00 on Oct 12 -> [Oct 12 08:00, Oct 13 08:00]
    const window1 = getChartDayWindow(new Date('2026-10-12T10:00:00+05:30'), 'Asia/Kolkata');
    expect(window1.start.toISOString()).toBe(new Date('2026-10-12T08:00:00+05:30').toISOString());
    expect(window1.end.toISOString()).toBe(new Date('2026-10-13T08:00:00+05:30').toISOString());

    // 07:30 on Oct 12 -> belongs to previous chart day [Oct 11 08:00, Oct 12 08:00]
    const window2 = getChartDayWindow(new Date('2026-10-12T07:30:00+05:30'), 'Asia/Kolkata');
    expect(window2.start.toISOString()).toBe(new Date('2026-10-11T08:00:00+05:30').toISOString());
    expect(window2.end.toISOString()).toBe(new Date('2026-10-12T08:00:00+05:30').toISOString());
  });

  it('enforces minimum cooldown interval between doses', () => {
    const lastGiven = new Date('2026-10-12T09:00:00+05:30');
    const requested = new Date('2026-10-12T11:00:00+05:30'); // only 2 hours later
    const result = checkPrnEligibility({
      order: { prnMinIntervalHours: 4, prnMaxDailyDoses: 4 },
      history: [{ actualTime: lastGiven, doseAmountNumeric: 500, voidedAt: null }],
      requestedAt: requested,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Cooldown interval');
    expect(result.remainingCooldownMinutes).toBe(120);
  });

  it('enforces maximum daily doses per chart day', () => {
    const history = [
      { actualTime: new Date('2026-10-12T08:30:00+05:30'), doseAmountNumeric: 500, voidedAt: null },
      { actualTime: new Date('2026-10-12T13:00:00+05:30'), doseAmountNumeric: 500, voidedAt: null },
      { actualTime: new Date('2026-10-12T18:00:00+05:30'), doseAmountNumeric: 500, voidedAt: null },
    ];
    const result = checkPrnEligibility({
      order: { prnMinIntervalHours: 4, prnMaxDailyDoses: 3 },
      history,
      requestedAt: new Date('2026-10-12T23:00:00+05:30'),
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Daily limit reached');
  });

  it('enforces maximum daily cumulative substance quantity', () => {
    const history = [
      { actualTime: new Date('2026-10-12T08:30:00+05:30'), doseAmountNumeric: 1000, voidedAt: null },
      { actualTime: new Date('2026-10-12T14:00:00+05:30'), doseAmountNumeric: 1000, voidedAt: null },
    ];
    const result = checkPrnEligibility({
      order: { prnMinIntervalHours: 4, prnMaxDailyDoses: 6, prnMaxDailyQuantity: 2500, prnMaxDailyUnit: 'mg' },
      history,
      requestedAt: new Date('2026-10-12T20:00:00+05:30'),
      proposedDoseAmount: 1000, // 2000 + 1000 = 3000 > 2500
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Cumulative quantity limit exceeded');
  });

  it('excludes voided doses from cooldown and cumulative limits', () => {
    const history = [
      { actualTime: new Date('2026-10-12T09:00:00+05:30'), doseAmountNumeric: 1000, voidedAt: new Date('2026-10-12T09:10:00+05:30') },
    ];
    const result = checkPrnEligibility({
      order: { prnMinIntervalHours: 4, prnMaxDailyDoses: 2 },
      history,
      requestedAt: new Date('2026-10-12T10:00:00+05:30'),
    });

    expect(result.eligible).toBe(true);
  });
});
