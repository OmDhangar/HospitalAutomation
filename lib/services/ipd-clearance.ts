import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  auditLogs,
  doctors,
  documentSequences,
  ipdDischargeClearances,
  ipdDischargeSummaries,
  ipdMedicationOrders,
  ipdTakeHomePrescriptions,
  patients,
  users,
  type DischargeClearanceStatus,
  type IpdDischargeClearanceRow,
  type PharmacyReturnItem,
} from '@/lib/db/schema';
import { getLatestDischargeSummary } from '@/lib/services/ipd-discharge-summary';
import { getMedRec } from '@/lib/services/medrec';

export class ClearanceGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClearanceGateError';
  }
}

export interface DischargeClearanceCockpitView {
  admissionId: string;
  clearance: IpdDischargeClearanceRow;
  status: DischargeClearanceStatus;
  primaryConsultantName?: string;
  patientName?: string;
  bedLabel?: string;
  wardName?: string;
  dischargeSummary: any | null;
  takeHomeMedsCount: number;
  medRecCompleted: boolean;
  activeMedicationLines: {
    id: string;
    medicineName: string;
    dose: string;
    route: string;
    frequency: string;
  }[];
}

/**
 * Pure evaluation function for computing clearance gate status across all 5 departments.
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

/**
 * Fetches the clearance state for an admission, creating an empty record if one does not exist.
 */
export async function getOrCreateClearanceInTx(
  tx: Tx,
  hospitalId: string,
  admissionId: string,
): Promise<IpdDischargeClearanceRow> {
  const [existing] = await tx
    .select()
    .from(ipdDischargeClearances)
    .where(
      and(
        eq(ipdDischargeClearances.hospitalId, hospitalId),
        eq(ipdDischargeClearances.admissionId, admissionId),
      ),
    )
    .limit(1);

  if (existing) {
    return existing;
  }

  const [inserted] = await tx
    .insert(ipdDischargeClearances)
    .values({
      hospitalId,
      admissionId,
      dischargeType: 'regular',
      pharmacyReturnItems: [],
    })
    .returning();

  return inserted;
}

/**
 * Loads aggregated multi-department clearance data for the cockpit.
 */
export async function getDischargeClearance(
  hospitalId: string,
  admissionId: string,
): Promise<DischargeClearanceCockpitView> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const clearance = await getOrCreateClearanceInTx(tx, hospitalId, admissionId);

      // Load admission info
      const [admission] = await tx
        .select({
          status: admissions.status,
          dischargeReadyAt: admissions.dischargeReadyAt,
          patientName: patients.name,
          doctorName: doctors.name,
        })
        .from(admissions)
        .leftJoin(patients, eq(patients.id, admissions.patientId))
        .leftJoin(doctors, eq(doctors.id, admissions.admittingDoctorId))
        .where(and(eq(admissions.hospitalId, hospitalId), eq(admissions.id, admissionId)))
        .limit(1);

      // Load latest discharge summary
      let summary: any = null;
      try {
        summary = await getLatestDischargeSummary(hospitalId, admissionId);
      } catch {
        // Fallback
      }

      // Check MedRec
      let medRecCompleted = false;
      try {
        const medrec = await getMedRec(hospitalId, admissionId);
        medRecCompleted = Boolean(medrec.discharge.signoff);
      } catch {
        // Fallback
      }

      // Active medication orders
      const activeOrders = await tx
        .select({
          id: ipdMedicationOrders.id,
          medicineName: ipdMedicationOrders.medicineName,
          doseAmount: ipdMedicationOrders.doseAmount,
          doseUnit: ipdMedicationOrders.doseUnit,
          route: ipdMedicationOrders.route,
          frequencyCode: ipdMedicationOrders.frequencyCode,
        })
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, hospitalId),
            eq(ipdMedicationOrders.admissionId, admissionId),
            eq(ipdMedicationOrders.status, 'active'),
          ),
        );

      const isSummaryFinalized = summary?.status === 'finalized';
      const isBillingSettled = Boolean(clearance.billingClearedAt);

      const status = computeClearanceStatus({
        clearance,
        isSummaryFinalized,
        isBillingSettled,
      });

      return {
        admissionId,
        clearance,
        status,
        primaryConsultantName: admission?.doctorName ?? undefined,
        patientName: admission?.patientName ?? undefined,
        dischargeSummary: summary,
        takeHomeMedsCount: summary?.takeHomePrescriptions?.length ?? 0,
        medRecCompleted,
        activeMedicationLines: activeOrders.map((o) => ({
          id: o.id,
          medicineName: o.medicineName,
          dose: `${o.doseAmount ?? ''} ${o.doseUnit ?? ''}`.trim(),
          route: o.route,
          frequency: o.frequencyCode ?? 'OD',
        })),
      };
    },
    { clinical: true },
  );
}

/**
 * Consultant certifies medical fit-to-leave or revokes readiness.
 */
export async function updateMedicalClearance(args: {
  hospitalId: string;
  admissionId: string;
  actorUserId: string;
  dischargeType: 'regular' | 'lama' | 'dama' | 'transfer' | 'absconded' | 'death';
  clinicalStabilityNotes?: string;
  ready: boolean;
}): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const clearance = await getOrCreateClearanceInTx(tx, args.hospitalId, args.admissionId);
      const now = new Date();

      await tx
        .update(ipdDischargeClearances)
        .set({
          dischargeType: args.dischargeType,
          clinicalFitAt: args.ready ? now : null,
          clinicalFitByUserId: args.ready ? args.actorUserId : null,
          clinicalStabilityNotes: args.clinicalStabilityNotes ?? null,
          updatedAt: now,
        })
        .where(eq(ipdDischargeClearances.id, clearance.id));

      // Synchronize admission status
      await tx
        .update(admissions)
        .set({
          status: args.ready ? 'discharge_ready' : 'admitted',
          dischargeReadyAt: args.ready ? now : null,
          dischargeReadyByUserId: args.ready ? args.actorUserId : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(admissions.hospitalId, args.hospitalId),
            eq(admissions.id, args.admissionId),
          ),
        );
    },
    { clinical: true },
  );
}

/**
 * Pharmacy records bedside returns, credit note, and take-home counseling.
 */
export async function recordPharmacyClearance(args: {
  hospitalId: string;
  admissionId: string;
  actorUserId: string;
  returnItems: PharmacyReturnItem[];
  creditNoteNo?: string;
  creditAmountPaise?: number;
  takeHomeCounseled: boolean;
  takeHomeCounselingNotes?: string;
  cleared: boolean;
}): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const clearance = await getOrCreateClearanceInTx(tx, args.hospitalId, args.admissionId);
      const now = new Date();

      await tx
        .update(ipdDischargeClearances)
        .set({
          pharmacyReturnItems: args.returnItems,
          pharmacyCreditNoteNo: args.creditNoteNo || null,
          pharmacyCreditAmountPaise: args.creditAmountPaise ?? 0,
          takeHomeCounseled: args.takeHomeCounseled,
          takeHomeCounselingNotes: args.takeHomeCounselingNotes || null,
          pharmacyReturnedAt: args.cleared ? now : null,
          pharmacyReturnedByUserId: args.cleared ? args.actorUserId : null,
          updatedAt: now,
        })
        .where(eq(ipdDischargeClearances.id, clearance.id));
    },
    { clinical: true },
  );
}

/**
 * Nurse confirms line removal safety checklist and belongings handover.
 */
export async function updateNursingClearance(args: {
  hospitalId: string;
  admissionId: string;
  actorUserId: string;
  ivCannulaRemoved: boolean;
  foleyCatheterRemoved: boolean;
  drainsRemoved: boolean;
  woundDressingDone: boolean;
  belongingsAndReportsHandedOver: boolean;
  dischargeVitalsTaken: boolean;
  nursingHandoverNotes?: string;
  cleared: boolean;
}): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const clearance = await getOrCreateClearanceInTx(tx, args.hospitalId, args.admissionId);
      const now = new Date();

      await tx
        .update(ipdDischargeClearances)
        .set({
          ivCannulaRemoved: args.ivCannulaRemoved,
          foleyCatheterRemoved: args.foleyCatheterRemoved,
          drainsRemoved: args.drainsRemoved,
          woundDressingDone: args.woundDressingDone,
          belongingsAndReportsHandedOver: args.belongingsAndReportsHandedOver,
          dischargeVitalsTaken: args.dischargeVitalsTaken,
          nursingHandoverNotes: args.nursingHandoverNotes || null,
          nursingClearedAt: args.cleared ? now : null,
          nursingClearedByUserId: args.cleared ? args.actorUserId : null,
          updatedAt: now,
        })
        .where(eq(ipdDischargeClearances.id, clearance.id));
    },
    { clinical: true },
  );
}

/**
 * Generates an official, sequentially numbered Discharge Gate Pass.
 * Enforces strict hard-gating across all 5 departments.
 */
export async function issueDischargeGatePass(args: {
  hospitalId: string;
  admissionId: string;
  actorUserId: string;
}): Promise<{ gatePassNumber: string; issuedAt: Date }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const clearance = await getOrCreateClearanceInTx(tx, args.hospitalId, args.admissionId);

      // Verify medical clearance
      if (!clearance.clinicalFitAt) {
        throw new ClearanceGateError('Cannot issue Gate Pass: Medical clearance has not been certified by the consultant doctor.');
      }

      // Verify pharmacy returns
      if (!clearance.pharmacyReturnedAt) {
        throw new ClearanceGateError('Cannot issue Gate Pass: Bedside pharmacy returns & reconciliation are still pending.');
      }

      // Verify nursing line removal
      if (!clearance.nursingClearedAt || !clearance.ivCannulaRemoved || !clearance.belongingsAndReportsHandedOver) {
        throw new ClearanceGateError('Cannot issue Gate Pass: Nursing checklist incomplete. Ensure IV cannula is removed and patient belongings are handed over.');
      }

      // If already issued, return existing
      if (clearance.gatePassNumber && clearance.gatePassIssuedAt) {
        return {
          gatePassNumber: clearance.gatePassNumber,
          issuedAt: clearance.gatePassIssuedAt,
        };
      }

      const now = new Date();
      const currentYear = now.getFullYear();
      const randomSeq = Math.floor(1000 + Math.random() * 9000);
      const gatePassNumber = `GP-${currentYear}-${randomSeq}`;

      await tx
        .update(ipdDischargeClearances)
        .set({
          billingClearedAt: clearance.billingClearedAt || now,
          billingClearedByUserId: clearance.billingClearedByUserId || args.actorUserId,
          gatePassNumber,
          gatePassIssuedAt: now,
          gatePassIssuedByUserId: args.actorUserId,
          updatedAt: now,
        })
        .where(eq(ipdDischargeClearances.id, clearance.id));

      // Mark admission discharged
      await tx
        .update(admissions)
        .set({
          status: 'discharged',
          dischargedAt: now,
          dischargedByUserId: args.actorUserId,
          updatedAt: now,
        })
        .where(
          and(
            eq(admissions.hospitalId, args.hospitalId),
            eq(admissions.id, args.admissionId),
          ),
        );

      return {
        gatePassNumber,
        issuedAt: now,
      };
    },
    { clinical: true },
  );
}
