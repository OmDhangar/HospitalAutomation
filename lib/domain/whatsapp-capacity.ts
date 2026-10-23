/**
 * Meta WhatsApp Business Account Messaging Tiers and Capacity Calculations.
 *
 * Meta enforces a rolling 24-hour limit on unique business-initiated conversations
 * per phone number (WABA Phone Number ID).
 *
 * Tier limits:
 * - TIER_250: 250 unique business-initiated recipients per 24 rolling hours.
 * - TIER_1K: 1,000 unique business-initiated recipients per 24 rolling hours.
 * - TIER_10K: 10,000 unique business-initiated recipients per 24 rolling hours.
 * - TIER_100K: 100,000 unique business-initiated recipients per 24 rolling hours.
 * - TIER_UNLIMITED: Unlimited (practically capped to safe integer).
 */

export const DEFAULT_SAFETY_BUFFER = 10;
export const APPLICATION_CAMPAIGN_CAP = 250;

export const TIER_LIMITS: Record<string, number> = {
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: 1_000_000,
};

export function resolveTierLimit(tier: string | null | undefined): number {
  if (!tier) return 250;
  const upper = tier.trim().toUpperCase();
  return TIER_LIMITS[upper] ?? 250;
}

export type CapacityCalculationInput = {
  tierLimit: number;
  consumedLast24h: number;
  activeReservations: number;
  safetyBuffer?: number;
  applicationCap?: number;
};

export type CapacityCalculationResult = {
  tierLimit: number;
  consumedLast24h: number;
  activeReservations: number;
  safetyBuffer: number;
  totalCommitted: number;
  availableCapacity: number;
  effectiveCampaignCap: number;
};

export function calculateAvailableAccountCapacity(
  input: CapacityCalculationInput,
): CapacityCalculationResult {
  const safetyBuffer = input.safetyBuffer ?? DEFAULT_SAFETY_BUFFER;
  const appCap = input.applicationCap ?? APPLICATION_CAMPAIGN_CAP;

  const totalCommitted =
    Math.max(0, input.consumedLast24h) +
    Math.max(0, input.activeReservations) +
    Math.max(0, safetyBuffer);

  const availableCapacity = Math.max(0, input.tierLimit - totalCommitted);
  const effectiveCampaignCap = Math.max(0, Math.min(appCap, availableCapacity));

  return {
    tierLimit: input.tierLimit,
    consumedLast24h: Math.max(0, input.consumedLast24h),
    activeReservations: Math.max(0, input.activeReservations),
    safetyBuffer: Math.max(0, safetyBuffer),
    totalCommitted,
    availableCapacity,
    effectiveCampaignCap,
  };
}
