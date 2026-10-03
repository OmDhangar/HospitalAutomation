import { describe, expect, it } from 'vitest';
import { parseDepositRupees, parsePayerInput } from '../payer';

describe('parsePayerInput', () => {
  it('defaults to self and ignores the other fields for self', () => {
    expect(parsePayerInput({})).toEqual({
      ok: true,
      value: { kind: 'self', payerName: null, policyNumber: null, preauthAmountPaise: null },
    });
    expect(parsePayerInput({ kind: 'self', payerName: 'Star Health' })).toMatchObject({
      ok: true,
      value: { payerName: null },
    });
  });

  it('needs a name for an insurer, TPA or company', () => {
    expect(parsePayerInput({ kind: 'insurer' }).ok).toBe(false);
    expect(parsePayerInput({ kind: 'insurer', payerName: '  Star   Health ', preauthRupees: '25,000' })).toEqual({
      ok: true,
      value: { kind: 'insurer', payerName: 'Star Health', policyNumber: null, preauthAmountPaise: 2_500_000 },
    });
  });

  it('refuses an unknown kind or an unreadable amount', () => {
    expect(parsePayerInput({ kind: 'government' }).ok).toBe(false);
    expect(parsePayerInput({ kind: 'tpa', payerName: 'MD India', preauthRupees: 'lots' }).ok).toBe(false);
  });
});

describe('parseDepositRupees', () => {
  it('reads blank as no deposit, and a positive amount in paise', () => {
    expect(parseDepositRupees('')).toEqual({ ok: true, value: null });
    expect(parseDepositRupees('5,000')).toEqual({ ok: true, value: 500_000 });
  });

  it('refuses zero or nonsense', () => {
    expect(parseDepositRupees('0').ok).toBe(false);
    expect(parseDepositRupees('five').ok).toBe(false);
  });
});
