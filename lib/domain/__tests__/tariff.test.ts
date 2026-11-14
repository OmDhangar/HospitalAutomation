import { describe, expect, it } from 'vitest';
import { resolveTariffPrice } from '../tariff';

describe('resolveTariffPrice', () => {
  it('returns null when base price is null regardless of plan', () => {
    expect(resolveTariffPrice({ basePricePaise: null })).toBeNull();
    expect(resolveTariffPrice({ basePricePaise: null, modifierBp: 1000 })).toBeNull();
    expect(resolveTariffPrice({ basePricePaise: null, tariffPricePaise: 5000 })).toBeNull();
  });

  it('prefers explicit item tariff override over base price and modifier', () => {
    const result = resolveTariffPrice({
      basePricePaise: 10000,
      tariffPricePaise: 8500,
      modifierBp: 2000, // +20% modifier ignored due to explicit override
    });
    expect(result).toBe(8500);
  });

  it('allows zero tariff price override (complimentary service under plan)', () => {
    const result = resolveTariffPrice({
      basePricePaise: 5000,
      tariffPricePaise: 0,
      modifierBp: 1000,
    });
    expect(result).toBe(0);
  });

  it('applies positive basis points modifier (+10% corporate markup)', () => {
    // 50000 paise * 1.10 = 55000 paise
    const result = resolveTariffPrice({
      basePricePaise: 50000,
      modifierBp: 1000,
    });
    expect(result).toBe(55000);
  });

  it('applies negative basis points modifier (-15% CGHS discount)', () => {
    // 20000 paise * 0.85 = 17000 paise
    const result = resolveTariffPrice({
      basePricePaise: 20000,
      modifierBp: -1500,
    });
    expect(result).toBe(17000);
  });

  it('rounds odd paise deterministically using Math.round', () => {
    // 155 paise * 1.10 = 170.5 paise -> rounds to 171 paise
    const result = resolveTariffPrice({
      basePricePaise: 155,
      modifierBp: 1000,
    });
    expect(result).toBe(171);
  });

  it('clamps price to 0 when negative modifier is -100% or deeper', () => {
    const at100PercentDiscount = resolveTariffPrice({
      basePricePaise: 10000,
      modifierBp: -10000,
    });
    expect(at100PercentDiscount).toBe(0);

    const excessiveDiscount = resolveTariffPrice({
      basePricePaise: 10000,
      modifierBp: -15000,
    });
    expect(excessiveDiscount).toBe(0);
  });

  it('returns base price directly when modifier is zero or undefined and no override exists', () => {
    expect(resolveTariffPrice({ basePricePaise: 12500 })).toBe(12500);
    expect(resolveTariffPrice({ basePricePaise: 12500, modifierBp: 0 })).toBe(12500);
    expect(resolveTariffPrice({ basePricePaise: 12500, modifierBp: null })).toBe(12500);
  });
});
