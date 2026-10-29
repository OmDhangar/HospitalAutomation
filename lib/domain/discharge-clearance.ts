import type { IpdDischargeClearanceRow, DischargeClearanceStatus } from '@/lib/db/schema';

export type { DischargeClearanceStatus };

/**
 * Pure domain evaluation function for computing clearance gate status across all 5 departments.
 * Free of database or Node.js dependencies, safe for both server and client execution.
 */
export function computeClearanceStatus(args: {
  clearance?: Partial<IpdDischargeClearanceRow> | null;
  isSummaryFinalized: boolean;
  isBillingSettled: boolean;
}): DischargeClearanceStatus {
  const c = args.clearance ?? {};

  const isMedicalCleared = Boolean(c.clinicalFitAt);
  const isPharmacyCleared = Boolean(c.pharmacyReturnedAt);
  const isNursingCleared = Boolean(
    c.nursingClearedAt && c.ivCannulaRemoved && c.belongingsAndReportsHandedOver,
  );
  const isSummaryFinalized = Boolean(args.isSummaryFinalized);
  const isBillingCleared = Boolean(args.isBillingSettled || c.billingClearedAt);

  const canIssueGatePass =
    isMedicalCleared &&
    isPharmacyCleared &&
    isNursingCleared &&
    isSummaryFinalized &&
    isBillingCleared;

  let completedCount = 0;
  if (isMedicalCleared) completedCount++;
  if (isPharmacyCleared) completedCount++;
  if (isNursingCleared) completedCount++;
  if (isSummaryFinalized) completedCount++;
  if (isBillingCleared) completedCount++;

  return {
    isMedicalCleared,
    isPharmacyCleared,
    isNursingCleared,
    isSummaryFinalized,
    isBillingCleared,
    canIssueGatePass,
    completedCount,
  };
}
