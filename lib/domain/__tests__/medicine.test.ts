import { describe, expect, it } from 'vitest';
import { escapeLikePattern, medicineLabel, parseMedicineInput } from '../medicine';
import { parsePercentToBasisPoints } from '../patient-billing';
import { STARTER_MEDICINES } from '../starter-medicines';

describe('parseMedicineInput', () => {
  it('tidies spacing so the same medicine meets the same unique index', () => {
    const result = parseMedicineInput({ name: '  Paracetamol ', strength: '500   mg', form: ' tablet' });
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Paracetamol',
        genericName: null,
        strength: '500 mg',
        form: 'tablet',
        unit: 'unit',
        sellingPricePaise: null,
        taxRateBp: 0,
      },
    });
  });

  it('treats blank optional fields as absent, not as empty text', () => {
    const result = parseMedicineInput({ name: 'ORS', strength: '  ', form: '', unit: '' });
    expect(result.ok && result.value.strength).toBeNull();
    expect(result.ok && result.value.unit).toBe('unit');
  });

  it('allows a medicine with no price yet', () => {
    const result = parseMedicineInput({ name: 'Paracetamol', sellingPricePaise: null });
    expect(result.ok && result.value.sellingPricePaise).toBeNull();
  });

  it('refuses a missing name, a negative price and an impossible tax rate', () => {
    expect(parseMedicineInput({ name: '   ' }).ok).toBe(false);
    expect(parseMedicineInput({ name: 'X', sellingPricePaise: -1 }).ok).toBe(false);
    expect(parseMedicineInput({ name: 'X', sellingPricePaise: 2.5 }).ok).toBe(false);
    expect(parseMedicineInput({ name: 'X', taxRateBp: 10_001 }).ok).toBe(false);
  });
});

describe('medicineLabel', () => {
  it('reads the way a doctor says it', () => {
    expect(medicineLabel({ name: 'Paracetamol', strength: '500 mg', form: 'tablet' })).toBe(
      'Paracetamol 500 mg tablet',
    );
    expect(medicineLabel({ name: 'ORS', strength: null, form: 'sachet' })).toBe('ORS sachet');
  });
});

describe('escapeLikePattern', () => {
  it('makes wildcards literal', () => {
    expect(escapeLikePattern('50%_x\\')).toBe('50\\%\\_x\\\\');
  });
});

describe('parsePercentToBasisPoints', () => {
  it.each([
    ['12', 1_200],
    ['2.5', 250],
    ['18%', 1_800],
    ['0', 0],
  ])('reads %s as %i basis points', (input, bp) => {
    expect(parsePercentToBasisPoints(input)).toBe(bp);
  });

  it.each(['101', '-5', 'twelve', '1.234'])('rejects %s', (input) => {
    expect(parsePercentToBasisPoints(input)).toBeNull();
  });
});

describe('STARTER_MEDICINES', () => {
  it('passes the same validation as a medicine typed by hand', () => {
    for (const item of STARTER_MEDICINES) {
      expect(parseMedicineInput(item).ok, `${item.name} ${item.strength ?? ''}`).toBe(true);
    }
  });

  it('never lists the same medicine twice, or the seed would fail on the unique index', () => {
    const keys = STARTER_MEDICINES.map((m) =>
      [m.name, m.strength ?? '', m.form].map((part) => part.toLowerCase()).join('|'),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
