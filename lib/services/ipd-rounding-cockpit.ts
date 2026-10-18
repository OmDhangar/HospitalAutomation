import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  bedAssignments,
  beds,
  doctors,
  ipdAllergyAssessments,
  ipdClinicalRounds,
  ipdMedicationAdministrations,
  ipdMedicationOrders,
  medicines,
  patients,
  users,
  wards,
  type SelectIpdMedicationOrder,
} from '@/lib/db/schema';
import { listActiveOrders } from '@/lib/services/ipd-medication-orders';
import { getLatestVitals } from '@/lib/services/tpr';

export interface AllergenItem {
  substance: string;
  reaction?: string;
  severity?: 'mild' | 'moderate' | 'severe';
}

export interface RoundingCockpitData {
  admission: {
    id: string;
    patientId: string;
    patientName: string;
    gender: string | null;
    age: number | null;
    ipdNumber: number | null;
    admittedAt: Date | null;
    status: string;
    bed: { label: string; wardName: string } | null;
    attendingDoctor: { id: string; name: string } | null;
  };
  vitalsFreshness: {
    reading: {
      temperatureF: number | null;
      pulseBpm: number | null;
      spo2Percent: number | null;
      bpSystolic: number | null;
      bpDiastolic: number | null;
      respiratoryRate: number | null;
      bloodSugarMgDl: number | null;
      collectedAt: Date | null;
    } | null;
    ageMinutes: number | null;
    isStale: boolean;
  };
  allergyAssessment: {
    status: 'unreviewed' | 'nkda' | 'allergies_documented';
    allergens: AllergenItem[];
    reviewedAt: Date | null;
    reviewedByUserName?: string | null;
  };
  activeOrders: SelectIpdMedicationOrder[];
  recentAdministrations: Array<{
    id: string;
    orderId: string;
    orderChainId: string;
    doseGiven: string | null;
    actualTime: Date | null;
    recordedAt: Date;
    outcome: string;
    clinicalNote?: string | null;
  }>;
  urgentNurseAdministrations: Array<{
    id: string;
    orderId: string;
    medicineName: string;
    doseGiven: string | null;
    routeGiven: string | null;
    actualTime: Date | null;
    recordedAt: Date;
    clinicalNote: string | null;
    nurseName: string | null;
  }>;
  draftRound: {
    id: string;
    notes: string;
    doctorId: string;
    updatedAt: Date;
  } | null;
  frequentMedicines: Array<{
    id: string;
    name: string;
    genericName: string | null;
    form: string | null;
    unit: string;
  }>;
}

/**
 * Loads aggregated clinical context for the Doctor Rounding Cockpit.
 * Includes admission identity, latest TPR vitals with freshness status,
 * current allergy assessment, active medication orders, 24h administration timeline,
 * any active draft round notes, and common formulary items.
 */
export async function getRoundingCockpitData(args: {
  hospitalId: string;
  admissionId: string;
  userId: string;
  timezone?: string;
}): Promise<RoundingCockpitData> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      // 1. Fetch admission with patient and doctor details
      const [admissionRow] = await tx
        .select({
          id: admissions.id,
          patientId: admissions.patientId,
          patientName: patients.name,
          gender: patients.gender,
          birthYear: patients.birthYear,
          ipdNumber: admissions.ipdNumber,
          admittedAt: admissions.admittedAt,
          status: admissions.status,
          doctorId: doctors.id,
          doctorName: doctors.name,
        })
        .from(admissions)
        .innerJoin(patients, eq(patients.id, admissions.patientId))
        .leftJoin(doctors, eq(doctors.id, admissions.admittingDoctorId))
        .where(
          and(
            eq(admissions.hospitalId, args.hospitalId),
            eq(admissions.id, args.admissionId),
          ),
        );

      if (!admissionRow) {
        throw new Error('Admission not found');
      }

      // Fetch currently assigned bed (if any)
      const [currentBed] = await tx
        .select({
          bedLabel: beds.label,
          wardName: wards.name,
        })
        .from(bedAssignments)
        .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
        .leftJoin(wards, eq(wards.id, beds.wardId))
        .where(
          and(
            eq(bedAssignments.admissionId, args.admissionId),
            isNull(bedAssignments.toAt),
          ),
        );

      const now = new Date();
      const currentYear = now.getFullYear();
      const age = admissionRow.birthYear ? currentYear - admissionRow.birthYear : null;

      // 2. Fetch latest vitals and evaluate freshness
      let vitalsReading: any = null;
      let ageMinutes: number | null = null;
      let isStale = true;

      try {
        const latestVitals = await getLatestVitals(args.hospitalId, args.admissionId);
        if (latestVitals && latestVitals.observedAt) {
          const recTime = new Date(latestVitals.observedAt);
          ageMinutes = Math.max(0, Math.floor((now.getTime() - recTime.getTime()) / (60 * 1000)));
          isStale = ageMinutes > 360; // Older than 6 hours is stale
          vitalsReading = {
            temperatureF: latestVitals.tempFTenths !== null && latestVitals.tempFTenths !== undefined ? latestVitals.tempFTenths / 10 : null,
            pulseBpm: latestVitals.pulse ?? null,
            spo2Percent: latestVitals.spo2 ?? null,
            bpSystolic: latestVitals.bpSystolic ?? null,
            bpDiastolic: latestVitals.bpDiastolic ?? null,
            respiratoryRate: latestVitals.respRate ?? null,
            bloodSugarMgDl: latestVitals.bslMgDl ?? null,
            collectedAt: recTime,
          };
        }
      } catch {
        // If TPR service unavailable, vitals remain null/stale
      }

      // 3. Fetch current allergy assessment
      const [currentAllergy] = await tx
        .select({
          status: ipdAllergyAssessments.status,
          allergens: ipdAllergyAssessments.allergens,
          reviewedAt: ipdAllergyAssessments.reviewedAt,
          reviewedByUserName: users.name,
        })
        .from(ipdAllergyAssessments)
        .leftJoin(users, eq(users.id, ipdAllergyAssessments.reviewedByUserId))
        .where(
          and(
            eq(ipdAllergyAssessments.hospitalId, args.hospitalId),
            eq(ipdAllergyAssessments.admissionId, args.admissionId),
            eq(ipdAllergyAssessments.isCurrent, true),
          ),
        );

      const normalizedAllergens: AllergenItem[] = (
        (currentAllergy?.allergens as any[]) ?? []
      ).map((item) =>
        typeof item === 'string'
          ? { substance: item }
          : {
              substance: item.substance ?? String(item),
              reaction: item.reaction,
              severity: item.severity,
            },
      );

      const allergyAssessment: RoundingCockpitData['allergyAssessment'] = {
        status: (currentAllergy?.status as any) ?? 'unreviewed',
        allergens: normalizedAllergens,
        reviewedAt: currentAllergy?.reviewedAt ?? null,
        reviewedByUserName: currentAllergy?.reviewedByUserName ?? null,
      };

      // 4. Fetch active and held orders
      const activeOrders = await listActiveOrders({
        hospitalId: args.hospitalId,
        admissionId: args.admissionId,
        now,
      });

      // 5. Fetch recent administrations in past 24 hours
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const recentAdmins = await tx
        .select({
          id: ipdMedicationAdministrations.id,
          orderId: ipdMedicationAdministrations.orderId,
          orderChainId: ipdMedicationAdministrations.orderChainId,
          doseGiven: ipdMedicationAdministrations.doseGiven,
          actualTime: ipdMedicationAdministrations.actualTime,
          recordedAt: ipdMedicationAdministrations.recordedAt,
          outcome: ipdMedicationAdministrations.outcome,
          clinicalNote: ipdMedicationAdministrations.clinicalNote,
        })
        .from(ipdMedicationAdministrations)
        .where(
          and(
            eq(ipdMedicationAdministrations.hospitalId, args.hospitalId),
            eq(ipdMedicationAdministrations.admissionId, args.admissionId),
            sql`${ipdMedicationAdministrations.recordedAt} >= now() - interval '24 hours'`,
            isNull(ipdMedicationAdministrations.voidedAt),
          ),
        )
        .orderBy(desc(ipdMedicationAdministrations.recordedAt));

      // 5b. Fetch nurse urgent administrations awaiting doctor review (in past 48 hours)
      const urgentNurseAdmins = await tx
        .select({
          id: ipdMedicationAdministrations.id,
          orderId: ipdMedicationAdministrations.orderId,
          doseGiven: ipdMedicationAdministrations.doseGiven,
          routeGiven: ipdMedicationAdministrations.routeGiven,
          actualTime: ipdMedicationAdministrations.actualTime,
          recordedAt: ipdMedicationAdministrations.recordedAt,
          clinicalNote: ipdMedicationAdministrations.clinicalNote,
          medicineName: ipdMedicationOrders.medicineName,
          nurseName: users.name,
        })
        .from(ipdMedicationAdministrations)
        .innerJoin(
          ipdMedicationOrders,
          eq(ipdMedicationOrders.id, ipdMedicationAdministrations.orderId),
        )
        .leftJoin(users, eq(users.id, ipdMedicationAdministrations.nurseUserId))
        .where(
          and(
            eq(ipdMedicationAdministrations.hospitalId, args.hospitalId),
            eq(ipdMedicationAdministrations.admissionId, args.admissionId),
            isNull(ipdMedicationAdministrations.voidedAt),
            sql`(${ipdMedicationOrders.specialInstructions} LIKE '%NURSE URGENT ADMIN%' OR ${ipdMedicationAdministrations.clinicalNote} LIKE '%URGENT NURSE ADMIN%')`,
            sql`${ipdMedicationAdministrations.recordedAt} >= now() - interval '48 hours'`,
          ),
        )
        .orderBy(desc(ipdMedicationAdministrations.recordedAt));

      // 6. Fetch today's draft round (if exists)
      const [draftRoundRow] = await tx
        .select({
          id: ipdClinicalRounds.id,
          notes: ipdClinicalRounds.evaluationNotes,
          doctorId: ipdClinicalRounds.doctorId,
          updatedAt: ipdClinicalRounds.updatedAt,
        })
        .from(ipdClinicalRounds)
        .where(
          and(
            eq(ipdClinicalRounds.hospitalId, args.hospitalId),
            eq(ipdClinicalRounds.admissionId, args.admissionId),
            eq(ipdClinicalRounds.status, 'draft'),
          ),
        );

      // 7. Fetch frequent inpatient formulary items for quick-pick
      const frequentMedicines = await tx
        .select({
          id: medicines.id,
          name: medicines.name,
          genericName: medicines.genericName,
          form: medicines.form,
          unit: medicines.unit,
        })
        .from(medicines)
        .where(
          and(
            eq(medicines.hospitalId, args.hospitalId),
            eq(medicines.active, true),
          ),
        )
        .limit(15);

      return {
        admission: {
          id: admissionRow.id,
          patientId: admissionRow.patientId,
          patientName: admissionRow.patientName,
          gender: admissionRow.gender,
          age,
          ipdNumber: admissionRow.ipdNumber,
          admittedAt: admissionRow.admittedAt,
          status: admissionRow.status,
          bed:
            currentBed && currentBed.bedLabel && currentBed.wardName
              ? { label: currentBed.bedLabel, wardName: currentBed.wardName }
              : null,
          attendingDoctor: admissionRow.doctorId
            ? { id: admissionRow.doctorId, name: admissionRow.doctorName ?? 'Doctor' }
            : null,
        },
        vitalsFreshness: {
          reading: vitalsReading,
          ageMinutes,
          isStale,
        },
        allergyAssessment,
        activeOrders,
        recentAdministrations: recentAdmins,
        urgentNurseAdministrations: urgentNurseAdmins,
        draftRound: draftRoundRow ?? null,
        frequentMedicines,
      };
    },
    { clinical: true },
  );
}

/**
 * Records an admission allergy assessment (NKDA or documented drug allergies).
 * Preserves historical audit trail by archiving prior active records with is_current = false.
 */
export async function recordAllergyAssessment(args: {
  hospitalId: string;
  admissionId: string;
  status: 'unreviewed' | 'nkda' | 'allergies_documented';
  allergens?: Array<string | AllergenItem>;
  doctorId?: string;
  actorUserId: string;
}): Promise<{ success: boolean; status: string; allergens: any[] }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      // 1. Fetch admission encounter and patient IDs
      const [admission] = await tx
        .select({
          encounterId: admissions.encounterId,
          patientId: admissions.patientId,
        })
        .from(admissions)
        .where(
          and(
            eq(admissions.hospitalId, args.hospitalId),
            eq(admissions.id, args.admissionId),
          ),
        );

      if (!admission) throw new Error('Admission not found');

      const now = new Date();

      // 2. Archive existing current assessments
      await tx
        .update(ipdAllergyAssessments)
        .set({ isCurrent: false, updatedAt: now })
        .where(
          and(
            eq(ipdAllergyAssessments.hospitalId, args.hospitalId),
            eq(ipdAllergyAssessments.admissionId, args.admissionId),
            eq(ipdAllergyAssessments.isCurrent, true),
          ),
        );

      // 3. Format allergens list
      const normalizedAllergens = (args.allergens ?? []).map((item) =>
        typeof item === 'string'
          ? { substance: item }
          : {
              substance: item.substance,
              reaction: item.reaction,
              severity: item.severity,
            },
      );

      // 4. Insert new current assessment row
      const isReviewed = args.status !== 'unreviewed';
      await tx.insert(ipdAllergyAssessments).values({
        hospitalId: args.hospitalId,
        admissionId: args.admissionId,
        encounterId: admission.encounterId,
        patientId: admission.patientId,
        status: args.status,
        allergens: normalizedAllergens,
        isCurrent: true,
        reviewedByUserId: isReviewed ? args.actorUserId : null,
        reviewedAt: isReviewed ? now : null,
        recordedAt: now,
      });

      return {
        success: true,
        status: args.status,
        allergens: normalizedAllergens,
      };
    },
    { clinical: true },
  );
}

/**
 * Saves or updates a daily round assessment note as a work-in-progress draft.
 * Unsigned drafts remain private to the doctor and never become actionable on the bedside eMAR.
 */
export async function saveRoundDraft(args: {
  hospitalId: string;
  admissionId: string;
  doctorId: string;
  authorUserId: string;
  notes?: string;
}): Promise<{ roundId: string; status: string }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const now = new Date();
      const cleanNotes = args.notes ?? '';

      // Check if draft round exists
      const [existingDraft] = await tx
        .select({ id: ipdClinicalRounds.id })
        .from(ipdClinicalRounds)
        .where(
          and(
            eq(ipdClinicalRounds.hospitalId, args.hospitalId),
            eq(ipdClinicalRounds.admissionId, args.admissionId),
            eq(ipdClinicalRounds.status, 'draft'),
          ),
        );

      if (existingDraft) {
        await tx
          .update(ipdClinicalRounds)
          .set({
            evaluationNotes: cleanNotes,
            updatedAt: now,
          })
          .where(eq(ipdClinicalRounds.id, existingDraft.id));

        return { roundId: existingDraft.id, status: 'draft' };
      }

      // Fetch admission details
      const [admission] = await tx
        .select({
          encounterId: admissions.encounterId,
          patientId: admissions.patientId,
        })
        .from(admissions)
        .where(
          and(
            eq(admissions.hospitalId, args.hospitalId),
            eq(admissions.id, args.admissionId),
          ),
        );

      if (!admission) throw new Error('Admission not found');

      const roundId = crypto.randomUUID();
      await tx.insert(ipdClinicalRounds).values({
        id: roundId,
        hospitalId: args.hospitalId,
        admissionId: args.admissionId,
        encounterId: admission.encounterId,
        patientId: admission.patientId,
        doctorId: args.doctorId,
        authorUserId: args.authorUserId,
        status: 'draft',
        evaluationNotes: cleanNotes,
      });

      return { roundId, status: 'draft' };
    },
    { clinical: true },
  );
}
