import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  clinicalAuditLogs,
  ipdAllergyAssessments,
  ipdClinicalRounds,
  ipdMedicationOrders,
  ipdMedicationOrderActions,
  medicines,
  type SelectIpdMedicationOrder,
  type InsertIpdMedicationOrder,
} from '@/lib/db/schema';
import { validateOrderTransition } from '@/lib/domain/ipd-order-state';
import { isId } from '@/lib/domain/undo';

export interface DraftOrderInput {
  medicineId: string;
  medicineName: string;
  genericName?: string | null;
  strength?: string | null;
  form?: string | null;
  doseAmount: string;
  doseUnit: string;
  route: 'oral' | 'iv_push' | 'iv_piggyback' | 'im' | 'sc' | 'nebulization' | 'topical' | 'inhalation' | 'sublingual' | 'rectal' | 'ophthalmic' | 'otic';
  scheduleType: 'scheduled' | 'prn' | 'stat';
  frequencyCode?: string | null;
  scheduleTimes?: string[];
  isPrn?: boolean;
  prnIndication?: string | null;
  prnMaxDailyDoses?: number | null;
  prnMaxDailyQuantity?: string | null;
  prnMaxDailyUnit?: string | null;
  prnMinIntervalHours?: number | null;
  specialInstructions?: string | null;
  startsAt?: Date;
  endsAt?: Date | null;
  durationDays?: number | null;
}

export type OrderResolution =
  | { type: 'continue'; orderId: string }
  | { type: 'renew'; orderId: string; newEndsAt: Date; reason?: string }
  | { type: 'modify'; orderId: string; modifiedOrder: Partial<DraftOrderInput>; reason?: string }
  | { type: 'hold'; orderId: string; reason: string }
  | { type: 'discontinue'; orderId: string; reason: string }
  | { type: 'new'; order: DraftOrderInput };

export class AuthorNotLinkedDoctorError extends Error {
  constructor(
    message = 'The current user is not linked to an active doctor profile in this hospital. Clinical orders and rounds must be signed by an authenticated, linked doctor.',
  ) {
    super(message);
    this.name = 'AuthorNotLinkedDoctorError';
  }
}

export class AllergyAssessmentRequiredError extends Error {
  constructor(
    message = 'Allergy assessment is unreviewed. Patient drug allergy review is required before signing medication orders.',
  ) {
    super(message);
    this.name = 'AllergyAssessmentRequiredError';
  }
}

export class AllergyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllergyConflictError';
  }
}

export class DuplicateTherapyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateTherapyError';
  }
}

/**
 * Checks for allergen conflict using ingredient matching and class aliases.
 */
export function checkAllergyConflict(
  allergens: Array<{ substance: string }>,
  order: { medicineName: string; genericName?: string | null },
): { hasConflict: boolean; allergenSubstance?: string } {
  const medicineText = `${order.medicineName} ${order.genericName ?? ''}`.toLowerCase();

  for (const allergen of allergens) {
    const substance = allergen.substance?.trim()?.toLowerCase() ?? '';
    if (!substance) continue;

    if (medicineText.includes(substance) || substance.includes(order.medicineName.toLowerCase())) {
      return { hasConflict: true, allergenSubstance: allergen.substance };
    }

    if (
      substance.includes('penicillin') &&
      (medicineText.includes('amox') ||
        medicineText.includes('ampic') ||
        medicineText.includes('augmentin') ||
        medicineText.includes('penicillin') ||
        medicineText.includes('piperacillin'))
    ) {
      return { hasConflict: true, allergenSubstance: allergen.substance };
    }
    if (
      substance.includes('cephalosporin') &&
      (medicineText.includes('cef') || medicineText.includes('ceph'))
    ) {
      return { hasConflict: true, allergenSubstance: allergen.substance };
    }
    if (
      substance.includes('sulfa') &&
      (medicineText.includes('sulfa') ||
        medicineText.includes('bactrim') ||
        medicineText.includes('cotrimoxazole'))
    ) {
      return { hasConflict: true, allergenSubstance: allergen.substance };
    }
    if (
      substance.includes('nsaid') &&
      (medicineText.includes('ibuprofen') ||
        medicineText.includes('diclofenac') ||
        medicineText.includes('naproxen') ||
        medicineText.includes('aspirin') ||
        medicineText.includes('ketorolac'))
    ) {
      return { hasConflict: true, allergenSubstance: allergen.substance };
    }
  }
  return { hasConflict: false };
}

/**
 * Lists active and held medication orders for an admitted patient.
 * Excludes drafts, superseded, discontinued, and voided orders.
 */
export async function listActiveOrders(args: {
  hospitalId: string;
  admissionId: string;
  now?: Date;
}): Promise<SelectIpdMedicationOrder[]> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const orders = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.admissionId, args.admissionId),
            inArray(ipdMedicationOrders.status, ['active', 'on_hold']),
          ),
        )
        .orderBy(desc(ipdMedicationOrders.createdAt));

      return orders;
    },
    { clinical: true },
  );
}

/**
 * Ensures a valid UUID medicineId exists for medication orders.
 * If medicineId is already a valid UUID, checks whether it exists in this hospital.
 * If not a valid UUID (or not in DB), matches case-insensitively by name in medicines,
 * or provisions a new unpriced formulary entry so prescribing and billing workflow succeed.
 */
export async function resolveMedicineIdInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    medicineId?: string;
    medicineName: string;
    strength?: string | null;
    form?: string | null;
    unit?: string | null;
    actorUserId?: string;
  },
): Promise<string> {
  const { hospitalId, medicineId, medicineName, strength, form, unit, actorUserId } = args;

  // 1. If medicineId is a valid UUID, verify if it already exists in this hospital's formulary
  if (medicineId && isId(medicineId)) {
    const [existing] = await tx
      .select({ id: medicines.id })
      .from(medicines)
      .where(and(eq(medicines.hospitalId, hospitalId), eq(medicines.id, medicineId)));
    if (existing) return existing.id;
  }

  // 2. Search for existing medicine by case-insensitive name in this hospital
  const trimmedName = medicineName.trim();
  const [match] = await tx
    .select({ id: medicines.id })
    .from(medicines)
    .where(
      and(
        eq(medicines.hospitalId, hospitalId),
        sql`lower(${medicines.name}) = lower(${trimmedName})`,
      ),
    )
    .limit(1);

  if (match) return match.id;

  // 3. Auto-provision unpriced medicine in hospital formulary so prescribing succeeds
  const [created] = await tx
    .insert(medicines)
    .values({
      hospitalId,
      name: trimmedName,
      strength: strength ?? null,
      form: form ?? null,
      unit: unit || 'unit',
      sellingPricePaise: null, // Left unpriced until hospital owner configures formulary price
      active: true,
      createdByUserId: actorUserId,
    })
    .returning({ id: medicines.id });

  return created.id;
}

/**
 * Saves a work-in-progress round note and un-signed draft orders.
 * Draft orders are completely non-actionable at the bedside.
 */
export async function saveRoundDraft(args: {
  hospitalId: string;
  admissionId: string;
  doctorId: string;
  authorUserId: string;
  notes?: string;
  draftOrders?: DraftOrderInput[];
}): Promise<{ roundId: string }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const [admission] = await tx
        .select({
          encounterId: admissions.encounterId,
          patientId: admissions.patientId,
        })
        .from(admissions)
        .where(eq(admissions.id, args.admissionId));

      if (!admission) throw new Error('Admission not found');

      const existingRounds = await tx
        .select()
        .from(ipdClinicalRounds)
        .where(
          and(
            eq(ipdClinicalRounds.hospitalId, args.hospitalId),
            eq(ipdClinicalRounds.admissionId, args.admissionId),
            eq(ipdClinicalRounds.status, 'draft'),
          ),
        );

      let roundId: string;
      if (existingRounds.length > 0) {
        roundId = existingRounds[0].id;
        await tx
          .update(ipdClinicalRounds)
          .set({
            evaluationNotes: args.notes ?? '',
            doctorId: args.doctorId,
            authorUserId: args.authorUserId,
            updatedAt: new Date(),
          })
          .where(eq(ipdClinicalRounds.id, roundId));
      } else {
        const [insertedRound] = await tx
          .insert(ipdClinicalRounds)
          .values({
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            doctorId: args.doctorId,
            authorUserId: args.authorUserId,
            evaluationNotes: args.notes ?? '',
            status: 'draft',
          })
          .returning({ id: ipdClinicalRounds.id });
        roundId = insertedRound.id;
      }

      if (args.draftOrders && args.draftOrders.length > 0) {
        for (const draft of args.draftOrders) {
          const resolvedMedicineId = await resolveMedicineIdInTx(tx, {
            hospitalId: args.hospitalId,
            medicineId: draft.medicineId,
            medicineName: draft.medicineName,
            strength: draft.strength,
            form: draft.form,
            unit: draft.doseUnit,
            actorUserId: args.authorUserId,
          });

          await tx.insert(ipdMedicationOrders).values({
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            orderChainId: crypto.randomUUID(),
            medicineId: resolvedMedicineId,
            medicineName: draft.medicineName,
            strength: draft.strength ?? null,
            form: draft.form ?? null,
            doseAmount: draft.doseAmount,
            doseUnit: draft.doseUnit,
            route: draft.route,
            scheduleType: draft.scheduleType,
            frequencyCode: draft.frequencyCode ?? null,
            scheduleTimes: draft.scheduleTimes ?? [],
            isPrn: draft.isPrn ?? false,
            prnIndication: draft.prnIndication ?? null,
            prnMaxDailyDoses: draft.prnMaxDailyDoses ?? null,
            prnMaxDailyQuantity: draft.prnMaxDailyQuantity ?? null,
            prnMaxDailyUnit: draft.prnMaxDailyUnit ?? null,
            prnMinIntervalHours: draft.prnMinIntervalHours ?? null,
            specialInstructions: draft.specialInstructions ?? null,
            startsAt: draft.startsAt ?? new Date(),
            endsAt: draft.endsAt ?? null,
            durationDays: draft.durationDays ?? null,
            status: 'draft',
            prescriberDoctorId: args.doctorId,
            createdByUserId: args.authorUserId,
            roundNoteId: roundId,
          });
        }
      }

      return { roundId };
    },
    { clinical: true },
  );
}

/**
 * Atomically signs the clinical round evaluation and resolves all medication orders.
 * Creates immutable signed order rows and records append-only action audit entries.
 */
export async function signRoundOrders(args: {
  hospitalId: string;
  admissionId: string;
  doctorId: string;
  authorUserId: string;
  notes: string;
  resolutions: OrderResolution[];
  allergyOverrideReason?: string;
  duplicateOverrideReason?: string;
}): Promise<{ roundId: string; signedOrderIds: string[] }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      // 1. Verify Allergy Assessment Gate
      const [currentAllergy] = await tx
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

      const allergyStatus = currentAllergy?.status ?? 'unreviewed';
      if (allergyStatus === 'unreviewed') {
        throw new AllergyAssessmentRequiredError();
      }

      const documentedAllergens: Array<{ substance: string }> = (
        (currentAllergy?.allergens as any[]) ?? []
      ).map((item) => (typeof item === 'string' ? { substance: item } : { substance: item.substance ?? String(item) }));

      // 2. Fetch Active Orders for Duplicate Therapy Gate
      const activeExistingOrders = await tx
        .select({
          id: ipdMedicationOrders.id,
          medicineId: ipdMedicationOrders.medicineId,
          medicineName: ipdMedicationOrders.medicineName,
        })
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.admissionId, args.admissionId),
            inArray(ipdMedicationOrders.status, ['active', 'on_hold']),
          ),
        );

      for (const res of args.resolutions) {
        if (res.type === 'new' || res.type === 'modify') {
          const ord = res.type === 'new' ? res.order : res.modifiedOrder;
          if (ord.medicineName) {
            // Check allergy conflict
            if (allergyStatus === 'allergies_documented' && documentedAllergens.length > 0) {
              const conflict = checkAllergyConflict(documentedAllergens, {
                medicineName: ord.medicineName,
                genericName: (ord as any).genericName,
              });
              if (conflict.hasConflict) {
                if (!args.allergyOverrideReason || args.allergyOverrideReason.trim().length < 5) {
                  throw new AllergyConflictError(
                    `Documented allergy to ${conflict.allergenSubstance} matches prescribed medicine ${ord.medicineName}. A logged clinical override reason (>= 5 chars) is required to proceed.`,
                  );
                }
                await tx.insert(clinicalAuditLogs).values({
                  hospitalId: args.hospitalId,
                  tableName: 'ipd_medication_orders',
                  recordId: args.admissionId,
                  action: 'ALLERGY_OVERRIDE',
                  newValue: {
                    medicineName: ord.medicineName,
                    allergen: conflict.allergenSubstance,
                    reason: args.allergyOverrideReason,
                  },
                  reason: args.allergyOverrideReason,
                  userId: args.authorUserId,
                });
              }
            }

            // Check duplicate active therapy
            if (res.type === 'new') {
              const duplicate = activeExistingOrders.find(
                (o) =>
                  (ord.medicineId && o.medicineId === ord.medicineId) ||
                  (o.medicineName && ord.medicineName && o.medicineName.toLowerCase() === ord.medicineName.toLowerCase()),
              );
              if (duplicate) {
                if (!args.duplicateOverrideReason || args.duplicateOverrideReason.trim().length < 5) {
                  throw new DuplicateTherapyError(
                    `Active therapy for ${ord.medicineName} already exists. A logged duplicate override reason (>= 5 chars) is required to prescribe concurrent therapy.`,
                  );
                }
                await tx.insert(clinicalAuditLogs).values({
                  hospitalId: args.hospitalId,
                  tableName: 'ipd_medication_orders',
                  recordId: args.admissionId,
                  action: 'DUPLICATE_THERAPY_OVERRIDE',
                  newValue: {
                    medicineName: ord.medicineName,
                    existingOrderId: duplicate.id,
                    reason: args.duplicateOverrideReason,
                  },
                  reason: args.duplicateOverrideReason,
                  userId: args.authorUserId,
                });
              }
            }
          }
        }
      }

      const [admission] = await tx
        .select({
          encounterId: admissions.encounterId,
          patientId: admissions.patientId,
        })
        .from(admissions)
        .where(eq(admissions.id, args.admissionId));

      if (!admission) throw new Error('Admission not found');

      // Finalize or create the signed round note
      const existingDrafts = await tx
        .select()
        .from(ipdClinicalRounds)
        .where(
          and(
            eq(ipdClinicalRounds.hospitalId, args.hospitalId),
            eq(ipdClinicalRounds.admissionId, args.admissionId),
            eq(ipdClinicalRounds.status, 'draft'),
          ),
        );

      let roundId: string;
      const now = new Date();

      if (existingDrafts.length > 0) {
        roundId = existingDrafts[0].id;
        await tx
          .update(ipdClinicalRounds)
          .set({
            status: 'signed',
            signedAt: now,
            evaluationNotes: args.notes,
            doctorId: args.doctorId,
            authorUserId: args.authorUserId,
            updatedAt: now,
          })
          .where(eq(ipdClinicalRounds.id, roundId));
      } else {
        const [insertedRound] = await tx
          .insert(ipdClinicalRounds)
          .values({
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            doctorId: args.doctorId,
            authorUserId: args.authorUserId,
            evaluationNotes: args.notes,
            status: 'signed',
            signedAt: now,
          })
          .returning({ id: ipdClinicalRounds.id });
        roundId = insertedRound.id;
      }

      const signedOrderIds: string[] = [];

      for (const res of args.resolutions) {
        if (res.type === 'continue') {
          continue;
        }

        if (res.type === 'renew') {
          const [prior] = await tx
            .select()
            .from(ipdMedicationOrders)
            .where(eq(ipdMedicationOrders.id, res.orderId));
          if (!prior) throw new Error(`Order ${res.orderId} not found`);

          const newOrderId = crypto.randomUUID();

          // 1. Insert successor order first so newOrderId exists for the foreign key
          await tx.insert(ipdMedicationOrders).values({
            id: newOrderId,
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            orderChainId: prior.orderChainId,
            medicineId: prior.medicineId,
            medicineName: prior.medicineName,
            strength: prior.strength,
            form: prior.form,
            doseAmount: prior.doseAmount,
            doseUnit: prior.doseUnit,
            route: prior.route,
            scheduleType: prior.scheduleType,
            frequencyCode: prior.frequencyCode,
            scheduleTimes: prior.scheduleTimes,
            isPrn: prior.isPrn,
            prnIndication: prior.prnIndication,
            prnMaxDailyDoses: prior.prnMaxDailyDoses,
            prnMaxDailyQuantity: prior.prnMaxDailyQuantity,
            prnMaxDailyUnit: prior.prnMaxDailyUnit,
            prnMinIntervalHours: prior.prnMinIntervalHours,
            specialInstructions: prior.specialInstructions,
            origin: prior.origin,
            patientSupplied: prior.patientSupplied,
            startsAt: now,
            endsAt: res.newEndsAt,
            durationDays: prior.durationDays,
            status: 'active',
            supersedesOrderId: prior.id,
            prescriberDoctorId: args.doctorId,
            createdByUserId: args.authorUserId,
            signedAt: now,
            roundNoteId: roundId,
          });

          // 2. Mark prior order superseded referencing newOrderId
          await tx
            .update(ipdMedicationOrders)
            .set({
              status: 'superseded',
              supersededByOrderId: newOrderId,
              updatedAt: now,
            })
            .where(eq(ipdMedicationOrders.id, prior.id));

          // Action audit row
          await tx.insert(ipdMedicationOrderActions).values({
            hospitalId: args.hospitalId,
            orderId: newOrderId,
            action: 'renew',
            reason: res.reason ?? 'Order renewed with extended duration',
            actorUserId: args.authorUserId,
            doctorId: args.doctorId,
            occurredAt: now,
          });

          signedOrderIds.push(newOrderId);
        }

        if (res.type === 'modify') {
          const [prior] = await tx
            .select()
            .from(ipdMedicationOrders)
            .where(eq(ipdMedicationOrders.id, res.orderId));
          if (!prior) throw new Error(`Order ${res.orderId} not found`);

          const newOrderId = crypto.randomUUID();

          const mod = res.modifiedOrder;

          let resolvedMedicineId = prior.medicineId;
          if (mod.medicineId || (mod.medicineName && mod.medicineName !== prior.medicineName)) {
            resolvedMedicineId = await resolveMedicineIdInTx(tx, {
              hospitalId: args.hospitalId,
              medicineId: mod.medicineId,
              medicineName: mod.medicineName ?? prior.medicineName,
              strength: mod.strength !== undefined ? mod.strength : prior.strength,
              form: mod.form !== undefined ? mod.form : prior.form,
              unit: mod.doseUnit ?? prior.doseUnit,
              actorUserId: args.authorUserId,
            });
          }

          // 1. Insert successor order first so newOrderId exists for the foreign key
          await tx.insert(ipdMedicationOrders).values({
            id: newOrderId,
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            orderChainId: prior.orderChainId,
            medicineId: resolvedMedicineId,
            medicineName: mod.medicineName ?? prior.medicineName,
            strength: mod.strength !== undefined ? mod.strength : prior.strength,
            form: mod.form !== undefined ? mod.form : prior.form,
            doseAmount: mod.doseAmount ?? prior.doseAmount,
            doseUnit: mod.doseUnit ?? prior.doseUnit,
            route: mod.route ?? prior.route,
            scheduleType: mod.scheduleType ?? prior.scheduleType,
            frequencyCode: mod.frequencyCode !== undefined ? mod.frequencyCode : prior.frequencyCode,
            scheduleTimes: mod.scheduleTimes ?? prior.scheduleTimes,
            isPrn: mod.isPrn !== undefined ? mod.isPrn : prior.isPrn,
            prnIndication: mod.prnIndication !== undefined ? mod.prnIndication : prior.prnIndication,
            prnMaxDailyDoses: mod.prnMaxDailyDoses !== undefined ? mod.prnMaxDailyDoses : prior.prnMaxDailyDoses,
            prnMaxDailyQuantity: mod.prnMaxDailyQuantity !== undefined ? mod.prnMaxDailyQuantity : prior.prnMaxDailyQuantity,
            prnMaxDailyUnit: mod.prnMaxDailyUnit !== undefined ? mod.prnMaxDailyUnit : prior.prnMaxDailyUnit,
            prnMinIntervalHours: mod.prnMinIntervalHours !== undefined ? mod.prnMinIntervalHours : prior.prnMinIntervalHours,
            specialInstructions: mod.specialInstructions !== undefined ? mod.specialInstructions : prior.specialInstructions,
            origin: prior.origin,
            patientSupplied: prior.patientSupplied,
            startsAt: mod.startsAt ?? now,
            endsAt: mod.endsAt !== undefined ? mod.endsAt : prior.endsAt,
            durationDays: mod.durationDays !== undefined ? mod.durationDays : prior.durationDays,
            status: 'active',
            supersedesOrderId: prior.id,
            prescriberDoctorId: args.doctorId,
            createdByUserId: args.authorUserId,
            signedAt: now,
            roundNoteId: roundId,
          });

          // 2. Mark prior order superseded referencing newOrderId
          await tx
            .update(ipdMedicationOrders)
            .set({
              status: 'superseded',
              supersededByOrderId: newOrderId,
              updatedAt: now,
            })
            .where(eq(ipdMedicationOrders.id, prior.id));

          await tx.insert(ipdMedicationOrderActions).values({
            hospitalId: args.hospitalId,
            orderId: newOrderId,
            action: 'modify',
            reason: res.reason ?? 'Order modified with updated instructions',
            actorUserId: args.authorUserId,
            doctorId: args.doctorId,
            occurredAt: now,
          });

          signedOrderIds.push(newOrderId);
        }

        if (res.type === 'hold') {
          const [order] = await tx
            .select()
            .from(ipdMedicationOrders)
            .where(eq(ipdMedicationOrders.id, res.orderId));
          if (!order) throw new Error(`Order ${res.orderId} not found`);

          const check = validateOrderTransition({
            currentStatus: order.status,
            action: 'hold',
            reason: res.reason,
            now,
          });
          if (!check.valid) throw new Error(check.error);

          await tx
            .update(ipdMedicationOrders)
            .set({ status: 'on_hold', updatedAt: now })
            .where(eq(ipdMedicationOrders.id, order.id));

          await tx.insert(ipdMedicationOrderActions).values({
            hospitalId: args.hospitalId,
            orderId: order.id,
            action: 'hold',
            reason: res.reason,
            actorUserId: args.authorUserId,
            doctorId: args.doctorId,
            occurredAt: now,
          });
        }

        if (res.type === 'discontinue') {
          const [order] = await tx
            .select()
            .from(ipdMedicationOrders)
            .where(eq(ipdMedicationOrders.id, res.orderId));
          if (!order) throw new Error(`Order ${res.orderId} not found`);

          const check = validateOrderTransition({
            currentStatus: order.status,
            action: 'discontinue',
            reason: res.reason,
            now,
          });
          if (!check.valid) throw new Error(check.error);

          await tx
            .update(ipdMedicationOrders)
            .set({ status: 'discontinued', updatedAt: now })
            .where(eq(ipdMedicationOrders.id, order.id));

          await tx.insert(ipdMedicationOrderActions).values({
            hospitalId: args.hospitalId,
            orderId: order.id,
            action: 'discontinue',
            reason: res.reason,
            actorUserId: args.authorUserId,
            doctorId: args.doctorId,
            occurredAt: now,
          });
        }

        if (res.type === 'new') {
          const o = res.order;
          const resolvedMedicineId = await resolveMedicineIdInTx(tx, {
            hospitalId: args.hospitalId,
            medicineId: o.medicineId,
            medicineName: o.medicineName,
            strength: o.strength,
            form: o.form,
            unit: o.doseUnit,
            actorUserId: args.authorUserId,
          });

          const newOrderId = crypto.randomUUID();
          await tx.insert(ipdMedicationOrders).values({
            id: newOrderId,
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            orderChainId: crypto.randomUUID(),
            medicineId: resolvedMedicineId,
            medicineName: o.medicineName,
            strength: o.strength ?? null,
            form: o.form ?? null,
            doseAmount: o.doseAmount,
            doseUnit: o.doseUnit,
            route: o.route,
            scheduleType: o.scheduleType,
            frequencyCode: o.frequencyCode ?? null,
            scheduleTimes: o.scheduleTimes ?? [],
            isPrn: o.isPrn !== undefined ? o.isPrn : o.scheduleType === 'prn',
            prnIndication: o.prnIndication ?? null,
            prnMaxDailyDoses: o.prnMaxDailyDoses ?? null,
            prnMaxDailyQuantity: o.prnMaxDailyQuantity ?? null,
            prnMaxDailyUnit: o.prnMaxDailyUnit ?? null,
            prnMinIntervalHours: o.prnMinIntervalHours ?? null,
            specialInstructions: o.specialInstructions ?? null,
            startsAt: o.startsAt ?? now,
            endsAt: o.endsAt ?? null,
            durationDays: o.durationDays ?? null,
            status: 'active',
            prescriberDoctorId: args.doctorId,
            createdByUserId: args.authorUserId,
            signedAt: now,
            roundNoteId: roundId,
          });

          await tx.insert(ipdMedicationOrderActions).values({
            hospitalId: args.hospitalId,
            orderId: newOrderId,
            action: 'sign',
            actorUserId: args.authorUserId,
            doctorId: args.doctorId,
            occurredAt: now,
          });

          signedOrderIds.push(newOrderId);
        }
      }

      return { roundId, signedOrderIds };
    },
    { clinical: true },
  );
}

/**
 * Handles single-order ad-hoc hold, resume, or discontinue events between rounds.
 */
export async function executeOrderAction(args: {
  hospitalId: string;
  orderId: string;
  action: 'hold' | 'resume' | 'discontinue';
  reason: string;
  actorUserId: string;
  doctorId?: string;
}): Promise<{ success: boolean; nextStatus: string }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const [order] = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.id, args.orderId),
          ),
        );

      if (!order) throw new Error('Order not found');

      const now = new Date();
      const transition = validateOrderTransition({
        currentStatus: order.status,
        action: args.action,
        reason: args.reason,
        now,
      });

      if (!transition.valid || !transition.nextStatus) {
        throw new Error(transition.error ?? 'Invalid state transition');
      }

      await tx
        .update(ipdMedicationOrders)
        .set({
          status: transition.nextStatus as any,
          updatedAt: now,
        })
        .where(eq(ipdMedicationOrders.id, order.id));

      await tx.insert(ipdMedicationOrderActions).values({
        hospitalId: args.hospitalId,
        orderId: order.id,
        action: args.action,
        reason: args.reason,
        actorUserId: args.actorUserId,
        doctorId: args.doctorId ?? null,
        occurredAt: now,
      });

      return { success: true, nextStatus: transition.nextStatus };
    },
    { clinical: true },
  );
}

/**
 * Voids an erroneous order entry and records an audit trail.
 */
export async function voidOrder(args: {
  hospitalId: string;
  orderId: string;
  reason: string;
  actorUserId: string;
}): Promise<{ success: boolean }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const [order] = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.id, args.orderId),
          ),
        );

      if (!order) throw new Error('Order not found');

      const now = new Date();
      const transition = validateOrderTransition({
        currentStatus: order.status,
        action: 'void',
        reason: args.reason,
        now,
      });

      if (!transition.valid) {
        throw new Error(transition.error ?? 'Cannot void order');
      }

      await tx
        .update(ipdMedicationOrders)
        .set({
          status: 'voided',
          voidedAt: now,
          voidedByUserId: args.actorUserId,
          voidReason: args.reason,
          updatedAt: now,
        })
        .where(eq(ipdMedicationOrders.id, order.id));

      await tx.insert(ipdMedicationOrderActions).values({
        hospitalId: args.hospitalId,
        orderId: order.id,
        action: 'void',
        reason: args.reason,
        actorUserId: args.actorUserId,
        occurredAt: now,
      });

      return { success: true };
    },
    { clinical: true },
  );
}

/**
 * Adjusts schedule administration times for an active medication order.
 * Records clinical rationale and preserves audit trail for prescriber visibility.
 */
export async function adjustMedicationScheduleTimes(args: {
  hospitalId: string;
  orderId: string;
  newScheduleTimes: string[];
  reason: string;
  actorUserId: string;
}): Promise<{ success: boolean; orderId: string; newScheduleTimes: string[] }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const [order] = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.id, args.orderId),
          ),
        );

      if (!order) throw new Error('Order not found');
      if (order.status !== 'active') throw new Error(`Cannot adjust schedule times on a ${order.status} order`);

      if (!args.newScheduleTimes || args.newScheduleTimes.length === 0) {
        throw new Error('At least one schedule time slot is required');
      }

      if (!args.reason || args.reason.trim().length < 3) {
        throw new Error('A clinical reason of at least 3 characters is required to adjust timings');
      }

      const now = new Date();
      const oldTimes = (order.scheduleTimes as string[]) || [];
      const auditNote = `[Timing adjusted: from [${oldTimes.join(', ')}] to [${args.newScheduleTimes.join(', ')}]. Reason: ${args.reason.trim()}]`;

      const existingInstructions = order.specialInstructions ? `${order.specialInstructions}\n` : '';
      const updatedInstructions = `${existingInstructions}${auditNote}`;

      const newOrderId = crypto.randomUUID();

      // 1. Insert successor order first with updated schedule times so newOrderId exists
      await tx.insert(ipdMedicationOrders).values({
        id: newOrderId,
        hospitalId: args.hospitalId,
        admissionId: order.admissionId,
        encounterId: order.encounterId,
        patientId: order.patientId,
        orderChainId: order.orderChainId,
        medicineId: order.medicineId,
        medicineName: order.medicineName,
        strength: order.strength,
        form: order.form,
        doseAmount: order.doseAmount,
        doseUnit: order.doseUnit,
        route: order.route,
        scheduleType: order.scheduleType,
        frequencyCode: order.frequencyCode,
        scheduleTimes: args.newScheduleTimes,
        isPrn: order.isPrn,
        prnIndication: order.prnIndication,
        prnMaxDailyDoses: order.prnMaxDailyDoses,
        prnMaxDailyQuantity: order.prnMaxDailyQuantity,
        prnMaxDailyUnit: order.prnMaxDailyUnit,
        prnMinIntervalHours: order.prnMinIntervalHours,
        specialInstructions: updatedInstructions,
        origin: order.origin,
        patientSupplied: order.patientSupplied,
        startsAt: order.startsAt,
        endsAt: order.endsAt,
        durationDays: order.durationDays,
        status: 'active',
        supersedesOrderId: order.id,
        prescriberDoctorId: order.prescriberDoctorId,
        createdByUserId: args.actorUserId,
        signedAt: now,
        roundNoteId: order.roundNoteId,
      });

      // 2. Mark prior order superseded referencing newOrderId
      await tx
        .update(ipdMedicationOrders)
        .set({
          status: 'superseded',
          supersededByOrderId: newOrderId,
          updatedAt: now,
        })
        .where(eq(ipdMedicationOrders.id, order.id));

      // 3. Action audit row
      await tx.insert(ipdMedicationOrderActions).values({
        hospitalId: args.hospitalId,
        orderId: newOrderId,
        action: 'modify',
        reason: `Timing adjusted: ${args.reason.trim()}`,
        actorUserId: args.actorUserId,
        doctorId: order.prescriberDoctorId,
        occurredAt: now,
      });

      return {
        success: true,
        orderId: newOrderId,
        newScheduleTimes: args.newScheduleTimes,
      };
    },
    { clinical: true },
  );
}

/**
 * Lists pending verbal medication orders awaiting doctor co-signature.
 */
export async function listPendingVerbalOrders(args: {
  hospitalId: string;
  admissionId?: string;
}): Promise<SelectIpdMedicationOrder[]> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const orders = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            args.admissionId ? eq(ipdMedicationOrders.admissionId, args.admissionId) : undefined,
            eq(ipdMedicationOrders.isVerbal, true),
            eq(ipdMedicationOrders.verbalOrderStatus, 'pending_cosign'),
          ),
        )
        .orderBy(desc(ipdMedicationOrders.createdAt));
      return orders;
    },
    { clinical: true },
  );
}

/**
 * Co-signs a verbal order by the attending physician.
 */
export async function cosignVerbalOrder(args: {
  hospitalId: string;
  orderId: string;
  doctorId: string;
  actorUserId: string;
  notes?: string;
}): Promise<{ ok: boolean }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const [order] = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.id, args.orderId),
          ),
        );
      if (!order) throw new Error('Order not found');
      if (order.verbalOrderStatus !== 'pending_cosign') {
        throw new Error('Order is not in pending_cosign state');
      }

      const now = new Date();
      await tx
        .update(ipdMedicationOrders)
        .set({
          verbalOrderStatus: 'cosigned',
          cosignedByDoctorId: args.doctorId,
          cosignedAt: now,
          cosignNotes: args.notes?.trim() || null,
          updatedAt: now,
        })
        .where(eq(ipdMedicationOrders.id, order.id));

      await tx.insert(clinicalAuditLogs).values({
        hospitalId: args.hospitalId,
        tableName: 'ipd_medication_orders',
        recordId: order.id,
        action: 'VERBAL_ORDER_COSIGNED',
        newValue: {
          doctorId: args.doctorId,
          notes: args.notes,
          cosignedAt: now.toISOString(),
        },
        reason: args.notes || 'Verbal order co-signed by physician',
        userId: args.actorUserId,
      });

      return { ok: true };
    },
    { clinical: true },
  );
}

/**
 * Rejects a verbal order with a mandatory clinical rationale.
 */
export async function rejectVerbalOrder(args: {
  hospitalId: string;
  orderId: string;
  doctorId: string;
  actorUserId: string;
  rejectionReason: string;
}): Promise<{ ok: boolean }> {
  if (!args.rejectionReason || args.rejectionReason.trim().length < 5) {
    throw new Error('A clinical rationale (at least 5 characters) is required to reject a verbal order');
  }

  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const [order] = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.id, args.orderId),
          ),
        );
      if (!order) throw new Error('Order not found');
      if (order.verbalOrderStatus !== 'pending_cosign') {
        throw new Error('Order is not in pending_cosign state');
      }

      const now = new Date();
      await tx
        .update(ipdMedicationOrders)
        .set({
          verbalOrderStatus: 'rejected',
          status: 'discontinued',
          updatedAt: now,
        })
        .where(eq(ipdMedicationOrders.id, order.id));

      await tx.insert(clinicalAuditLogs).values({
        hospitalId: args.hospitalId,
        tableName: 'ipd_medication_orders',
        recordId: order.id,
        action: 'VERBAL_ORDER_REJECTED',
        newValue: {
          doctorId: args.doctorId,
          rejectionReason: args.rejectionReason,
        },
        reason: args.rejectionReason,
        userId: args.actorUserId,
      });

      return { ok: true };
    },
    { clinical: true },
  );
}


