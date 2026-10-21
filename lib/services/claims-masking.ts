import type { StaffRole } from '@/lib/domain/permissions';

/**
 * Strips all monetary amount fields when a claim is accessed by a nurse.
 * Nurses see operational status, timeline, and document requirements, but no financials.
 */
const FINANCIAL_KEYS: readonly string[] = [
  'preauthAmountPaise',
  'approvedAmountPaise',
  'enhancementAmountPaise',
  'claimedAmountPaise',
  'settledAmountPaise',
  'deductionAmountPaise',
  'coPayAmountPaise',
  'estimatedCostPaise',
  'amountPaise',
];

export function maskClaimFinancialsForRole<T extends Record<string, any>>(
  claim: T,
  role: StaffRole
): T {
  if (role !== 'nurse') {
    return claim;
  }

  const masked = { ...claim } as Record<string, any>;
  for (const key of FINANCIAL_KEYS) {
    if (key in masked) {
      masked[key] = null;
    }
  }

  return masked as T;
}
