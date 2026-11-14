/**
 * Multi-Tier Tariff Rate Plan Domain Pricing Engine.
 *
 * Implements deterministic price resolution for hospital services:
 * 1. Specific item override (tariffPricePaise) takes absolute precedence.
 * 2. Rate plan general modifier (modifierBp, where 10000 bp = 100%).
 * 3. Base catalog price (basePricePaise).
 */

export interface TariffResolutionInput {
  basePricePaise: number | null;
  tariffPricePaise?: number | null;
  modifierBp?: number | null;
}

/**
 * Resolves the effective charge item unit price in paise based on the tariff hierarchy.
 * Returns null if the base price is null (item unpriced).
 */
export function resolveTariffPrice(input: TariffResolutionInput): number | null {
  if (input.basePricePaise === null) {
    return null;
  }

  // 1. Explicit item override takes absolute priority
  if (input.tariffPricePaise !== undefined && input.tariffPricePaise !== null) {
    return Math.max(0, input.tariffPricePaise);
  }

  // 2. Blanket plan modifier in basis points (+1000 bp = +10.00%, -1500 bp = -15.00%)
  if (input.modifierBp !== undefined && input.modifierBp !== null && input.modifierBp !== 0) {
    const factor = 10000 + input.modifierBp;
    return Math.max(0, Math.round((input.basePricePaise * factor) / 10000));
  }

  // 3. Fallback to base price
  return input.basePricePaise;
}
