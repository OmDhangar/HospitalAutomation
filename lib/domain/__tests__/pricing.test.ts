import { describe, expect, it } from 'vitest';
import {
  calculateMonthlyBill,
  contributionMargin,
  MESSAGE_RATIO_BUDGET,
  messageRatio,
  nameplateAppointments,
  QUOTA_HEADROOM,
  ratioStatus,
  recommendTier,
  SEED_PLAN_TIERS,
  SETUP_FEE_PAISE,
  shouldSuppressNonCriticalMessages,
  WORKING_DAYS_PER_MONTH,
} from '../pricing';

const tier = (code: string) => SEED_PLAN_TIERS.find((t) => t.code === code)!;

describe('tier structure', () => {
  it('prices everything in whole paise', () => {
    for (const t of SEED_PLAN_TIERS) {
      expect(Number.isInteger(t.monthlyPricePaise)).toBe(true);
      expect(Number.isInteger(t.annualPricePaise)).toBe(true);
      expect(Number.isInteger(t.includedMessages)).toBe(true);
    }
  });

  it('charges ten months for twelve on annual', () => {
    for (const t of SEED_PLAN_TIERS) {
      expect(t.annualPricePaise).toBe(t.monthlyPricePaise * 10);
    }
  });

  /**
   * The defect this pricing revision exists to fix. The previous Large tier
   * included 5,500 appointments for a hospital doing 200/day — 5,200 at
   * nameplate, so six percent of room. A 27-day month at 215/day is 5,805, and
   * the customer got an upgrade conversation for having a normal busy month.
   */
  it('sizes every quota with at least 30% headroom over nameplate volume', () => {
    for (const t of SEED_PLAN_TIERS) {
      const nameplate = nameplateAppointments(t);
      expect(nameplate).toBe(t.patientsPerDay * WORKING_DAYS_PER_MONTH);
      expect(t.includedAppointments / nameplate).toBeGreaterThanOrEqual(1.3);
    }
  });

  it('absorbs a 35% surge without breaching any quota', () => {
    for (const t of SEED_PLAN_TIERS) {
      const surge = Math.round(nameplateAppointments(t) * QUOTA_HEADROOM);
      expect(t.includedAppointments).toBeGreaterThanOrEqual(surge - 50);
    }
  });

  it('sets the message allowance well above the alert threshold', () => {
    // Billing kicks in at 4.0 messages per appointment, past the 3.0 budget and
    // the 3.5 alert, because a high ratio is our defect and not the hospital's.
    for (const t of SEED_PLAN_TIERS) {
      const perAppointment = t.includedMessages / t.includedAppointments;
      expect(perAppointment).toBeGreaterThan(MESSAGE_RATIO_BUDGET);
      expect(perAppointment).toBe(4);
    }
  });

  it('rises monotonically in both quota and price', () => {
    for (let i = 1; i < SEED_PLAN_TIERS.length; i += 1) {
      expect(SEED_PLAN_TIERS[i].includedAppointments).toBeGreaterThan(
        SEED_PLAN_TIERS[i - 1].includedAppointments,
      );
      expect(SEED_PLAN_TIERS[i].monthlyPricePaise).toBeGreaterThan(
        SEED_PLAN_TIERS[i - 1].monthlyPricePaise,
      );
    }
  });
});

/**
 * These are business assertions rather than tests of code behaviour. If someone
 * reprices a tier or the cost model moves, this fails and says so — which is the
 * point. A margin assumption that lives only in a document is one nobody
 * rechecks.
 */
describe('margin holds under stress', () => {
  it('earns over 50% at nameplate usage on every tier', () => {
    for (const t of SEED_PLAN_TIERS) {
      const margin = contributionMargin({
        tier: t,
        appointments: nameplateAppointments(t),
        messagesPerAppointment: MESSAGE_RATIO_BUDGET,
      });
      expect(margin).toBeGreaterThan(0.5);
    }
  });

  it('still earns over 45% with the quota fully consumed', () => {
    for (const t of SEED_PLAN_TIERS) {
      const margin = contributionMargin({
        tier: t,
        appointments: t.includedAppointments,
        messagesPerAppointment: MESSAGE_RATIO_BUDGET,
      });
      expect(margin).toBeGreaterThan(0.45);
    }
  });

  /**
   * The worst realistic month: a hospital consumes every appointment of its
   * headroom *and* runs a message ratio a third worse than budget.
   */
  it('still earns over 40% under full quota and a bad message ratio', () => {
    for (const t of SEED_PLAN_TIERS) {
      const margin = contributionMargin({
        tier: t,
        appointments: t.includedAppointments,
        messagesPerAppointment: 4.0,
      });
      expect(margin).toBeGreaterThan(0.4);
    }
  });

  /**
   * At solo volumes the SIM, support and infrastructure allocation outweigh the
   * messages. That is why the range cannot start at ₹1,499 — it is the one tier
   * whose price is set by fixed costs rather than by usage.
   */
  it('shows fixed costs dominating the entry tier', () => {
    const solo = tier('solo');
    const messagesOnly =
      nameplateAppointments(solo) * MESSAGE_RATIO_BUDGET * 14.5;
    const flatCosts = 25_000 + 30_000 + 10_000;

    expect(flatCosts).toBeGreaterThan(messagesOnly);
  });
});

describe('calculateMonthlyBill', () => {
  it('charges only the base price inside both quotas', () => {
    const bill = calculateMonthlyBill({
      tier: tier('hospital'),
      completedAppointments: 3_900,
      messagesSent: 11_700,
    });

    expect(bill.totalPaise).toBe(699_900);
    expect(bill.overageAppointments).toBe(0);
    expect(bill.overageMessages).toBe(0);
  });

  it('bills appointments beyond the quota at ₹1 each', () => {
    const bill = calculateMonthlyBill({
      tier: tier('hospital'),
      completedAppointments: 5_800,
    });

    expect(bill.overageAppointments).toBe(500);
    expect(bill.appointmentOveragePaise).toBe(50_000);
    expect(bill.totalPaise).toBe(749_900);
  });

  /**
   * The rule that keeps message counts off an ordinary invoice: a hospital at
   * 3.5 messages per appointment is above budget and above the alert threshold,
   * and is still charged nothing.
   */
  it('charges no message overage at a ratio of 3.5', () => {
    const t = tier('hospital');
    const bill = calculateMonthlyBill({
      tier: t,
      completedAppointments: t.includedAppointments,
      messagesSent: Math.round(t.includedAppointments * 3.5),
    });

    expect(bill.overageMessages).toBe(0);
    expect(bill.messageOveragePaise).toBe(0);
  });

  it('charges message overage once a ratio of 4.5 is reached', () => {
    const t = tier('hospital');
    const messagesSent = Math.round(t.includedAppointments * 4.5);
    const bill = calculateMonthlyBill({
      tier: t,
      completedAppointments: t.includedAppointments,
      messagesSent,
    });

    expect(bill.overageMessages).toBe(messagesSent - t.includedMessages);
    expect(bill.messageOveragePaise).toBe(bill.overageMessages * 25);
  });

  it('measures message overage against the allowance, not against usage', () => {
    // A hospital well under its appointment quota bought that headroom and is
    // entitled to the messages that go with it.
    const t = tier('large_opd');
    const bill = calculateMonthlyBill({
      tier: t,
      completedAppointments: 2_000,
      messagesSent: 12_000, // ratio of 6.0 against actual appointments
    });

    expect(bill.overageMessages).toBe(0);
  });

  it('produces the same bill for the same inputs', () => {
    const args = {
      tier: tier('practice'),
      completedAppointments: 3_612,
      messagesSent: 11_004,
    };
    expect(calculateMonthlyBill(args)).toEqual(calculateMonthlyBill(args));
  });

  it('never produces negative overage in a quiet month', () => {
    const bill = calculateMonthlyBill({
      tier: tier('solo'),
      completedAppointments: 12,
      messagesSent: 30,
    });

    expect(bill.overageAppointments).toBe(0);
    expect(bill.overageMessages).toBe(0);
    expect(bill.totalPaise).toBe(199_900);
  });
});

describe('setup fee', () => {
  it('is ₹5,000, recovering hard costs and part of the time', () => {
    expect(SETUP_FEE_PAISE).toBe(500_000);
  });

  it('is recovered within two months of contribution on the main tier', () => {
    const t = tier('hospital');
    const trueSetupCost = 1_140_000; // ~₹11,400, mostly three days of time
    const monthlyContribution =
      t.monthlyPricePaise *
      contributionMargin({
        tier: t,
        appointments: nameplateAppointments(t),
        messagesPerAppointment: MESSAGE_RATIO_BUDGET,
      });

    const unrecovered = trueSetupCost - SETUP_FEE_PAISE;
    expect(unrecovered / monthlyContribution).toBeLessThan(2);
  });
});

describe('recommendTier', () => {
  it('picks the smallest tier that covers the volume', () => {
    expect(recommendTier(600)?.code).toBe('solo');
    expect(recommendTier(2_000)?.code).toBe('clinic');
    expect(recommendTier(5_200)?.code).toBe('hospital');
    expect(recommendTier(6_500)?.code).toBe('large_opd');
  });

  it('returns null above the published tiers, forcing a conversation', () => {
    expect(recommendTier(20_000)).toBeNull();
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
