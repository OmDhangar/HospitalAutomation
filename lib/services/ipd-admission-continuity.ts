import crypto from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  clinicalAuditLogs,
  doctors,
  ipdAllergyAssessments,
  ipdMedicationOrders,
  prescriptionItems,
  prescriptions,
} from '@/lib/db/schema';
import {
  parseOpdDose,
  mapFrequencyToTimes,
  mapRoute,
  type IpdRoute,
} from '@/lib/domain/opd-to-ipd-parser';
import {
  checkAllergyConflict,
  AllergyConflictError,
} from '@/lib/services/ipd-medication-orders';

export class AdmissionContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionContinuityError';
  }
}

export interface PortOpdPrescriptionsArgs {
  hospitalId: string;
  admissionId: string;
  encounterId: string;
  patientId: string;
  doctorId: string;
  actorUserId: string;
}

export interface DraftMedicationOrderItem {
  id: string;
  medicineId: string;
  medicineName: string;
  strength?: string | null;
  form?: string | null;
  doseAmount: string;
  doseUnit: string;
  route: IpdRoute;
  scheduleType: string;
  frequencyCode: string;
  scheduleTimes: string[];
  instructions?: string | null;
  prescriberDoctorId: string;
  prescriberDoctorName?: string | null;
  createdAt: Date;
}

/**
 * Automatically ports active outpatient prescription items from the OPD consultation
 * into draft inpatient medication orders for the newly created admission.
 * Executed atomically inside the admission transaction.
 */
export async function portOpdPrescriptionsToIpdDraftsInTx(
  tx: Tx,
  args: PortOpdPrescriptionsArgs,
): Promise<{ draftOrderIds: string[]; prescriptionCount: number }> {
  // 1. Locate latest final prescription for the encounter
  const [latestPrescription] = await tx
    .select({
      id: prescriptions.id,
      prescriberDoctorId: prescriptions.prescriberDoctorId,
      prescriberName: prescriptions.prescriberName,
      createdAt: prescriptions.createdAt,
    })
    .from(prescriptions)
    .where(
      and(
        eq(prescriptions.hospitalId, args.hospitalId),
        eq(prescriptions.encounterId, args.encounterId),
        eq(prescriptions.status, 'final'),
      ),
    )
    .orderBy(desc(prescriptions.createdAt))
    .limit(1);

  if (!latestPrescription) {
    return { draftOrderIds: [], prescriptionCount: 0 };
  }

  // 2. Fetch all prescription lines
  const items = await tx
    .select()
    .from(prescriptionItems)
    .where(
      and(
        eq(prescriptionItems.hospitalId, args.hospitalId),
        eq(prescriptionItems.prescriptionId, latestPrescription.id),
      ),
    )
    .orderBy(prescriptionItems.sortOrder);

  if (items.length === 0) {
    return { draftOrderIds: [], prescriptionCount: 0 };
  }

  const draftOrderIds: string[] = [];

  for (const item of items) {
    // Prevent duplicate draft creation if shift was retried
    const [existing] = await tx
      .select({ id: ipdMedicationOrders.id })
      .from(ipdMedicationOrders)
      .where(
        and(
          eq(ipdMedicationOrders.hospitalId, args.hospitalId),
          eq(ipdMedicationOrders.admissionId, args.admissionId),
          eq(ipdMedicationOrders.medicineId, item.medicineId),
          inArray(ipdMedicationOrders.status, ['draft', 'active']),
        ),
      )
      .limit(1);

    if (existing) {
      continue;
    }

    const parsedDose = parseOpdDose(item.dose, item.form);
    const mappedFreq = mapFrequencyToTimes(item.frequency);
    const mappedRoute = mapRoute(item.route);

    const [inserted] = await tx
      .insert(ipdMedicationOrders)
      .values({
        hospitalId: args.hospitalId,
        admissionId: args.admissionId,
        encounterId: args.encounterId,
        patientId: args.patientId,
        orderChainId: crypto.randomUUID(),
        medicineId: item.medicineId,
        medicineName: item.medicineName,
        strength: item.strength ?? null,
        form: item.form ?? null,
        doseAmount: parsedDose.doseAmount,
        doseUnit: parsedDose.doseUnit,
        route: mappedRoute,
        scheduleType: mappedFreq.scheduleType,
        frequencyCode: mappedFreq.frequencyCode,
        scheduleTimes: mappedFreq.scheduleTimes,
        isPrn: mappedFreq.isPrn,
        specialInstructions: item.instructions
          ? `Ported from OPD: ${item.instructions}`
          : 'Ported from OPD Prescription',
        origin: 'inpatient_order',
        startsAt: new Date(),
        durationDays: item.durationDays ?? null,
        status: 'draft',
        prescriberDoctorId: args.doctorId,
        createdByUserId: args.actorUserId,
      })
      .returning({ id: ipdMedicationOrders.id });

    draftOrderIds.push(inserted.id);

    await tx.insert(clinicalAuditLogs).values({
      hospitalId: args.hospitalId,
      tableName: 'ipd_medication_orders',
      recordId: inserted.id,
      action: 'DRAFT_PORTED_FROM_OPD',
      newValue: {
        medicineName: item.medicineName,
        doseAmount: parsedDose.doseAmount,
        doseUnit: parsedDose.doseUnit,
        frequency: mappedFreq.frequencyCode,
        prescriptionId: latestPrescription.id,
      },
      userId: args.actorUserId,
    });
  }

  return {
    draftOrderIds,
    prescriptionCount: items.length,
  };
}

/**
 * Lists all draft medication orders for an admission waiting for doctor approval.
 */
export async function listDraftOrders(args: {
  hospitalId: string;
  admissionId: string;
}): Promise<DraftMedicationOrderItem[]> {
  return withTenant(args.hospitalId, async (tx) => {
    const rows = await tx
      .select({
        id: ipdMedicationOrders.id,
        medicineId: ipdMedicationOrders.medicineId,
        medicineName: ipdMedicationOrders.medicineName,
        strength: ipdMedicationOrders.strength,
        form: ipdMedicationOrders.form,
        doseAmount: ipdMedicationOrders.doseAmount,
        doseUnit: ipdMedicationOrders.doseUnit,
        route: ipdMedicationOrders.route,
        scheduleType: ipdMedicationOrders.scheduleType,
        frequencyCode: ipdMedicationOrders.frequencyCode,
        scheduleTimes: ipdMedicationOrders.scheduleTimes,
        instructions: ipdMedicationOrders.specialInstructions,
        prescriberDoctorId: ipdMedicationOrders.prescriberDoctorId,
        doctorName: doctors.name,
        createdAt: ipdMedicationOrders.createdAt,
      })
      .from(ipdMedicationOrders)
      .leftJoin(doctors, eq(doctors.id, ipdMedicationOrders.prescriberDoctorId))
      .where(
        and(
          eq(ipdMedicationOrders.hospitalId, args.hospitalId),
          eq(ipdMedicationOrders.admissionId, args.admissionId),
          eq(ipdMedicationOrders.status, 'draft'),
        ),
      )
      .orderBy(desc(ipdMedicationOrders.createdAt));

    return rows.map((r) => ({
      id: r.id,
      medicineId: r.medicineId,
      medicineName: r.medicineName,
      strength: r.strength,
      form: r.form,
      doseAmount: r.doseAmount,
      doseUnit: r.doseUnit,
      route: r.route as IpdRoute,
      scheduleType: r.scheduleType,
      frequencyCode: r.frequencyCode ?? 'OD',
      scheduleTimes: (r.scheduleTimes as string[]) ?? [],
      instructions: r.instructions,
      prescriberDoctorId: r.prescriberDoctorId,
      prescriberDoctorName: r.doctorName,
      createdAt: r.createdAt,
    }));
  });
}

/**
 * Approves a single draft medication order, transitioning it to active and stamping sign-off.
 */
export async function approveDraftMedicationOrder(args: {
  hospitalId: string;
  admissionId: string;
  orderId: string;
  doctorId: string;
  actorUserId: string;
  allergyOverrideReason?: string;
}): Promise<void> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [order] = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.admissionId, args.admissionId),
            eq(ipdMedicationOrders.id, args.orderId),
            eq(ipdMedicationOrders.status, 'draft'),
          ),
        );

      if (!order) {
        throw new AdmissionContinuityError('Draft medication order not found or already processed');
      }

      // Check documented allergies
      const [allergy] = await tx
        .select({
          status: ipdAllergyAssessments.status,
          allergens: ipdAllergyAssessments.allergens,
        })
        .from(ipdAllergyAssessments)
        .where(
          and(
            eq(ipdAllergyAssessments.hospitalId, args.hospitalId),
            eq(ipdAllergyAssessments.admissionId, args.admissionId),
            eq(ipdAllergyAssessments.isCurrent, true),
          ),
        );

      if (allergy && allergy.status === 'allergies_documented' && Array.isArray(allergy.allergens)) {
        const documentedAllergens = allergy.allergens.map((item: any) =>
          typeof item === 'string' ? { substance: item } : { substance: item.substance ?? String(item) },
        );
        const conflict = checkAllergyConflict(documentedAllergens, { medicineName: order.medicineName });
        if (conflict.hasConflict) {
          if (!args.allergyOverrideReason || args.allergyOverrideReason.trim().length < 5) {
            throw new AllergyConflictError(
              `Documented allergy to ${conflict.allergenSubstance} matches prescribed medicine ${order.medicineName}. Clinical override reason (>= 5 chars) is required.`,
            );
          }
          await tx.insert(clinicalAuditLogs).values({
            hospitalId: args.hospitalId,
            tableName: 'ipd_medication_orders',
            recordId: order.id,
            action: 'ALLERGY_OVERRIDE_ON_DRAFT_APPROVAL',
            newValue: {
              medicineName: order.medicineName,
              allergen: conflict.allergenSubstance,
              reason: args.allergyOverrideReason.trim(),
            },
            reason: args.allergyOverrideReason.trim(),
            userId: args.actorUserId,
          });
        }
      }

      await tx
        .update(ipdMedicationOrders)
        .set({
          status: 'active',
          prescriberDoctorId: args.doctorId,
          signedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(ipdMedicationOrders.id, order.id));

      await tx.insert(clinicalAuditLogs).values({
        hospitalId: args.hospitalId,
        tableName: 'ipd_medication_orders',
        recordId: order.id,
        action: 'DRAFT_ORDER_APPROVED',
        newValue: {
          status: 'active',
          approvedByDoctorId: args.doctorId,
        },
        userId: args.actorUserId,
      });
    },
    { clinical: true },
  );
}

/**
 * Bulk-approves all pending draft orders for an admission in a single transaction.
 */
export async function approveAllDraftOrders(args: {
  hospitalId: string;
  admissionId: string;
  doctorId: string;
  actorUserId: string;
  allergyOverrideReason?: string;
}): Promise<{ approvedCount: number; errors: string[] }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const drafts = await tx
        .select({
          id: ipdMedicationOrders.id,
          medicineName: ipdMedicationOrders.medicineName,
        })
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.admissionId, args.admissionId),
            eq(ipdMedicationOrders.status, 'draft'),
          ),
        );

      let approvedCount = 0;
      const errors: string[] = [];

      for (const draft of drafts) {
        try {
          await approveDraftMedicationOrder({
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            orderId: draft.id,
            doctorId: args.doctorId,
            actorUserId: args.actorUserId,
            allergyOverrideReason: args.allergyOverrideReason,
          });
          approvedCount++;
        } catch (err: any) {
          errors.push(`${draft.medicineName}: ${err.message}`);
        }
      }

      return { approvedCount, errors };
    },
    { clinical: true },
  );
}

/**
 * Rejects / voids a draft medication order with a recorded clinical reason.
 */
export async function rejectDraftOrder(args: {
  hospitalId: string;
  admissionId: string;
  orderId: string;
  reason: string;
  actorUserId: string;
}): Promise<void> {
  const trimmedReason = args.reason.trim();
  if (trimmedReason.length < 3) {
    throw new AdmissionContinuityError('Rejection reason must be at least 3 characters');
  }

  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [order] = await tx
        .select({ id: ipdMedicationOrders.id, status: ipdMedicationOrders.status })
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.admissionId, args.admissionId),
            eq(ipdMedicationOrders.id, args.orderId),
            eq(ipdMedicationOrders.status, 'draft'),
          ),
        );

      if (!order) {
        throw new AdmissionContinuityError('Draft medication order not found or already processed');
      }

      await tx
        .update(ipdMedicationOrders)
        .set({
          status: 'voided',
          voidedAt: new Date(),
          voidedByUserId: args.actorUserId,
          voidReason: trimmedReason,
          updatedAt: new Date(),
        })
        .where(eq(ipdMedicationOrders.id, order.id));

      await tx.insert(clinicalAuditLogs).values({
        hospitalId: args.hospitalId,
        tableName: 'ipd_medication_orders',
        recordId: order.id,
        action: 'DRAFT_ORDER_REJECTED',
        reason: trimmedReason,
        userId: args.actorUserId,
      });
    },
    { clinical: true },
  );
}
