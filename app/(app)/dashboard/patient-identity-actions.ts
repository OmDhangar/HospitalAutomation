'use server';

import { requireSession, requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import {
  checkPatientMergeCriticality,
  executePatientMerge,
  findPatientDuplicates,
  listPatientMergeAlerts,
  reviewPatientMergeAlert,
  type MergeCriticalityResult,
  type PatientDuplicateMatch,
} from '@/lib/services/patient-merge';

/**
 * Searches for duplicate or family patient profiles in the hospital by phone and/or name.
 */
export async function findPatientDuplicatesDynamic(criteria: {
  phone?: string | null;
  name?: string | null;
  age?: number | null;
  gender?: string | null;
}): Promise<
  | { ok: true; matches: PatientDuplicateMatch[] }
  | { ok: false; error: string }
> {
  try {
    const session = await requireSession();
    const matches = await findPatientDuplicates(session.hospitalId, criteria);
    return { ok: true, matches };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to search for duplicates' };
  }
}

/**
 * Evaluates whether merging two patients is classified as a critical merge.
 */
export async function checkMergeCriticalityDynamic(args: {
  fromPatientId: string;
  toPatientId: string;
}): Promise<
  | ({ ok: true } & MergeCriticalityResult)
  | { ok: false; error: string }
> {
  try {
    const session = await requireSession();
    if (!can(session.role, 'patients.merge_records')) {
      return { ok: false, error: 'You do not have permission to merge patient records' };
    }
    const result = await checkPatientMergeCriticality(session.hospitalId, args.fromPatientId, args.toPatientId);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to check merge criticality' };
  }
}

/**
 * Executes a patient merge. If critical, records an alert for executive administration.
 */
export async function mergePatientsDynamic(args: {
  fromPatientId: string;
  toPatientId: string;
  justification?: string;
}): Promise<
  | { ok: true; survivorId: string; alertId?: string }
  | { ok: false; error: string }
> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'patients.merge_records')) {
      return { ok: false, error: 'You do not have permission to merge patient records' };
    }
    const result = await executePatientMerge(session.hospitalId, session.userId, session.role, args);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to merge patient records' };
  }
}

/**
 * Lists critical patient merge alerts for hospital owners/administrators.
 */
export async function listMergeAlertsDynamic(): Promise<
  | { ok: true; alerts: Awaited<ReturnType<typeof listPatientMergeAlerts>> }
  | { ok: false; error: string }
> {
  try {
    const session = await requireSession();
    if (session.role !== 'owner') {
      return { ok: false, error: 'Only hospital administrators can view merge alerts' };
    }
    const alerts = await listPatientMergeAlerts(session.hospitalId);
    return { ok: true, alerts };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to list merge alerts' };
  }
}

/**
 * Marks a patient merge alert as reviewed.
 */
export async function reviewMergeAlertDynamic(args: { alertId: string }): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  try {
    const session = await requireWritableSession();
    if (session.role !== 'owner') {
      return { ok: false, error: 'Only hospital administrators can review merge alerts' };
    }
    await reviewPatientMergeAlert(session.hospitalId, session.userId, args.alertId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to review merge alert' };
  }
}
