import { and, desc, eq } from 'drizzle-orm';
import { db as defaultDb, withTenant } from '@/lib/db';
import {
  ipdAdmissionHomeMedications,
  ipdDischargeSummaries,
  ipdTakeHomePrescriptions,
  doctors,
} from '@/lib/db/schema';

export class PrescriberRegistrationRequiredError extends Error {
  constructor(message = 'Doctor registration number is required to finalize an inpatient discharge summary (NABH / Medical Council Act requirement).') {
    super(message);
    this.name = 'PrescriberRegistrationRequiredError';
  }
}

export class DischargeSummaryRequiredError extends Error {
  constructor(message = 'Discharge summary must be finalized with a registered doctor signature before financial settlement and patient checkout.') {
    super(message);
    this.name = 'DischargeSummaryRequiredError';
  }
}

export interface HomeMedicationInput {
  hospitalId: string;
  admissionId: string;
  medicineName: string;
  dosage?: string;
  frequency?: string;
  lastTakenAt?: string;
  reconciliationStatus?: 'continued' | 'stopped' | 'modified';
  reconciliationNotes?: string;
  recordedByUserId?: string;
}

export async function reconcileHomeMedication(
  input: HomeMedicationInput,
  executorDb?: any,
): Promise<{ id: string }> {
  const values = {
    hospitalId: input.hospitalId,
    admissionId: input.admissionId,
    medicineName: input.medicineName.trim(),
    dosage: input.dosage?.trim() || null,
    frequency: input.frequency?.trim() || null,
    lastTakenAt: input.lastTakenAt?.trim() || null,
    reconciliationStatus: input.reconciliationStatus ?? 'continued',
    reconciliationNotes: input.reconciliationNotes?.trim() || null,
    recordedByUserId: input.recordedByUserId ?? null,
  };

  if (executorDb) {
    const [row] = await executorDb.insert(ipdAdmissionHomeMedications).values(values).returning();
    return { id: row.id };
  }

  return withTenant(input.hospitalId, async (tx) => {
    const [row] = await tx.insert(ipdAdmissionHomeMedications).values(values).returning();
    return { id: row.id };
  });
}

export async function listHomeMedications(
  hospitalId: string,
  admissionId: string,
  executorDb?: any,
) {
  const queryRunner = executorDb?.query?.ipdAdmissionHomeMedications ?? defaultDb.query.ipdAdmissionHomeMedications;
  return queryRunner.findMany({
    where: and(
      eq(ipdAdmissionHomeMedications.hospitalId, hospitalId),
      eq(ipdAdmissionHomeMedications.admissionId, admissionId),
    ),
    orderBy: [desc(ipdAdmissionHomeMedications.createdAt)],
  });
}

export interface TakeHomePrescriptionInput {
  medicineName: string;
  dosage: string;
  route?: string;
  frequency: string;
  duration?: string;
  instructions?: string;
}

export interface SaveDischargeSummaryInput {
  hospitalId: string;
  admissionId: string;
  dischargeType: 'regular' | 'lama' | 'dama' | 'transfer' | 'death';
  primaryDiagnosis?: string;
  secondaryDiagnoses?: string;
  hospitalCourse?: string;
  conditionAtDischarge?: string;
  investigationSummary?: string;
  dischargeAdvice?: string;
  dietAdvice?: string;
  urgentWarningSigns?: string;
  followUpDate?: string;
  prescriberDoctorId?: string;
  takeHomePrescriptions?: TakeHomePrescriptionInput[];
  userId?: string;
}

export async function saveDischargeSummary(
  input: SaveDischargeSummaryInput,
  executorDb?: any,
): Promise<{ summaryId: string; version: number }> {
  const executeWork = async (tx: any) => {
    const queryRunner = tx.query?.ipdDischargeSummaries ?? defaultDb.query.ipdDischargeSummaries;
    const existing = await queryRunner.findFirst({
      where: and(
        eq(ipdDischargeSummaries.hospitalId, input.hospitalId),
        eq(ipdDischargeSummaries.admissionId, input.admissionId),
      ),
      orderBy: [desc(ipdDischargeSummaries.version)],
    });

    let summaryId: string;
    let version = 1;

    if (existing && existing.status === 'draft') {
      summaryId = existing.id;
      version = existing.version;
      await tx
        .update(ipdDischargeSummaries)
        .set({
          dischargeType: input.dischargeType,
          primaryDiagnosis: input.primaryDiagnosis?.trim() || null,
          secondaryDiagnoses: input.secondaryDiagnoses?.trim() || null,
          hospitalCourse: input.hospitalCourse?.trim() || null,
          conditionAtDischarge: input.conditionAtDischarge?.trim() || null,
          investigationSummary: input.investigationSummary?.trim() || null,
          dischargeAdvice: input.dischargeAdvice?.trim() || null,
          dietAdvice: input.dietAdvice?.trim() || null,
          urgentWarningSigns: input.urgentWarningSigns?.trim() || null,
          followUpDate: input.followUpDate?.trim() || null,
          prescriberDoctorId: input.prescriberDoctorId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(ipdDischargeSummaries.id, summaryId));

      // Remove previous take-home prescriptions for this draft before re-inserting
      if (input.takeHomePrescriptions) {
        await tx
          .delete(ipdTakeHomePrescriptions)
          .where(eq(ipdTakeHomePrescriptions.dischargeSummaryId, summaryId));
      }
    } else {
      if (existing) {
        version = existing.version + 1;
      }
      const [inserted] = await tx
        .insert(ipdDischargeSummaries)
        .values({
          hospitalId: input.hospitalId,
          admissionId: input.admissionId,
          version,
          dischargeType: input.dischargeType,
          status: 'draft',
          primaryDiagnosis: input.primaryDiagnosis?.trim() || null,
          secondaryDiagnoses: input.secondaryDiagnoses?.trim() || null,
          hospitalCourse: input.hospitalCourse?.trim() || null,
          conditionAtDischarge: input.conditionAtDischarge?.trim() || null,
          investigationSummary: input.investigationSummary?.trim() || null,
          dischargeAdvice: input.dischargeAdvice?.trim() || null,
          dietAdvice: input.dietAdvice?.trim() || null,
          urgentWarningSigns: input.urgentWarningSigns?.trim() || null,
          followUpDate: input.followUpDate?.trim() || null,
          prescriberDoctorId: input.prescriberDoctorId ?? null,
        })
        .returning();
      summaryId = inserted.id;
    }

    if (input.takeHomePrescriptions && input.takeHomePrescriptions.length > 0) {
      const takeHomeValues = input.takeHomePrescriptions.map((rx) => ({
        hospitalId: input.hospitalId,
        dischargeSummaryId: summaryId,
        admissionId: input.admissionId,
        medicineName: rx.medicineName.trim(),
        dosage: rx.dosage.trim(),
        route: rx.route?.trim() || 'oral',
        frequency: rx.frequency.trim(),
        duration: rx.duration?.trim() || null,
        instructions: rx.instructions?.trim() || null,
      }));
      await tx.insert(ipdTakeHomePrescriptions).values(takeHomeValues);
    }

    return { summaryId, version };
  };

  if (executorDb) {
    return executeWork(executorDb);
  }
  return withTenant(input.hospitalId, executeWork);
}

export interface FinalizeDischargeSummaryInput {
  hospitalId: string;
  admissionId: string;
  summaryId: string;
  prescriberDoctorId: string;
  userId: string;
}

export async function finalizeDischargeSummary(
  input: FinalizeDischargeSummaryInput,
  executorDb?: any,
): Promise<{ ok: boolean }> {
  const executeWork = async (tx: any) => {
    // 1. Verify doctor exists and has a non-empty registrationNo
    const docQuery = tx.query?.doctors ?? defaultDb.query.doctors;
    const doc = await docQuery.findFirst({
      where: and(eq(doctors.id, input.prescriberDoctorId), eq(doctors.hospitalId, input.hospitalId)),
      columns: { id: true, name: true, registrationNo: true },
    });

    if (!doc || !doc.registrationNo || !doc.registrationNo.trim()) {
      throw new PrescriberRegistrationRequiredError(
        `Doctor ${doc?.name || 'prescriber'} does not have a medical registration number on file. NABH and statutory regulations require an authorized medical council registration number to finalize an inpatient discharge summary.`,
      );
    }

    // 2. Update discharge summary status to finalized
    const now = new Date();
    await tx
      .update(ipdDischargeSummaries)
      .set({
        status: 'finalized',
        prescriberDoctorId: doc.id,
        prescriberRegistrationNo: doc.registrationNo.trim(),
        finalizedAt: now,
        finalizedByUserId: input.userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(ipdDischargeSummaries.id, input.summaryId),
          eq(ipdDischargeSummaries.hospitalId, input.hospitalId),
        ),
      );

    return { ok: true };
  };

  if (executorDb) {
    return executeWork(executorDb);
  }
  return withTenant(input.hospitalId, executeWork);
}

export async function getLatestDischargeSummary(
  hospitalId: string,
  admissionId: string,
  executorDb?: any,
) {
  const queryRunner = executorDb?.query?.ipdDischargeSummaries ?? defaultDb.query.ipdDischargeSummaries;
  const summary = await queryRunner.findFirst({
    where: and(
      eq(ipdDischargeSummaries.hospitalId, hospitalId),
      eq(ipdDischargeSummaries.admissionId, admissionId),
    ),
    orderBy: [desc(ipdDischargeSummaries.version)],
    with: {
      prescriberDoctor: true,
      takeHomePrescriptions: true,
    },
  });

  return summary ?? null;
}

export async function assertDischargeSummaryFinalized(
  hospitalId: string,
  admissionId: string,
  executorDb?: any,
): Promise<void> {
  const queryRunner = executorDb?.query?.ipdDischargeSummaries ?? defaultDb.query.ipdDischargeSummaries;
  const finalized = await queryRunner.findFirst({
    where: and(
      eq(ipdDischargeSummaries.hospitalId, hospitalId),
      eq(ipdDischargeSummaries.admissionId, admissionId),
      eq(ipdDischargeSummaries.status, 'finalized'),
    ),
  });

  if (!finalized || finalized.status !== 'finalized') {
    throw new DischargeSummaryRequiredError(
      'Cannot finalize discharge bill. Discharge summary must be finalized with a registered doctor signature before financial settlement.',
    );
  }
}
