import { and, desc, eq, inArray } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  ipdClinicalRounds,
  ipdMedicationOrders,
  ipdMedicationOrderActions,
  type SelectIpdMedicationOrder,
  type InsertIpdMedicationOrder,
} from '@/lib/db/schema';
import { validateOrderTransition } from '@/lib/domain/ipd-order-state';

export interface DraftOrderInput {
  medicineId: string;
  medicineName: string;
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
          await tx.insert(ipdMedicationOrders).values({
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            orderChainId: crypto.randomUUID(),
            medicineId: draft.medicineId,
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
}): Promise<{ roundId: string; signedOrderIds: string[] }> {
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

          // 1. Insert successor order first so newOrderId exists for the foreign key
          await tx.insert(ipdMedicationOrders).values({
            id: newOrderId,
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            orderChainId: prior.orderChainId,
            medicineId: mod.medicineId ?? prior.medicineId,
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
          const newOrderId = crypto.randomUUID();
          await tx.insert(ipdMedicationOrders).values({
            id: newOrderId,
            hospitalId: args.hospitalId,
            admissionId: args.admissionId,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            orderChainId: crypto.randomUUID(),
            medicineId: o.medicineId,
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
