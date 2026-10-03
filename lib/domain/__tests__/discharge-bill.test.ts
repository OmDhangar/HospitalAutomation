import { describe, expect, it } from 'vitest';
import {
  buildBillLinkToken,
  dischargeFlags,
  fiscalYearOf,
  formatBillNumber,
  isBillLinkLive,
  parseBillLinkToken,
  payerSplit,
} from '../discharge-bill';

const TZ = 'Asia/Kolkata';

describe('fiscalYearOf', () => {
  it('runs April to March, in the hospital’s timezone', () => {
    expect(fiscalYearOf(new Date('2026-10-20T10:00:00Z'), TZ)).toBe('2026-27');
    expect(fiscalYearOf(new Date('2027-03-31T10:00:00Z'), TZ)).toBe('2026-27');
    // 23:00 UTC on 31 March is already 1 April in India.
    expect(fiscalYearOf(new Date('2027-03-31T23:00:00Z'), TZ)).toBe('2027-28');
    expect(fiscalYearOf(new Date('2099-06-01T00:00:00Z'), TZ)).toBe('2099-00');
  });
});

describe('formatBillNumber', () => {
  it('pads to four digits', () => {
    expect(formatBillNumber('IPD', '2026-27', 7)).toBe('IPD/2026-27/0007');
    expect(formatBillNumber('IPD', '2026-27', 12345)).toBe('IPD/2026-27/12345');
  });
});

describe('dischargeFlags', () => {
  const at = (time: string) => new Date(`2026-10-20T${time}:00+05:30`);
  const entry = (id: string, itemKey: string, time: string, extra: Partial<{ recordedAt: Date; unpriced: boolean }> = {}) => ({
    id,
    itemKey,
    description: id,
    occurredAt: at(time),
    recordedAt: extra.recordedAt ?? at(time),
    unpriced: extra.unpriced ?? false,
  });

  it('flags unpriced items, repeats within 15 minutes, and entries recorded late', () => {
    const flags = dischargeFlags([
      entry('a', 'charge:1', '10:00'),
      entry('b', 'charge:1', '10:10'),
      entry('c', 'charge:1', '11:00'),
      entry('d', 'charge:2', '09:00', { unpriced: true }),
      entry('e', 'charge:3', '01:00', { recordedAt: at('08:00') }),
    ]);
    expect(flags.unpriced.map((f) => f.id)).toEqual(['d']);
    expect(flags.possibleDuplicates.map((f) => f.id)).toEqual(['b']);
    expect(flags.lateRecordings.map((f) => f.id)).toEqual(['e']);
  });
});

describe('payerSplit', () => {
  it('lets the payer cover up to its approved amount, the patient the rest', () => {
    expect(payerSplit({ totalPaise: 50_000_00, paidPaise: 5_000_00, approvedAmountPaise: 30_000_00 })).toEqual({
      totalPaise: 50_000_00,
      payerSharePaise: 30_000_00,
      patientSharePaise: 20_000_00,
      paidPaise: 5_000_00,
      balancePaise: 15_000_00,
    });
  });

  it('caps the payer at the bill and shows a refund as a negative balance', () => {
    const split = payerSplit({ totalPaise: 10_000_00, paidPaise: 2_000_00, approvedAmountPaise: 25_000_00 });
    expect(split.payerSharePaise).toBe(10_000_00);
    expect(split.balancePaise).toBe(-2_000_00);
  });

  it('treats self-pay as no payer share', () => {
    expect(payerSplit({ totalPaise: 100, paidPaise: 0, approvedAmountPaise: null }).patientSharePaise).toBe(100);
  });
});

describe('bill link tokens', () => {
  const hospital = '6f1c9a3e-2b7d-4e8a-9c21-7d4e5f6a8b90';
  const random = 'AbCdEfGhIjKlMnOpQrStUv';
  it('round-trips the hospital and the random part', () => {
    const token = buildBillLinkToken(hospital, random);
    expect(parseBillLinkToken(token)).toEqual({ hospitalId: hospital, random });
  });
  it('refuses anything malformed', () => {
    expect(parseBillLinkToken('nope')).toBeNull();
    expect(parseBillLinkToken(`${'g'.repeat(32)}${random}`)).toBeNull();
  });
  it('is live until revoked or expired', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    expect(isBillLinkLive({ expiresAt: null, revokedAt: null, now })).toBe(true);
    expect(isBillLinkLive({ expiresAt: new Date('2026-10-19T00:00:00Z'), revokedAt: null, now })).toBe(false);
    expect(isBillLinkLive({ expiresAt: null, revokedAt: now, now })).toBe(false);
  });
});
