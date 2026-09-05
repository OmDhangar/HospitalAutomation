import { describe, expect, it } from 'vitest';
import {
  calculateMonthlyBill,
  MESSAGE_RATIO_BUDGET,
  messageRatio,
  ratioStatus,
  recommendTier,
  SEED_PLAN_TIERS,
  shouldSuppressNonCriticalMessages,
} from '../pricing';

const tier = (code: string) => SEED_PLAN_TIERS.find((t) => t.code === code)!;

describe('plan tiers', () => {
  it('prices every tier in whole paise', () => {
    for (const t of SEED_PLAN_TIERS) {
      expect(Number.isInteger(t.monthlyPricePaise)).toBe(true);
    }
  });

  it('holds contribution margin above 55% at every tier under the 3-message budget', () => {
    // ~Rs 0.145 per WhatsApp message, plus a flat platform allocation per tenant.
    const paisePerMessage = 14.5;
    const platformAllocationPaise: Record<string, number> = {
      clinic: 25_000,
      small: 35_000,
      standard: 45_000,
      large: 60_000,
      multi_branch: 80_000,
    };

    for (const t of SEED_PLAN_TIERS) {
      const messagingCost =
        t.includedAppointments * MESSAGE_RATIO_BUDGET * paisePerMessage;
      const cost = messagingCost + platformAllocationPaise[t.code];
      const margin = (t.monthlyPricePaise - cost) / t.monthlyPricePaise;
      expect(margin).toBeGreaterThan(0.55);
    }
  });
});

describe('calculateMonthlyBill', () => {
  it('charges the base price when inside the quota', () => {
    const bill = calculateMonthlyBill({
      tier: tier('large'),
      completedAppointments: 5_200,
    });
    expect(bill.totalPaise).toBe(699_900);
    expect(bill.overageAppointments).toBe(0);
  });

  it('reports overage volume but bills nothing for it by default', () => {
    const bill = calculateMonthlyBill({
      tier: tier('large'),
      completedAppointments: 6_000,
    });
    expect(bill.overageAppointments).toBe(500);
    expect(bill.overagePaise).toBe(0);
    expect(bill.totalPaise).toBe(699_900);
  });

  it('bills overage deterministically once a rate is configured', () => {
    const bill = calculateMonthlyBill({
      tier: tier('large'),
      completedAppointments: 6_000,
      overagePaisePerAppointment: 75,
    });
    expect(bill.overagePaise).toBe(37_500);
    expect(bill.totalPaise).toBe(737_400);
  });

  it('produces the same bill for the same inputs', () => {
    const args = { tier: tier('standard'), completedAppointments: 3_612 };
    expect(calculateMonthlyBill(args)).toEqual(calculateMonthlyBill(args));
  });

  it('never produces negative overage for a quiet month', () => {
    const bill = calculateMonthlyBill({
      tier: tier('clinic'),
      completedAppointments: 12,
    });
    expect(bill.overageAppointments).toBe(0);
    expect(bill.totalPaise).toBe(149_900);
  });
});

describe('recommendTier', () => {
  it('picks the smallest tier that covers the volume', () => {
    expect(recommendTier(600)?.code).toBe('clinic');
    expect(recommendTier(2_100)?.code).toBe('standard');
    expect(recommendTier(5_200)?.code).toBe('large');
  });

  it('returns null above the published tiers, forcing an enterprise conversation', () => {
    expect(recommendTier(15_000)).toBeNull();
  });
});

describe('message ratio', () => {
  it('is messages per completed appointment', () => {
    expect(messageRatio({ messagesSent: 15_600, completedAppointments: 5_200 })).toBe(3);
  });

  it('is unknown rather than infinite when nothing has completed', () => {
    expect(messageRatio({ messagesSent: 40, completedAppointments: 0 })).toBeNull();
    expect(ratioStatus(null)).toBe('unknown');
  });

  it('classifies against the budget, alert and breach thresholds', () => {
    expect(ratioStatus(2.9)).toBe('ok');
    expect(ratioStatus(3.5)).toBe('alert');
    expect(ratioStatus(6.0)).toBe('breach');
  });

  it('suppresses non-critical messages only once the breach threshold is hit', () => {
    expect(shouldSuppressNonCriticalMessages(3.9)).toBe(false);
    expect(shouldSuppressNonCriticalMessages(6.1)).toBe(true);
    expect(shouldSuppressNonCriticalMessages(null)).toBe(false);
  });
});
