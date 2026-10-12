import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  ipdMedicationOrders,
  ipdMedicationAdministrations,
  ipdEmarIntegrationOutbox,
  medicineRiskClasses,
  type SelectIpdMedicationOrder,
  type SelectIpdMedicationAdministration,
} from '@/lib/db/schema';
import {
  generateScheduleOccurrences,
  categorizeDueWindow,
} from '@/lib/domain/ipd-schedule';
import { checkPrnEligibility } from '@/lib/domain/ipd-prn';

export interface RecordAdministrationInput {
  clientId: string;
  scheduledTime?: Date | null;
  actualTime?: Date | null;
  doseAmount: string;
  doseGiven: string;
  routeGiven: string;
  clinicalNote?: string | null;
  notes?: string | null;
  recordedChannel?: 'personal' | 'ward_device' | null;
  recordedDeviceId?: string | null;
}

export interface RecordExceptionInput {
  clientId: string;
  scheduledTime?: Date | null;
  outcome: 'omitted' | 'refused' | 'held';
  nonAdminReason: string;
  clinicalNote?: string | null;
  recordedChannel?: 'personal' | 'ward_device' | null;
  recordedDeviceId?: string | null;
}

export interface BedsideDueItem {
  orderId: string;
  orderChainId: string;
  medicineId: string;
  medicineName: string;
  doseAmount: string;
  doseUnit: string;
  route: string;
  scheduleType: string;
  scheduledTime: Date;
  status: 'overdue' | 'dueNow' | 'upcoming';
  instructions?: string | null;
}

export interface BedsidePrnItem {
  orderId: string;
  orderChainId: string;
  medicineId: string;
  medicineName: string;
  doseAmount: string;
  doseUnit: string;
  route: string;
  prnIndication?: string | null;
  prnMinIntervalHours?: number | null;
  prnMaxDailyDoses?: number | null;
  prnMaxDailyQuantity?: string | null;
  prnMaxDailyUnit?: string | null;
  eligibility: {
    eligible: boolean;
    reason?: string;
    nextEligibleAt?: Date;
    dosesRemainingToday?: number;
    quantityRemainingToday?: number;
  };
}

export interface BedsideEmarView {
  dueNow: BedsideDueItem[];
  overdue: BedsideDueItem[];
  upcoming: BedsideDueItem[];
  prn: BedsidePrnItem[];
  onHold: SelectIpdMedicationOrder[];
  recentHistory: SelectIpdMedicationAdministration[];
}

export interface AdministrationResult {
  ok: true;
  administrationId: string;
}

/**
 * Evaluates active and held orders for an admitted patient and categorizes
 * them into bedside eMAR view buckets.
 */
export async function getBedsideEmar(args: {
  hospitalId: string;
  admissionId: string;
  targetTime?: Date;
  windowMinutes?: number;
}): Promise<BedsideEmarView> {
  const target = args.targetTime ?? new Date();

  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      // 1. Fetch active and held orders
      const orders = await tx
        .select()
        .from(ipdMedicationOrders)
        .where(
          and(
            eq(ipdMedicationOrders.hospitalId, args.hospitalId),
            eq(ipdMedicationOrders.admissionId, args.admissionId),
            inArray(ipdMedicationOrders.status, ['active', 'on_hold']),
          ),
        );

      const activeOrders = orders.filter((o) => o.status === 'active');
      const onHold = orders.filter((o) => o.status === 'on_hold');

      // 2. Fetch recent administrations in past 24 hours for this admission
      const yesterday = new Date(target.getTime() - 24 * 60 * 60 * 1000);
      const recentHistory = await tx
        .select()
        .from(ipdMedicationAdministrations)
        .where(
          and(
            eq(ipdMedicationAdministrations.hospitalId, args.hospitalId),
            eq(ipdMedicationAdministrations.admissionId, args.admissionId),
            gte(ipdMedicationAdministrations.recordedAt, yesterday),
          ),
        )
        .orderBy(desc(ipdMedicationAdministrations.recordedAt));

      // Map existing scheduled administrations: key = `${orderId}:${scheduledTime.toISOString()}`
      const existingScheduledSlots = new Set<string>();
      for (const admin of recentHistory) {
        if (admin.scheduledTime && !admin.voidedAt) {
          existingScheduledSlots.add(`${admin.orderId}:${new Date(admin.scheduledTime).toISOString()}`);
        }
      }

      const dueNow: BedsideDueItem[] = [];
      const overdue: BedsideDueItem[] = [];
      const upcoming: BedsideDueItem[] = [];
      const prn: BedsidePrnItem[] = [];

      // Window for generating scheduled occurrences: from 12 hours ago to 12 hours ahead
      const windowStart = new Date(target.getTime() - 12 * 60 * 60 * 1000);
      const windowEnd = new Date(target.getTime() + 12 * 60 * 60 * 1000);

      for (const order of activeOrders) {
        if (order.scheduleType === 'prn' || order.isPrn) {
          // Fetch administrations across the same order chain
          const chainAdmins = await tx
            .select()
            .from(ipdMedicationAdministrations)
            .where(
              and(
                eq(ipdMedicationAdministrations.hospitalId, args.hospitalId),
                eq(ipdMedicationAdministrations.orderChainId, order.orderChainId),
                isNull(ipdMedicationAdministrations.voidedAt),
                eq(ipdMedicationAdministrations.outcome, 'administered'),
              ),
            );

          const eligibility = checkPrnEligibility({
            order: {
              prnMinIntervalHours: order.prnMinIntervalHours ?? undefined,
              prnMaxDailyDoses: order.prnMaxDailyDoses ?? undefined,
              prnMaxDailyQuantity: order.prnMaxDailyQuantity ? Number(order.prnMaxDailyQuantity) : undefined,
              prnMaxDailyUnit: order.prnMaxDailyUnit ?? undefined,
            },
            history: chainAdmins.map((a) => ({
              actualTime: a.actualTime ?? a.recordedAt,
              doseAmountNumeric: Number(a.doseAmountNumeric ?? 0),
              voidedAt: a.voidedAt,
            })),
            requestedAt: target,
          });

          prn.push({
            orderId: order.id,
            orderChainId: order.orderChainId,
            medicineId: order.medicineId,
            medicineName: order.medicineName,
            doseAmount: String(order.doseAmount),
            doseUnit: order.doseUnit,
            route: order.route,
            prnIndication: order.prnIndication,
            prnMinIntervalHours: order.prnMinIntervalHours,
            prnMaxDailyDoses: order.prnMaxDailyDoses,
            prnMaxDailyQuantity: order.prnMaxDailyQuantity ? String(order.prnMaxDailyQuantity) : null,
            prnMaxDailyUnit: order.prnMaxDailyUnit,
            eligibility,
          });
          continue;
        }

        if (order.scheduleType === 'stat') {
          // Check if stat dose was already administered or excepted
          const statAdmin = recentHistory.find((a) => a.orderId === order.id && !a.voidedAt);
          if (!statAdmin) {
            dueNow.push({
              orderId: order.id,
              orderChainId: order.orderChainId,
              medicineId: order.medicineId,
              medicineName: order.medicineName,
              doseAmount: String(order.doseAmount),
              doseUnit: order.doseUnit,
              route: order.route,
              scheduleType: 'stat',
              scheduledTime: target,
              status: 'dueNow',
              instructions: order.specialInstructions,
            });
          }
          continue;
        }

        // Scheduled order: generate occurrences
        const occurrences = generateScheduleOccurrences({
          scheduleType: order.scheduleType,
          scheduleTimes: (order.scheduleTimes as string[]) ?? [],
          startsAt: order.startsAt,
          endsAt: order.endsAt ?? undefined,
          windowStart,
          windowEnd,
        });

        for (const occ of occurrences) {
          const slotKey = `${order.id}:${occ.toISOString()}`;
          if (existingScheduledSlots.has(slotKey)) {
            continue; // Already administered
          }

          const cat = categorizeDueWindow({
            scheduledTime: occ,
            targetTime: target,
            windowMinutes: args.windowMinutes ?? 60,
          });

          const item: BedsideDueItem = {
            orderId: order.id,
            orderChainId: order.orderChainId,
            medicineId: order.medicineId,
            medicineName: order.medicineName,
            doseAmount: String(order.doseAmount),
            doseUnit: order.doseUnit,
            route: order.route,
            scheduleType: order.scheduleType,
            scheduledTime: occ,
            status: cat,
            instructions: order.specialInstructions,
          };

          if (cat === 'dueNow') {
            dueNow.push(item);
          } else if (cat === 'overdue') {
            overdue.push(item);
          } else {
            upcoming.push(item);
          }
        }
      }

      // Sort by scheduledTime ascending
      dueNow.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime());
      overdue.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime());
      upcoming.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime());

      return {
        dueNow,
        overdue,
        upcoming,
        prn,
        onHold,
        recentHistory,
      };
    },
    { clinical: true },
  );
}

/**
 * Records a verified medication administration event at the patient's bedside.
 * Acquires transactional advisory lock for PRN orders, transitions stat orders to completed,
 * and enqueues outbox integration events in the same transaction.
 */
export async function recordAdministration(args: {
  hospitalId: string;
  admissionId: string;
  orderId: string;
  input: RecordAdministrationInput;
  actorUserId: string;
}): Promise<AdministrationResult> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      // 1. Idempotency check: if client_id already exists, return existing record
      const existing = await tx
        .select({ id: ipdMedicationAdministrations.id })
        .from(ipdMedicationAdministrations)
        .where(
          and(
            eq(ipdMedicationAdministrations.hospitalId, args.hospitalId),
            eq(ipdMedicationAdministrations.clientId, args.input.clientId),
          ),
        );

      if (existing.length > 0) {
        return { ok: true, administrationId: existing[0].id };
      }

      // 2. Fetch order and verify it is active
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
      if (order.status !== 'active') throw new Error(`Cannot administer ${order.status} order`);

      const now = new Date();
      if (order.endsAt && now > order.endsAt) {
        throw new Error('Order has expired past its treatment duration');
      }

      // 3. If PRN order, acquire transaction advisory lock and validate eligibility
      if (order.scheduleType === 'prn' || order.isPrn) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('ipd_prn_chain:' || ${order.orderChainId}::text))`,
        );

        const history = await tx
          .select()
          .from(ipdMedicationAdministrations)
          .where(
            and(
              eq(ipdMedicationAdministrations.hospitalId, args.hospitalId),
              eq(ipdMedicationAdministrations.orderChainId, order.orderChainId),
              isNull(ipdMedicationAdministrations.voidedAt),
              eq(ipdMedicationAdministrations.outcome, 'administered'),
            ),
          );

        const eligibility = checkPrnEligibility({
          order: {
            prnMinIntervalHours: order.prnMinIntervalHours ?? undefined,
            prnMaxDailyDoses: order.prnMaxDailyDoses ?? undefined,
            prnMaxDailyQuantity: order.prnMaxDailyQuantity ? Number(order.prnMaxDailyQuantity) : undefined,
            prnMaxDailyUnit: order.prnMaxDailyUnit ?? undefined,
          },
          history: history.map((a) => ({
            actualTime: a.actualTime ?? a.recordedAt,
            doseAmountNumeric: Number(a.doseAmountNumeric ?? 0),
            voidedAt: a.voidedAt,
          })),
          requestedAt: args.input.actualTime ?? now,
          proposedDoseAmount: Number(args.input.doseAmount),
        });

        if (!eligibility.eligible) {
          throw new Error(`PRN order not eligible: ${eligibility.reason}`);
        }
      }

      // 4. Insert administration record
      const actualTime = args.input.actualTime ?? now;
      const [admin] = await tx
        .insert(ipdMedicationAdministrations)
        .values({
          hospitalId: args.hospitalId,
          admissionId: args.admissionId,
          orderId: order.id,
          orderChainId: order.orderChainId,
          clientId: args.input.clientId,
          scheduledTime: args.input.scheduledTime ?? null,
          actualTime,
          outcome: 'administered',
          doseAmountNumeric: args.input.doseAmount,
          doseGiven: args.input.doseGiven,
          routeGiven: args.input.routeGiven,
          clinicalNote: args.input.clinicalNote ?? args.input.notes ?? null,
          nurseUserId: args.actorUserId,
          recordedChannel: args.input.recordedChannel ?? null,
          recordedDeviceId: args.input.recordedDeviceId ?? null,
        })
        .returning({ id: ipdMedicationAdministrations.id });

      const adminId = admin.id;

      // 5. If stat order, immediately transition order to completed
      if (order.scheduleType === 'stat') {
        await tx
          .update(ipdMedicationOrders)
          .set({ status: 'completed', updatedAt: now })
          .where(eq(ipdMedicationOrders.id, order.id));
      }

      // 6. Enqueue outbox integration events
      if (!order.patientSupplied) {
        await tx.insert(ipdEmarIntegrationOutbox).values({
          hospitalId: args.hospitalId,
          administrationId: adminId,
          integrationType: 'billing',
          eventType: 'administer',
          payload: {
            administrationId: adminId,
            medicineId: order.medicineId,
            admissionId: order.admissionId,
            encounterId: order.encounterId,
            patientId: order.patientId,
            quantity: 1,
            doseAmount: args.input.doseAmount,
            doseUnit: order.doseUnit,
          },
          status: 'pending',
        });
      }

      // Check if medicine is risk-class
      const [riskClass] = await tx
        .select()
        .from(medicineRiskClasses)
        .where(
          and(
            eq(medicineRiskClasses.hospitalId, args.hospitalId),
            eq(medicineRiskClasses.medicineId, order.medicineId),
          ),
        );

      if (riskClass) {
        await tx.insert(ipdEmarIntegrationOutbox).values({
          hospitalId: args.hospitalId,
          administrationId: adminId,
          integrationType: 'stock',
          eventType: 'administer',
          payload: {
            administrationId: adminId,
            medicineId: order.medicineId,
            quantity: 1,
          },
          status: 'pending',
        });
      }

      return { ok: true, administrationId: adminId };
    },
    { clinical: true },
  );
}

/**
 * Records an omitted, refused, or held administration exception.
 */
export async function recordException(args: {
  hospitalId: string;
  admissionId: string;
  orderId: string;
  input: RecordExceptionInput;
  actorUserId: string;
}): Promise<AdministrationResult> {
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

      if (!args.input.nonAdminReason || args.input.nonAdminReason.trim().length < 3) {
        throw new Error('A structured reason (at least 3 characters) is required for non-administration');
      }

      const now = new Date();
      const [admin] = await tx
        .insert(ipdMedicationAdministrations)
        .values({
          hospitalId: args.hospitalId,
          admissionId: args.admissionId,
          orderId: order.id,
          orderChainId: order.orderChainId,
          clientId: args.input.clientId,
          scheduledTime: args.input.scheduledTime ?? null,
          actualTime: null,
          decisionTime: now,
          outcome: args.input.outcome,
          nonAdminReason: args.input.nonAdminReason,
          clinicalNote: args.input.clinicalNote ?? null,
          nurseUserId: args.actorUserId,
          recordedChannel: args.input.recordedChannel ?? null,
          recordedDeviceId: args.input.recordedDeviceId ?? null,
        })
        .returning({ id: ipdMedicationAdministrations.id });

      return { ok: true, administrationId: admin.id };
    },
    { clinical: true },
  );
}

/**
 * Voids an erroneous administration and dispatches a void event to outbox.
 */
export async function voidAdministration(args: {
  hospitalId: string;
  administrationId: string;
  reason: string;
  actorUserId: string;
}): Promise<{ success: boolean }> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const [admin] = await tx
        .select()
        .from(ipdMedicationAdministrations)
        .where(
          and(
            eq(ipdMedicationAdministrations.hospitalId, args.hospitalId),
            eq(ipdMedicationAdministrations.id, args.administrationId),
          ),
        );

      if (!admin) throw new Error('Administration record not found');
      if (admin.voidedAt) throw new Error('Administration is already voided');

      if (!args.reason || args.reason.trim().length < 3) {
        throw new Error('A structured reason (at least 3 characters) is required to void');
      }

      const now = new Date();
      await tx
        .update(ipdMedicationAdministrations)
        .set({
          voidedAt: now,
          voidReason: args.reason,
          voidedByUserId: args.actorUserId,
        })
        .where(eq(ipdMedicationAdministrations.id, admin.id));

      // Enqueue void outbox event
      await tx.insert(ipdEmarIntegrationOutbox).values({
        hospitalId: args.hospitalId,
        administrationId: admin.id,
        integrationType: 'billing',
        eventType: 'void',
        payload: {
          administrationId: admin.id,
          voidReason: args.reason,
        },
        status: 'pending',
      });

      return { success: true };
    },
    { clinical: true },
  );
}

/**
 * Corrects an administration record by voiding the prior entry and creating
 * a linked replacement record in one transaction.
 */
export async function correctAdministration(args: {
  hospitalId: string;
  administrationId: string;
  correctedInput: RecordAdministrationInput;
  reason: string;
  actorUserId: string;
}): Promise<AdministrationResult> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const [oldAdmin] = await tx
        .select()
        .from(ipdMedicationAdministrations)
        .where(
          and(
            eq(ipdMedicationAdministrations.hospitalId, args.hospitalId),
            eq(ipdMedicationAdministrations.id, args.administrationId),
          ),
        );

      if (!oldAdmin) throw new Error('Original administration record not found');
      if (oldAdmin.voidedAt) throw new Error('Cannot correct an already-voided record');

      const now = new Date();
      const newAdminId = crypto.randomUUID();

      // 1. Insert corrected administration record first
      await tx.insert(ipdMedicationAdministrations).values({
        id: newAdminId,
        hospitalId: args.hospitalId,
        admissionId: oldAdmin.admissionId,
        orderId: oldAdmin.orderId,
        orderChainId: oldAdmin.orderChainId,
        clientId: args.correctedInput.clientId,
        scheduledTime: oldAdmin.scheduledTime,
        actualTime: args.correctedInput.actualTime ?? now,
        outcome: 'administered',
        doseAmountNumeric: args.correctedInput.doseAmount,
        doseGiven: args.correctedInput.doseGiven,
        routeGiven: args.correctedInput.routeGiven,
        clinicalNote: args.correctedInput.clinicalNote ?? null,
        nurseUserId: args.actorUserId,
        recordedChannel: args.correctedInput.recordedChannel ?? null,
        recordedDeviceId: args.correctedInput.recordedDeviceId ?? null,
        correctsAdministrationId: oldAdmin.id,
      });

      // 2. Void old administration and link replacement
      await tx
        .update(ipdMedicationAdministrations)
        .set({
          voidedAt: now,
          voidReason: args.reason,
          voidedByUserId: args.actorUserId,
          correctedByAdministrationId: newAdminId,
        })
        .where(eq(ipdMedicationAdministrations.id, oldAdmin.id));

      // 3. Enqueue correction outbox event
      await tx.insert(ipdEmarIntegrationOutbox).values({
        hospitalId: args.hospitalId,
        administrationId: newAdminId,
        integrationType: 'billing',
        eventType: 'correction',
        payload: {
          originalAdministrationId: oldAdmin.id,
          correctedAdministrationId: newAdminId,
          correctionReason: args.reason,
        },
        status: 'pending',
      });

      return { ok: true, administrationId: newAdminId };
    },
    { clinical: true },
  );
}
