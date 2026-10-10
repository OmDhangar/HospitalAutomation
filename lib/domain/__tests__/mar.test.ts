import { describe, expect, it } from 'vitest';
import {
  BED_CODE_ALPHABET,
  MarError,
  bedCodeFromQr,
  bedQrPayload,
  checkGive,
  needsWitness,
  newBedCode,
  normaliseBedCode,
  notGivenRefusal,
  orderStatus,
  parseOrder,
} from '../mar';

const now = new Date('2026-10-12T10:00:00+05:30');
const base = {
  stage: 'observe' as const,
  risk: null,
  route: 'iv' as const,
  channel: 'personal' as const,
  order: { transcribed: false, countersignedAt: null },
  hasPresenceProof: false,
  witnessUserId: null,
  occurredAt: now,
  now,
};
const ndps = { kind: 'ndps' as const, witnessAtGive: false };

describe('treatment lines', () => {
  it('needs dose, route and frequency for a medicine, and words for an instruction', () => {
    expect(parseOrder({ kind: 'medicine', medicineId: crypto.randomUUID(), dose: ' 1  g ', route: 'iv', frequency: 'BD' })).toMatchObject({ dose: '1 g', route: 'iv' });
    expect(() => parseOrder({ kind: 'medicine', medicineId: crypto.randomUUID(), dose: '', route: 'iv', frequency: 'BD' })).toThrow(/dose/);
    expect(() => parseOrder({ kind: 'medicine', medicineId: crypto.randomUUID(), dose: '1 g', route: 'nasal', frequency: 'BD' })).toThrow(/route/);
    expect(() => parseOrder({ kind: 'medicine', medicineId: 'x', dose: '1 g', route: 'iv', frequency: 'BD' })).toThrow(MarError);
    expect(parseOrder({ kind: 'instruction', description: 'Keep head end raised' })).toEqual({ kind: 'instruction', description: 'Keep head end raised' });
  });

  it('reads as active, waiting for countersign, stopped or struck out', () => {
    const line = { transcribed: true, countersignedAt: null, stoppedAt: null, voidedAt: null };
    expect(orderStatus(line)).toBe('awaiting_countersign');
    expect(orderStatus({ ...line, countersignedAt: now })).toBe('active');
    expect(orderStatus({ ...line, stoppedAt: now })).toBe('stopped');
    expect(orderStatus({ ...line, stoppedAt: now, voidedAt: now })).toBe('struck_out');
  });
});

describe('who needs a witness (D-WITNESS)', () => {
  it('is NDPS always, IV psychotropics, and any class the hospital marks', () => {
    expect(needsWitness(null, 'iv')).toBe(false);
    expect(needsWitness(ndps, 'oral')).toBe(true);
    expect(needsWitness({ kind: 'psychotropic', witnessAtGive: false }, 'iv')).toBe(true);
    expect(needsWitness({ kind: 'psychotropic', witnessAtGive: false }, 'oral')).toBe(false);
    expect(needsWitness({ kind: 'high_value', witnessAtGive: true }, 'oral')).toBe(true);
  });
});

describe('the give rules', () => {
  it('lets an ordinary medicine through with no controls', () => {
    expect(checkGive(base)).toEqual({ refusal: null, flags: [], witness: 'not_needed', needsLateReason: false });
  });

  it('holds the time rules at every stage', () => {
    expect(checkGive({ ...base, occurredAt: new Date(now.getTime() + 10 * 60_000) }).refusal).toMatch(/future/);
    expect(checkGive({ ...base, occurredAt: new Date(now.getTime() - 49 * 3_600_000) }).refusal).toMatch(/48 hours/);
    expect(checkGive({ ...base, occurredAt: new Date(now.getTime() - 3 * 3_600_000) })).toMatchObject({ needsLateReason: true, flags: ['late_entry'] });
  });

  it('flags what a risk-class give is missing in observe and warn', () => {
    for (const stage of ['observe', 'warn'] as const) {
      const check = checkGive({ ...base, stage, risk: ndps, order: { transcribed: true, countersignedAt: null } });
      expect(check.refusal).toBeNull();
      expect(check.witness).toBe('skipped');
      expect(check.flags).toEqual(['uncountersigned_order', 'no_presence', 'no_witness']);
    }
  });

  it('refuses each missing control in enforce, in order', () => {
    const enforce = { ...base, stage: 'enforce' as const, risk: ndps };
    expect(checkGive({ ...enforce, order: { transcribed: true, countersignedAt: null } }).refusal).toMatch(/countersign/);
    expect(checkGive(enforce).refusal).toMatch(/code on the patient’s bed/);
    expect(checkGive({ ...enforce, hasPresenceProof: true }).refusal).toMatch(/witness/);
    expect(checkGive({ ...enforce, hasPresenceProof: true, witnessUserId: 'w' })).toMatchObject({ refusal: null, witness: 'approval', flags: [] });
  });

  it('on the ward tablet needs no bed code, and the witness takes the tablet', () => {
    expect(checkGive({ ...base, stage: 'enforce', risk: ndps, channel: 'ward_device' })).toMatchObject({ refusal: null, witness: 'ward_device', flags: [] });
  });
});

describe('not given', () => {
  it('wants the reason in words only for "other"', () => {
    expect(notGivenRefusal('other', null)).toMatch(/why/);
    expect(notGivenRefusal('refused', null)).toBeNull();
  });
});

describe('bed codes', () => {
  it('are six unambiguous letters and numbers, typed any way', () => {
    const code = newBedCode();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect([...BED_CODE_ALPHABET].some((c) => 'OIL01'.includes(c))).toBe(false);
    expect(normaliseBedCode('ab3-k7m')).toBe('AB3K7M');
    expect(normaliseBedCode('AB0K7M')).toBeNull();
    expect(normaliseBedCode('ABCDE')).toBeNull();
  });

  it('round-trip through the QR on the label, and anything else scanned is ignored', () => {
    expect(bedCodeFromQr(bedQrPayload('ZXB3N2'))).toBe('ZXB3N2');
    expect(bedCodeFromQr('https://example.com/ZXB3N2')).toBeNull();
    expect(bedCodeFromQr('QB1:ZXB0N2')).toBeNull();
  });
});
