import { cache } from 'react';
import { getAdmissionSummary } from '@/lib/services/ipd-census';

/**
 * One read of the admission per request, shared by the patient-file layout
 * (header, tabs) and whichever sheet page it wraps.
 */
export const loadAdmission = cache((hospitalId: string, admissionId: string) =>
  getAdmissionSummary(hospitalId, admissionId),
);
