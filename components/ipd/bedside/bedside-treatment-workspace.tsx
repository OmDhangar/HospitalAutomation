'use client';

/**
 * Bedside Treatment Workspace
 *
 * Unified bedside clinical workspace consolidating:
 * 1. eMAR scheduled and overdue dose administration
 * 2. PRN (SOS) medication administration with interval safety checks
 * 3. Bedside consumables and supply charging with offline support
 * 4. Active allergy review status
 * 5. TPR chart access
 */

import {
  BedsideTreatmentChart,
  type BedsideTreatmentChartProps,
  type Pick,
  formatRoutePlain,
  formatSlotTime,
} from './bedside-treatment-chart';

export type BedsideTreatmentWorkspaceProps = BedsideTreatmentChartProps;

export function BedsideTreatmentWorkspace(props: BedsideTreatmentWorkspaceProps) {
  return <BedsideTreatmentChart {...props} />;
}

export {
  BedsideTreatmentChart,
  BedsideTreatmentChart as MedicationChart,
  formatRoutePlain,
  formatSlotTime,
};
export type { Pick };
