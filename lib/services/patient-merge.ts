import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { admissions, bills, patientMergeAlerts, patientMerges, patients } from '@/lib/db/schema';
import {
  nameKey,
  scorePatientMatch,
  type MatchCandidate,
  type MatchTier,
} from '@/lib/domain/patient-match';
import { can } from '@/lib/domain/permissions';
import { resolveRow, type PatientRow } from './patients';

export type PatientDuplicateMatch = {
  patient: {
    id: string;
    name: string;
    phoneE164: string;
    age: number | null;
    gender: string | null;
    mrn: string | null;
    qid: string | null;
    address: string | null;
  };
  tier: MatchTier;
  score: number;
  reasons: string[];
  isFamilyPhone: boolean;
  isProbableDuplicate: boolean;
};

export type CriticalMergeReason =
  | 'active_ipd_admission'
  | 'unpaid_balance'
  | 'gender_conflict'
  | 'age_disparity_gt_5_years';

export type MergeCriticalityResult = {
  isCritical: boolean;
  reasons: CriticalMergeReason[];
  fromPatient: PatientRow;
  toPatient: PatientRow;
};

/**
 * Searches for potential duplicate or family patient profiles in the hospital by phone and/or name.
 */
export async function findPatientDuplicates(
  hospitalId: string,
  criteria: {
    phone?: string | null;
    name?: string | null;
    age?: number | null;
    gender?: string | null;
  },
  limit = 10,
): Promise<PatientDuplicateMatch[]> {
  const digits = (criteria.phone || '').replace(/\D/g, '');
  const typedName = (criteria.name || '').trim();
  const typedKey = nameKey(typedName);

  if (digits.length < 5 && typedKey.length < 2) {
    return [];
  }

  const typedCandidate: MatchCandidate = {
    nameKey: typedKey,
    birthYear: criteria.age ? new Date().getFullYear() - criteria.age : null,
    phoneE164: digits.length >= 10 ? `+91${digits.slice(-10)}` : null,
    gender: criteria.gender || null,
  };

  return withTenant(hospitalId, async (tx) => {
    // Search active rows matching phone or name prefix
    const rows = await tx
      .select({
        id: patients.id,
        name: patients.name,
        phoneE164: patients.phoneE164,
        age: patients.age,
        birthYear: patients.birthYear,
        gender: patients.gender,
        mrn: patients.mrn,
        qid: patients.qid,
        address: patients.address,
        nameKey: patients.nameKey,
        mergedIntoId: patients.mergedIntoId,
      })
      .from(patients)
      .where(
        and(
          eq(patients.hospitalId, hospitalId),
          isNull(patients.mergedIntoId),
          sql`(
            (${digits.length >= 5} AND ${patients.phoneE164} LIKE '%' || ${digits} || '%')
            OR (${typedKey.length >= 2} AND (
              coalesce(${patients.nameKey}, public.qurio_name_key(${patients.name})) LIKE ${typedKey} || '%'
              OR coalesce(${patients.nameKey}, public.qurio_name_key(${patients.name})) LIKE '% ' || ${typedKey} || '%'
            ))
          )`,
        ),
      )
      .orderBy(desc(patients.updatedAt))
      .limit(Math.min(limit * 2, 50));

    const matches: PatientDuplicateMatch[] = [];

    for (const row of rows) {
      const existingCandidate: MatchCandidate = {
        nameKey: row.nameKey || nameKey(row.name),
        birthYear: row.birthYear ?? (row.age ? new Date().getFullYear() - row.age : null),
        phoneE164: row.phoneE164,
        gender: row.gender,
      };

      const matchRes = scorePatientMatch(typedCandidate, existingCandidate);

      if (matchRes.tier !== 'none') {
        matches.push({
          patient: {
            id: row.id,
            name: row.name,
            phoneE164: row.phoneE164,
            age: row.age,
            gender: row.gender,
            mrn: row.mrn,
            qid: row.qid,
            address: row.address,
          },
          tier: matchRes.tier,
          score: matchRes.score,
          reasons: matchRes.reasons,
          isFamilyPhone: matchRes.isFamilyPhone,
          isProbableDuplicate: matchRes.isProbableDuplicate,
        });
      }
    }

    // Sort by match score descending
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
  });
}

/**
 * Checks whether merging fromPatient into toPatient constitutes a CRITICAL merge.
 */
export async function checkPatientMergeCriticality(
  hospitalId: string,
  fromPatientId: string,
  toPatientId: string,
): Promise<MergeCriticalityResult> {
  return withTenant(hospitalId, async (tx) => {
    const rows = await tx
      .select()
      .from(patients)
      .where(and(eq(patients.hospitalId, hospitalId), inArray(patients.id, [fromPatientId, toPatientId])));

    const fromPatient = rows.find((r) => r.id === fromPatientId);
    const toPatient = rows.find((r) => r.id === toPatientId);

    if (!fromPatient || !toPatient) {
      throw new Error('One or both patients not found in this hospital');
    }

    const reasons: CriticalMergeReason[] = [];

    // 1. Gender Mismatch
    if (fromPatient.gender && toPatient.gender && fromPatient.gender !== toPatient.gender) {
      reasons.push('gender_conflict');
    }

    // 2. Age Disparity > 5 years
    const birthYearFrom = fromPatient.birthYear ?? (fromPatient.age ? new Date().getFullYear() - fromPatient.age : null);
    const birthYearTo = toPatient.birthYear ?? (toPatient.age ? new Date().getFullYear() - toPatient.age : null);
    if (birthYearFrom != null && birthYearTo != null && Math.abs(birthYearFrom - birthYearTo) > 5) {
      reasons.push('age_disparity_gt_5_years');
    }

    // 3. Active IPD Admissions or Unpaid Invoices
    const [statusCheck] = await tx.execute<{
      has_active_admission: boolean;
      has_unpaid_bills: boolean;
    }>(sql`
      SELECT
        EXISTS (
          SELECT 1 FROM admissions a
           WHERE a.hospital_id = ${hospitalId}::uuid
             AND a.patient_id IN (${fromPatientId}::uuid, ${toPatientId}::uuid)
             AND a.status = 'admitted'
        ) AS has_active_admission,
        EXISTS (
          SELECT 1 FROM bills b
           WHERE b.hospital_id = ${hospitalId}::uuid
             AND b.patient_id IN (${fromPatientId}::uuid, ${toPatientId}::uuid)
             AND b.status IN ('pending', 'partially_paid')
        ) AS has_unpaid_bills
    `);

    if (statusCheck?.has_active_admission) {
      reasons.push('active_ipd_admission');
    }
    if (statusCheck?.has_unpaid_bills) {
      reasons.push('unpaid_balance');
    }

    return {
      isCritical: reasons.length > 0,
      reasons,
      fromPatient,
      toPatient,
    };
  });
}

/**
 * Executes an atomic patient merge in the hospital.
 * If critical, records an alert in patient_merge_alerts for administrative oversight.
 */
export async function executePatientMerge(
  hospitalId: string,
  actorUserId: string | null,
  actorRole: string,
  params: {
    fromPatientId: string;
    toPatientId: string;
    justification?: string;
  },
): Promise<{ survivorId: string; alertId?: string }> {
  if (!can(actorRole as any, 'patients.merge_records')) {
    throw new Error('You do not have permission to merge patient records');
  }

  if (params.fromPatientId === params.toPatientId) {
    throw new Error('Cannot merge a patient record into itself');
  }

  return withTenant(hospitalId, async (tx) => {
    const criticality = await checkPatientMergeCriticality(hospitalId, params.fromPatientId, params.toPatientId);
    const justification = (params.justification || '').trim();

    if (criticality.isCritical && justification.length < 10) {
      throw new Error('A detailed clinical justification (minimum 10 characters) is required for critical patient merges');
    }

    const now = new Date();
    const survivorId = await resolveRow(tx, params.toPatientId);

    // 1. Mark fromPatient as merged
    await tx
      .update(patients)
      .set({
        mergedIntoId: survivorId,
        mergedAt: now,
        mergedByUserId: actorUserId,
        updatedAt: now,
      })
      .where(and(eq(patients.hospitalId, hospitalId), eq(patients.id, params.fromPatientId)));

    // 2. Insert record in patient_merges
    await tx.insert(patientMerges).values({
      hospitalId,
      fromPatientId: params.fromPatientId,
      toPatientId: survivorId,
      reason: justification || 'Duplicate record merged at desk',
      mergedByUserId: actorUserId,
    });

    let alertId: string | undefined;

    // 3. If critical, record administrative alert
    if (criticality.isCritical) {
      const [alert] = await tx
        .insert(patientMergeAlerts)
        .values({
          hospitalId,
          alertType: 'critical_patient_merge',
          actorUserId,
          actorRole,
          fromPatientId: params.fromPatientId,
          toPatientId: survivorId,
          fromUhid: criticality.fromPatient.mrn,
          toUhid: criticality.toPatient.mrn,
          fromPatientName: criticality.fromPatient.name,
          toPatientName: criticality.toPatient.name,
          criticalReasons: criticality.reasons,
          justification,
        })
        .returning({ id: patientMergeAlerts.id });
      alertId = alert.id;
    }

    return { survivorId, alertId };
  });
}

/**
 * Lists patient merge alerts for hospital administration.
 */
export async function listPatientMergeAlerts(hospitalId: string, limit = 50) {
  return withTenant(hospitalId, async (tx) => {
    return tx
      .select()
      .from(patientMergeAlerts)
      .where(eq(patientMergeAlerts.hospitalId, hospitalId))
      .orderBy(desc(patientMergeAlerts.createdAt))
      .limit(limit);
  });
}

/**
 * Marks a patient merge alert as reviewed by an administrator.
 */
export async function reviewPatientMergeAlert(
  hospitalId: string,
  actorUserId: string,
  alertId: string,
): Promise<void> {
  await withTenant(hospitalId, async (tx) => {
    await tx
      .update(patientMergeAlerts)
      .set({
        reviewedAt: new Date(),
        reviewedByUserId: actorUserId,
      })
      .where(and(eq(patientMergeAlerts.hospitalId, hospitalId), eq(patientMergeAlerts.id, alertId)));
  });
}
