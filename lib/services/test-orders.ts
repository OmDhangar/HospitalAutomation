import { createHash } from 'node:crypto';
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  appointments,
  auditLogs,
  bedAssignments,
  beds,
  billItems,
  branches,
  chargeItems,
  doctors,
  hospitals,
  patients,
  servicePointStaff,
  servicePoints,
  staffMemberships,
  testFollowUpCalls,
  testOrders,
  users,
  wards,
} from '@/lib/db/schema';
import { calculateBillItem } from '@/lib/domain/patient-billing';
import type { StaffRole } from '@/lib/domain/permissions';
import {
  OPEN_STATUSES,
  TestOrderError,
  dueAt as computeDueAt,
  emptyPointDay,
  followUpState,
  isClosingOutcome,
  outcomeRefusal,
  summariseDay,
  type CallOutcome,
  type ClockFrom,
  type FollowUpState,
  type Lang,
  type PersonDay,
  type PointDay,
  type ServicePointInput,
  type ServicePointKind,
  type TestOrderStatus,
} from '@/lib/domain/test-orders';
import { serviceDateIn, zonedTimeToUtc } from '@/lib/domain/time';
import { openEncounterForAppointmentInTx } from '@/lib/services/encounters';
import { getOrCreateDraftBillInTx } from '@/lib/services/patient-billing';

/**
 * Test orders and follow-up (IPD sheets plan C4a, Rev 5.1; migration 0047).
 *
 * The doctor orders a test in OPD (from the consultation) or on the ward (the
 * doctor's phone view, which already bills it as a bedside entry). Each test is
 * done at a service point; the service point's assigned staff work its list:
 * call the patient who has not arrived, mark arrival, the test done, and the
 * report added. The owner sees the day per service point and per person.
 *
 * Authorisation of the role is the caller's (`tests.*`); whether a person may
 * work a service point (assigned there, or the owner) is checked here. Every
 * clinical read and write holds the clinical key. The evidence log captures
 * every row (0047's triggers); audit_logs keeps the reasons.
 */

export { TestOrderError };

const clinical = { clinical: true } as const;

async function audit(
  tx: Tx,
  args: { hospitalId: string; actorUserId: string; action: string; objectType: string; objectId: string; metadata?: Record<string, unknown> },
) {
  await tx.insert(auditLogs).values(args);
}

const isUniqueViolation = (err: unknown, constraint: string): boolean => {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23505' && e.constraint_name === constraint) return true;
  }
  return false;
};

/** A client id derived from the form's one-time key and the test: a resubmitted form orders nothing twice. */
export function orderClientId(formKey: string, chargeItemId: string): string {
  const hex = createHash('sha256').update(`test-order:${formKey}:${chargeItemId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/* ============================================================ service points */

export type ServicePointRow = {
  id: string;
  branchId: string;
  branchName: string;
  kind: ServicePointKind;
  name: string;
  nameMr: string | null;
  nameHi: string | null;
  floor: string | null;
  floorMr: string | null;
  floorHi: string | null;
  section: string | null;
  sectionMr: string | null;
  sectionHi: string | null;
  clockFrom: ClockFrom;
  clockMinutes: number;
  active: boolean;
  staff: { userId: string; name: string; role: StaffRole }[];
  tests: number;
};

export async function listServicePoints(hospitalId: string, options: { includeInactive?: boolean } = {}): Promise<ServicePointRow[]> {
  return withTenant(hospitalId, async (tx) => {
    const points = await tx
      .select({
        id: servicePoints.id,
        branchId: servicePoints.branchId,
        branchName: branches.name,
        kind: servicePoints.kind,
        name: servicePoints.name,
        nameMr: servicePoints.nameMr,
        nameHi: servicePoints.nameHi,
        floor: servicePoints.floor,
        floorMr: servicePoints.floorMr,
        floorHi: servicePoints.floorHi,
        section: servicePoints.section,
        sectionMr: servicePoints.sectionMr,
        sectionHi: servicePoints.sectionHi,
        clockFrom: servicePoints.clockFrom,
        clockMinutes: servicePoints.clockMinutes,
        active: servicePoints.active,
      })
      .from(servicePoints)
      .innerJoin(branches, eq(branches.id, servicePoints.branchId))
      .where(options.includeInactive ? undefined : eq(servicePoints.active, true))
      .orderBy(desc(servicePoints.active), asc(servicePoints.name));
    if (points.length === 0) return [];

    const ids = points.map((p) => p.id);
    const [staff, tests] = await Promise.all([
      tx
        .select({ servicePointId: servicePointStaff.servicePointId, userId: users.id, name: users.name, role: staffMemberships.role })
        .from(servicePointStaff)
        .innerJoin(users, eq(users.id, servicePointStaff.userId))
        .innerJoin(staffMemberships, eq(staffMemberships.userId, servicePointStaff.userId))
        .where(and(inArray(servicePointStaff.servicePointId, ids), isNull(servicePointStaff.removedAt)))
        .orderBy(asc(users.name)),
      tx
        .select({ servicePointId: chargeItems.servicePointId, n: sql<number>`count(*)::int` })
        .from(chargeItems)
        .where(and(inArray(chargeItems.servicePointId, ids), eq(chargeItems.active, true)))
        .groupBy(chargeItems.servicePointId),
    ]);
    const counts = new Map(tests.map((t) => [t.servicePointId, t.n]));
    return points.map((p) => ({
      ...p,
      staff: staff.filter((s) => s.servicePointId === p.id).map(({ userId, name, role }) => ({ userId, name, role })),
      tests: counts.get(p.id) ?? 0,
    }));
  });
}

export async function createServicePoint(args: {
  hospitalId: string;
  branchId: string;
  input: ServicePointInput;
  actorUserId: string;
}): Promise<string> {
  try {
    return await withTenant(args.hospitalId, async (tx) => {
      const [branch] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, args.branchId));
      if (!branch) throw new TestOrderError('Branch not found');
      const [row] = await tx
        .insert(servicePoints)
        .values({ hospitalId: args.hospitalId, branchId: args.branchId, ...args.input, createdByUserId: args.actorUserId })
        .returning({ id: servicePoints.id });
      await audit(tx, {
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'tests.service_point_created',
        objectType: 'service_point',
        objectId: row.id,
        metadata: { name: args.input.name, clockFrom: args.input.clockFrom, clockMinutes: args.input.clockMinutes },
      });
      return row.id;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'service_points_name_key')) throw new TestOrderError(`There is already a lab or room called ${args.input.name}`);
    throw err;
  }
}

/**
 * Changes a service point's name, directions or clock. A running clock is not
 * moved: each order keeps the clock it was ordered under.
 */
export async function updateServicePoint(args: {
  hospitalId: string;
  servicePointId: string;
  input: ServicePointInput;
  actorUserId: string;
}): Promise<void> {
  try {
    await withTenant(args.hospitalId, async (tx) => {
      const updated = await tx
        .update(servicePoints)
        .set({ ...args.input, updatedAt: new Date() })
        .where(eq(servicePoints.id, args.servicePointId))
        .returning({ id: servicePoints.id });
      if (updated.length === 0) throw new TestOrderError('Lab or room not found');
      await audit(tx, {
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'tests.service_point_changed',
        objectType: 'service_point',
        objectId: args.servicePointId,
        metadata: { name: args.input.name, clockFrom: args.input.clockFrom, clockMinutes: args.input.clockMinutes },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'service_points_name_key')) throw new TestOrderError(`There is already a lab or room called ${args.input.name}`);
    throw err;
  }
}

export async function setServicePointActive(args: {
  hospitalId: string;
  servicePointId: string;
  active: boolean;
  actorUserId: string;
}): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    const updated = await tx
      .update(servicePoints)
      .set({ active: args.active, updatedAt: new Date() })
      .where(eq(servicePoints.id, args.servicePointId))
      .returning({ id: servicePoints.id });
    if (updated.length === 0) throw new TestOrderError('Lab or room not found');
  });
}

/** Assigns a staff member to a service point. Assigning someone already there does nothing. */
export async function assignStaff(args: { hospitalId: string; servicePointId: string; userId: string; actorUserId: string }): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    const [member] = await tx
      .select({ active: staffMemberships.active })
      .from(staffMemberships)
      .where(and(eq(staffMemberships.userId, args.userId), eq(staffMemberships.hospitalId, args.hospitalId)));
    if (!member?.active) throw new TestOrderError('Choose someone on your staff');
    const [point] = await tx.select({ id: servicePoints.id }).from(servicePoints).where(eq(servicePoints.id, args.servicePointId));
    if (!point) throw new TestOrderError('Lab or room not found');
    await tx
      .insert(servicePointStaff)
      .values({ hospitalId: args.hospitalId, servicePointId: args.servicePointId, userId: args.userId, assignedByUserId: args.actorUserId })
      .onConflictDoNothing({ target: [servicePointStaff.servicePointId, servicePointStaff.userId], where: sql`removed_at is null` });
  });
}

export async function removeStaff(args: { hospitalId: string; servicePointId: string; userId: string; actorUserId: string }): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    await tx
      .update(servicePointStaff)
      .set({ removedAt: new Date(), removedByUserId: args.actorUserId })
      .where(
        and(
          eq(servicePointStaff.servicePointId, args.servicePointId),
          eq(servicePointStaff.userId, args.userId),
          isNull(servicePointStaff.removedAt),
        ),
      );
  });
}

export type TestItemRow = { id: string; name: string; servicePointId: string | null; pricePaise: number | null };

/** The hospital's tests (charge items flagged as tests) and where each is done. */
export async function listTestItems(hospitalId: string): Promise<TestItemRow[]> {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({ id: chargeItems.id, name: chargeItems.name, servicePointId: chargeItems.servicePointId, pricePaise: chargeItems.sellingPricePaise })
      .from(chargeItems)
      .where(and(eq(chargeItems.isTest, true), eq(chargeItems.active, true)))
      .orderBy(asc(chargeItems.name)),
  );
}

/** Says where a test is done. Only items flagged as tests; null takes it off follow-up. */
export async function setTestServicePoint(args: {
  hospitalId: string;
  chargeItemId: string;
  servicePointId: string | null;
  actorUserId: string;
}): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    if (args.servicePointId) {
      const [point] = await tx.select({ id: servicePoints.id }).from(servicePoints).where(eq(servicePoints.id, args.servicePointId));
      if (!point) throw new TestOrderError('Lab or room not found');
    }
    const updated = await tx
      .update(chargeItems)
      .set({ servicePointId: args.servicePointId, updatedAt: new Date() })
      .where(and(eq(chargeItems.id, args.chargeItemId), eq(chargeItems.isTest, true)))
      .returning({ name: chargeItems.name });
    if (updated.length === 0) throw new TestOrderError('Only tests can be sent to a lab or room');
    await audit(tx, {
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'tests.test_placed',
      objectType: 'charge_item',
      objectId: args.chargeItemId,
      metadata: { servicePointId: args.servicePointId },
    });
  });
}

/* ================================================================= ordering */

export type OrderableTest = { id: string; name: string; servicePointId: string; servicePointName: string; pricePaise: number | null };

/** Tests the doctor can send a patient for: flagged as tests, with an open service point. */
export async function listOrderableTests(hospitalId: string): Promise<OrderableTest[]> {
  return withTenant(hospitalId, async (tx) => {
    const rows = await tx
      .select({
        id: chargeItems.id,
        name: chargeItems.name,
        servicePointId: servicePoints.id,
        servicePointName: servicePoints.name,
        pricePaise: chargeItems.sellingPricePaise,
      })
      .from(chargeItems)
      .innerJoin(servicePoints, eq(servicePoints.id, chargeItems.servicePointId))
      .where(and(eq(chargeItems.isTest, true), eq(chargeItems.active, true), eq(servicePoints.active, true)))
      .orderBy(asc(chargeItems.name));
    return rows;
  });
}

type PointClock = { id: string; clockFrom: ClockFrom; clockMinutes: number; active: boolean };

async function testsWithPointsInTx(tx: Tx, chargeItemIds: readonly string[]) {
  const rows = await tx
    .select({
      id: chargeItems.id,
      name: chargeItems.name,
      pricePaise: chargeItems.sellingPricePaise,
      taxRateBp: chargeItems.taxRateBp,
      isTest: chargeItems.isTest,
      active: chargeItems.active,
      point: {
        id: servicePoints.id,
        clockFrom: servicePoints.clockFrom,
        clockMinutes: servicePoints.clockMinutes,
        active: servicePoints.active,
      },
    })
    .from(chargeItems)
    .leftJoin(servicePoints, eq(servicePoints.id, chargeItems.servicePointId))
    .where(inArray(chargeItems.id, [...chargeItemIds]));
  return rows as (Omit<(typeof rows)[number], 'point'> & { point: PointClock | null })[];
}

export type OrderedTest = { orderId: string; testName: string; repeat: boolean };

/**
 * OPD: the doctor sends the patient for tests from the consultation. Each test
 * becomes an order for its service point and, if it has a price, a line on the
 * visit's bill — so the desk's Paid tap takes it, and starts a "from payment"
 * clock. Only the visit's own doctor orders (the owner may, for any visit).
 * A resubmitted form orders nothing twice.
 */
export async function orderOpdTests(args: {
  hospitalId: string;
  appointmentId: string;
  chargeItemIds: readonly string[];
  formKey: string;
  actorUserId: string;
  seeAll: boolean;
  now?: Date;
}): Promise<OrderedTest[]> {
  const ids = [...new Set(args.chargeItemIds)].slice(0, 20);
  if (ids.length === 0) throw new TestOrderError('Tap at least one test');
  const now = args.now ?? new Date();

  try {
    return await withTenant(
      args.hospitalId,
      async (tx) => {
        const [appointment] = await tx
          .select({ id: appointments.id, doctorUserId: doctors.userId })
          .from(appointments)
          .innerJoin(doctors, eq(doctors.id, appointments.doctorId))
          .where(eq(appointments.id, args.appointmentId));
        if (!appointment) throw new TestOrderError('Visit not found');
        if (!args.seeAll && appointment.doctorUserId !== args.actorUserId) {
          throw new TestOrderError('Only the patient’s doctor can send them for tests');
        }

        const tests = await testsWithPointsInTx(tx, ids);
        if (tests.length !== ids.length || tests.some((t) => !t.isTest || !t.active)) {
          throw new TestOrderError('Only tests can be ordered here');
        }
        const unplaced = tests.find((t) => !t.point?.active);
        if (unplaced) throw new TestOrderError(`${unplaced.name} has no lab or room yet. The owner sets it under Settings → Tests.`);

        const encounter = await openEncounterForAppointmentInTx(tx, { appointmentId: args.appointmentId, actorUserId: args.actorUserId });
        if (encounter.stage !== 'opd') throw new TestOrderError('This patient is admitted. Order tests from the IPD view.');

        const results: OrderedTest[] = [];
        for (const test of tests) {
          const clientId = orderClientId(args.formKey, test.id);
          const [existing] = await tx
            .select({ id: testOrders.id })
            .from(testOrders)
            .where(eq(testOrders.clientId, clientId));
          if (existing) {
            results.push({ orderId: existing.id, testName: test.name, repeat: true });
            continue;
          }

          let billItemId: string | null = null;
          if (test.pricePaise !== null) {
            const bill = await getOrCreateDraftBillInTx(tx, { encounter, actorUserId: args.actorUserId });
            const [line] = await tx
              .insert(billItems)
              .values({
                hospitalId: args.hospitalId,
                billId: bill.id,
                itemType: 'service',
                chargeItemId: test.id,
                description: test.name,
                quantity: 1,
                configuredUnitPricePaise: test.pricePaise,
                unitPricePaise: test.pricePaise,
                taxRateBp: test.taxRateBp,
                ...calculateBillItem({ quantity: 1, unitPricePaise: test.pricePaise, taxRateBp: test.taxRateBp }),
                createdByUserId: args.actorUserId,
              })
              .returning({ id: billItems.id });
            billItemId = line.id;
          }

          const point = test.point!;
          const [order] = await tx
            .insert(testOrders)
            .values({
              hospitalId: args.hospitalId,
              branchId: encounter.branchId,
              patientId: encounter.patientId,
              encounterId: encounter.id,
              setting: 'opd',
              appointmentId: args.appointmentId,
              chargeItemId: test.id,
              testName: test.name,
              servicePointId: point.id,
              billItemId,
              clockFrom: point.clockFrom,
              clockMinutes: point.clockMinutes,
              orderedAt: now,
              orderedByUserId: args.actorUserId,
              clientId,
              dueAt: computeDueAt({ clockFrom: point.clockFrom, clockMinutes: point.clockMinutes, orderedAt: now, paidAt: null }),
            })
            .returning({ id: testOrders.id });
          results.push({ orderId: order.id, testName: test.name, repeat: false });
        }
        return results;
      },
      clinical,
    );
  } catch (err) {
    // Two taps of the same form at once: the first saved it; this one reads as a repeat.
    if (isUniqueViolation(err, 'test_orders_client_key')) {
      return orderOpdTests(args);
    }
    throw err;
  }
}

/**
 * IPD: the doctor's phone view has billed each test as a bedside entry; each
 * entry of a test that has a service point becomes its order too. Ward tests
 * always count from the order (the IPD bill is paid at discharge). Once per
 * entry, however often it is retried.
 */
export async function createIpdTestOrders(args: {
  hospitalId: string;
  admissionId: string;
  careEntryIds: readonly string[];
  actorUserId: string;
  now?: Date;
}): Promise<number> {
  if (args.careEntryIds.length === 0) return 0;
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [admission] = await tx
        .select({ id: admissions.id, branchId: admissions.branchId, encounterId: admissions.encounterId, patientId: admissions.patientId })
        .from(admissions)
        .where(eq(admissions.id, args.admissionId));
      if (!admission) throw new TestOrderError('Patient not found');

      const entries = await tx.execute<{
        id: string;
        charge_item_id: string;
        name: string;
        point_id: string;
        clock_minutes: number;
      }>(sql`
        select e.id, e.charge_item_id, ci.name, sp.id as point_id, sp.clock_minutes
        from care_entries e
        join charge_items ci on ci.id = e.charge_item_id and ci.is_test
        join service_points sp on sp.id = ci.service_point_id and sp.active
        where e.id in (${sql.join(args.careEntryIds.map((id) => sql`${id}::uuid`), sql`, `)})
          and e.admission_id = ${args.admissionId}::uuid
          and not exists (select 1 from test_orders o where o.care_entry_id = e.id)
      `);
      if (entries.length === 0) return 0;

      await tx.insert(testOrders).values(
        entries.map((e) => ({
          hospitalId: args.hospitalId,
          branchId: admission.branchId,
          patientId: admission.patientId,
          encounterId: admission.encounterId,
          setting: 'ipd' as const,
          admissionId: admission.id,
          chargeItemId: e.charge_item_id,
          testName: e.name,
          servicePointId: e.point_id,
          careEntryId: e.id,
          clockFrom: 'order' as const,
          clockMinutes: e.clock_minutes,
          orderedAt: now,
          orderedByUserId: args.actorUserId,
          // One order per bedside entry: its id is a stable client id.
          clientId: e.id,
          dueAt: new Date(now.getTime() + e.clock_minutes * 60_000),
        })),
      ).onConflictDoNothing();
      return entries.length;
    },
    clinical,
  );
}

export type VisitTestRow = {
  id: string;
  testName: string;
  servicePointName: string;
  status: TestOrderStatus;
  orderedAt: Date;
};

/** The tests a visit has been sent for, for the consultation panel. */
export async function listVisitTests(hospitalId: string, appointmentIds: readonly string[]): Promise<Map<string, VisitTestRow[]>> {
  const result = new Map<string, VisitTestRow[]>();
  if (appointmentIds.length === 0) return result;
  const rows = await withTenant(
    hospitalId,
    (tx) =>
      tx
        .select({
          appointmentId: testOrders.appointmentId,
          id: testOrders.id,
          testName: testOrders.testName,
          servicePointName: servicePoints.name,
          status: testOrders.status,
          orderedAt: testOrders.orderedAt,
        })
        .from(testOrders)
        .innerJoin(servicePoints, eq(servicePoints.id, testOrders.servicePointId))
        .where(inArray(testOrders.appointmentId, [...appointmentIds]))
        .orderBy(asc(testOrders.orderedAt)),
    clinical,
  );
  for (const { appointmentId, ...row } of rows) {
    if (!appointmentId) continue;
    result.set(appointmentId, [...(result.get(appointmentId) ?? []), row]);
  }
  return result;
}

/**
 * The ordering doctor (or the owner) cancels a test sent by mistake, before
 * it is done. An unpaid OPD bill line goes with it; a paid one, or an IPD
 * bedside entry, stays for the desk to correct, as any other charge.
 */
export async function cancelTestOrder(args: {
  hospitalId: string;
  orderId: string;
  actorUserId: string;
  isOwner: boolean;
  reason: string;
}): Promise<void> {
  const reason = args.reason.trim().slice(0, 200) || 'Ordered by mistake';
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [order] = await tx
        .select({ status: testOrders.status, orderedBy: testOrders.orderedByUserId, billItemId: testOrders.billItemId, paidAt: testOrders.paidAt })
        .from(testOrders)
        .where(eq(testOrders.id, args.orderId))
        .for('update');
      if (!order) throw new TestOrderError('Test not found');
      if (!args.isOwner && order.orderedBy !== args.actorUserId) throw new TestOrderError('Only the doctor who ordered it can cancel it');
      if (order.status !== 'ordered' && order.status !== 'arrived') throw new TestOrderError('This test is already done or closed');
      const now = new Date();
      await tx
        .update(testOrders)
        .set({ status: 'cancelled', closedAt: now, closedByUserId: args.actorUserId, closedNote: reason })
        .where(eq(testOrders.id, args.orderId));
      if (order.billItemId && !order.paidAt) {
        await tx
          .update(billItems)
          .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: `Test cancelled: ${reason}` })
          .where(and(eq(billItems.id, order.billItemId), isNull(billItems.voidedAt)));
      }
      await audit(tx, {
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'tests.order_cancelled',
        objectType: 'test_order',
        objectId: args.orderId,
        metadata: { reason },
      });
    },
    clinical,
  );
}

/* ================================================================ worklist */

/** Service points this person works: every open one for the owner, else where they are assigned. */
export async function myServicePoints(args: { hospitalId: string; userId: string; isOwner: boolean }) {
  return withTenant(args.hospitalId, (tx) =>
    tx
      .select({ id: servicePoints.id, name: servicePoints.name, kind: servicePoints.kind })
      .from(servicePoints)
      .where(
        and(
          eq(servicePoints.active, true),
          args.isOwner
            ? undefined
            : sql`exists (select 1 from service_point_staff s where s.service_point_id = ${servicePoints.id}
                and s.user_id = ${args.userId}::uuid and s.removed_at is null)`,
        ),
      )
      .orderBy(asc(servicePoints.name)),
  );
}

async function assertMayWorkInTx(tx: Tx, args: { servicePointId: string; userId: string; isOwner: boolean }): Promise<boolean> {
  const [assigned] = await tx
    .select({ id: servicePointStaff.id })
    .from(servicePointStaff)
    .where(
      and(
        eq(servicePointStaff.servicePointId, args.servicePointId),
        eq(servicePointStaff.userId, args.userId),
        isNull(servicePointStaff.removedAt),
      ),
    );
  if (!assigned && !args.isOwner) throw new TestOrderError('You are not on the staff of this lab or room');
  return Boolean(assigned);
}

export type WorklistCall = { outcome: CallOutcome; note: string | null; calledAt: Date; calledBy: string | null };

export type WorklistOrder = {
  id: string;
  testName: string;
  status: TestOrderStatus;
  orderedAt: Date;
  paidAt: Date | null;
  dueAt: Date | null;
  escalatedAt: Date | null;
  clockFrom: ClockFrom;
  state: FollowUpState;
};

/** One patient at one service point: their open tests, grouped, so one call covers them all. */
export type WorklistPatient = {
  key: string;
  patientId: string;
  patientName: string;
  phone: string;
  age: number | null;
  gender: string | null;
  lang: Lang;
  setting: 'opd' | 'ipd';
  /** "Ward A · Bed 3" for an admitted patient. */
  where: string | null;
  doctorName: string | null;
  orderedByName: string | null;
  orders: WorklistOrder[];
  /** The earliest clock start among the tests not yet arrived (or ordered, if none). */
  waitingSince: Date | null;
  /** The most urgent follow-up state among the tests. */
  state: FollowUpState;
  calls: WorklistCall[];
};

const STATE_RANK: Record<FollowUpState, number> = {
  escalated: 0,
  task: 1,
  followed_up: 2,
  waiting: 3,
  awaiting_payment: 4,
  none: 5,
};

export type Worklist = {
  point: ServicePointRow;
  callerAssigned: boolean;
  notArrived: WorklistPatient[];
  waitingForTest: WorklistPatient[];
  waitingForReport: WorklistPatient[];
  closedToday: { id: string; patientName: string; testName: string; status: TestOrderStatus; closedReason: string | null; at: Date }[];
};

/**
 * A service point's list: patients not arrived (most urgent first), waiting
 * for the test, waiting for the report; and what closed today. Open orders of
 * any day are listed — a patient sent yesterday is still owed a test.
 */
export async function getWorklist(args: {
  hospitalId: string;
  servicePointId: string;
  userId: string;
  isOwner: boolean;
  now?: Date;
}): Promise<Worklist> {
  const now = args.now ?? new Date();
  const [point] = (await listServicePoints(args.hospitalId, { includeInactive: true })).filter((p) => p.id === args.servicePointId);
  if (!point) throw new TestOrderError('Lab or room not found');

  return withTenant(
    args.hospitalId,
    async (tx) => {
      const callerAssigned = await assertMayWorkInTx(tx, { servicePointId: args.servicePointId, userId: args.userId, isOwner: args.isOwner });
      const [hospital] = await tx.select({ timezone: hospitals.timezone, locale: hospitals.defaultLocale }).from(hospitals).where(eq(hospitals.id, args.hospitalId));
      const today = serviceDateIn(hospital.timezone, now);
      const dayStart = zonedTimeToUtc(today, '00:00', hospital.timezone);

      const orderedBy = aliasedTable(users, 'ordered_by');
      const rows = await tx
        .select({
          id: testOrders.id,
          patientId: testOrders.patientId,
          encounterId: testOrders.encounterId,
          setting: testOrders.setting,
          admissionId: testOrders.admissionId,
          testName: testOrders.testName,
          status: testOrders.status,
          orderedAt: testOrders.orderedAt,
          paidAt: testOrders.paidAt,
          dueAt: testOrders.dueAt,
          escalatedAt: testOrders.escalatedAt,
          clockFrom: testOrders.clockFrom,
          closedAt: testOrders.closedAt,
          closedReason: testOrders.closedReason,
          reportedAt: testOrders.reportedAt,
          patientName: patients.name,
          phone: patients.phoneE164,
          age: patients.age,
          gender: patients.gender,
          locale: patients.locale,
          orderedByName: orderedBy.name,
        })
        .from(testOrders)
        .innerJoin(patients, eq(patients.id, testOrders.patientId))
        .leftJoin(orderedBy, eq(orderedBy.id, testOrders.orderedByUserId))
        .where(
          and(
            eq(testOrders.servicePointId, args.servicePointId),
            or(
              inArray(testOrders.status, [...OPEN_STATUSES]),
              gte(testOrders.closedAt, dayStart),
              gte(testOrders.reportedAt, dayStart),
            ),
          ),
        )
        .orderBy(asc(testOrders.orderedAt))
        .limit(500);

      const openRows = rows.filter((r) => (OPEN_STATUSES as readonly string[]).includes(r.status));
      const orderIds = openRows.filter((r) => r.status === 'ordered').map((r) => r.id);
      const admissionIds = [...new Set(openRows.map((r) => r.admissionId).filter((id): id is string => Boolean(id)))];
      const encounterIds = [...new Set(openRows.map((r) => r.encounterId))];

      const caller = aliasedTable(users, 'caller');
      const [calls, beds_, doctorsByEncounter] = await Promise.all([
        orderIds.length
          ? tx
              .select({
                orderId: testFollowUpCalls.orderId,
                outcome: testFollowUpCalls.outcome,
                note: testFollowUpCalls.note,
                calledAt: testFollowUpCalls.calledAt,
                calledBy: caller.name,
              })
              .from(testFollowUpCalls)
              .leftJoin(caller, eq(caller.id, testFollowUpCalls.calledByUserId))
              .where(inArray(testFollowUpCalls.orderId, orderIds))
              .orderBy(desc(testFollowUpCalls.calledAt))
          : Promise.resolve([]),
        admissionIds.length
          ? tx
              .select({ admissionId: bedAssignments.admissionId, bed: beds.label, ward: wards.name })
              .from(bedAssignments)
              .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
              .innerJoin(wards, eq(wards.id, beds.wardId))
              .where(and(inArray(bedAssignments.admissionId, admissionIds), isNull(bedAssignments.toAt)))
          : Promise.resolve([]),
        encounterIds.length
          ? tx.execute<{ id: string; name: string }>(sql`
              select e.id, d.name from encounters e join doctors d on d.id = e.attending_doctor_id
              where e.id in (${sql.join(encounterIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
          : Promise.resolve([] as { id: string; name: string }[]),
      ]);
      const bedOf = new Map(beds_.map((b) => [b.admissionId, `${b.ward} · Bed ${b.bed}`]));
      const doctorOf = new Map([...doctorsByEncounter].map((d) => [d.id, d.name]));

      const groups = new Map<string, WorklistPatient>();
      for (const r of openRows) {
        const stage = r.status === 'ordered' ? 'ordered' : r.status;
        const key = `${stage}:${r.patientId}`;
        const orderCalls = calls.filter((c) => c.orderId === r.id);
        const lastCallAt = orderCalls[0]?.calledAt ?? null;
        const order: WorklistOrder = {
          id: r.id,
          testName: r.testName,
          status: r.status,
          orderedAt: r.orderedAt,
          paidAt: r.paidAt,
          dueAt: r.dueAt,
          escalatedAt: r.escalatedAt,
          clockFrom: r.clockFrom,
          state: followUpState(r, lastCallAt, now),
        };
        const started = r.clockFrom === 'order' ? r.orderedAt : (r.paidAt ?? r.orderedAt);
        const group = groups.get(key) ?? {
          key,
          patientId: r.patientId,
          patientName: r.patientName,
          phone: r.phone,
          age: r.age,
          gender: r.gender,
          lang: (r.locale ?? hospital.locale) as Lang,
          setting: r.setting,
          where: r.admissionId ? (bedOf.get(r.admissionId) ?? 'IPD') : null,
          doctorName: doctorOf.get(r.encounterId) ?? null,
          orderedByName: r.orderedByName,
          orders: [],
          waitingSince: started,
          state: order.state,
          calls: [],
        };
        group.orders.push(order);
        if (group.waitingSince === null || started < group.waitingSince) group.waitingSince = started;
        if (STATE_RANK[order.state] < STATE_RANK[group.state]) group.state = order.state;
        for (const c of orderCalls) {
          if (!group.calls.some((g) => g.calledAt.getTime() === c.calledAt.getTime() && g.outcome === c.outcome)) {
            group.calls.push({ outcome: c.outcome, note: c.note, calledAt: c.calledAt, calledBy: c.calledBy });
          }
        }
        groups.set(key, group);
      }
      const all = [...groups.values()];
      for (const g of all) g.calls.sort((a, b) => b.calledAt.getTime() - a.calledAt.getTime());
      const byStage = (stage: string) => all.filter((g) => g.key.startsWith(`${stage}:`));
      const bySince = (a: WorklistPatient, b: WorklistPatient) => (a.waitingSince?.getTime() ?? 0) - (b.waitingSince?.getTime() ?? 0);

      return {
        point,
        callerAssigned,
        notArrived: byStage('ordered').sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || bySince(a, b)),
        waitingForTest: byStage('arrived').sort(bySince),
        waitingForReport: byStage('done').sort(bySince),
        closedToday: rows
          .filter((r) => !(OPEN_STATUSES as readonly string[]).includes(r.status))
          .map((r) => ({
            id: r.id,
            patientName: r.patientName,
            testName: r.testName,
            status: r.status,
            closedReason: r.closedReason,
            at: (r.closedAt ?? r.reportedAt)!,
          }))
          .sort((a, b) => b.at.getTime() - a.at.getTime()),
      };
    },
    clinical,
  );
}

/** Loads open orders of one service point, locked, refusing ids that are not there. */
async function lockOrdersInTx(tx: Tx, args: { servicePointId: string; orderIds: readonly string[] }) {
  const ids = [...new Set(args.orderIds)].slice(0, 20);
  if (ids.length === 0) throw new TestOrderError('Choose a test');
  const rows = await tx
    .select({ id: testOrders.id, status: testOrders.status, servicePointId: testOrders.servicePointId })
    .from(testOrders)
    .where(inArray(testOrders.id, ids))
    .orderBy(asc(testOrders.id))
    .for('update');
  if (rows.length !== ids.length || rows.some((r) => r.servicePointId !== args.servicePointId)) {
    throw new TestOrderError('Test not found at this lab or room');
  }
  return rows;
}

/**
 * Records a call to a patient who has not arrived, once per test it covers.
 * "Went home" and "refused" close those tests as not coming. A test that
 * arrived meanwhile is skipped, not refused: the call still happened.
 */
export async function recordCall(args: {
  hospitalId: string;
  servicePointId: string;
  orderIds: readonly string[];
  outcome: CallOutcome;
  note: string | null;
  clientId: string;
  userId: string;
  isOwner: boolean;
  now?: Date;
}): Promise<{ recorded: number; closed: number }> {
  const note = args.note?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const refusal = outcomeRefusal(args.outcome, note);
  if (refusal) throw new TestOrderError(refusal);
  const now = args.now ?? new Date();

  return withTenant(
    args.hospitalId,
    async (tx) => {
      const callerAssigned = await assertMayWorkInTx(tx, { servicePointId: args.servicePointId, userId: args.userId, isOwner: args.isOwner });
      const rows = await lockOrdersInTx(tx, { servicePointId: args.servicePointId, orderIds: args.orderIds });
      const waiting = rows.filter((r) => r.status === 'ordered');
      if (waiting.length === 0) return { recorded: 0, closed: 0 };

      const inserted = await tx
        .insert(testFollowUpCalls)
        .values(
          waiting.map((r) => ({
            hospitalId: args.hospitalId,
            orderId: r.id,
            servicePointId: args.servicePointId,
            outcome: args.outcome,
            note,
            calledAt: now,
            calledByUserId: args.userId,
            callerAssigned,
            clientId: args.clientId,
          })),
        )
        .onConflictDoNothing()
        .returning({ orderId: testFollowUpCalls.orderId });

      let closed = 0;
      if (isClosingOutcome(args.outcome) && inserted.length > 0) {
        const done = await tx
          .update(testOrders)
          .set({ status: 'not_coming', closedAt: now, closedByUserId: args.userId, closedReason: args.outcome, closedNote: note })
          .where(and(inArray(testOrders.id, inserted.map((r) => r.orderId)), eq(testOrders.status, 'ordered')))
          .returning({ id: testOrders.id });
        closed = done.length;
      }
      return { recorded: inserted.length, closed };
    },
    clinical,
  );
}

/**
 * Moves tests forward at the service point: the patient arrived, the test was
 * done, the report was added. Each step may skip the one before it (a patient
 * tested on arrival is marked done; arrival is stamped with it). A test
 * already further on is left as it is.
 */
export async function advanceTests(args: {
  hospitalId: string;
  servicePointId: string;
  orderIds: readonly string[];
  to: 'arrived' | 'done' | 'reported';
  userId: string;
  isOwner: boolean;
  now?: Date;
}): Promise<number> {
  const now = args.now ?? new Date();
  const from: Record<typeof args.to, TestOrderStatus[]> = {
    arrived: ['ordered'],
    done: ['ordered', 'arrived'],
    reported: ['ordered', 'arrived', 'done'],
  };
  return withTenant(
    args.hospitalId,
    async (tx) => {
      await assertMayWorkInTx(tx, { servicePointId: args.servicePointId, userId: args.userId, isOwner: args.isOwner });
      const rows = await lockOrdersInTx(tx, { servicePointId: args.servicePointId, orderIds: args.orderIds });
      const movable = rows.filter((r) => from[args.to].includes(r.status)).map((r) => r.id);
      if (movable.length === 0) return 0;
      const by = args.userId;
      const updated = await tx
        .update(testOrders)
        .set({
          status: args.to,
          arrivedAt: sql`coalesce(${testOrders.arrivedAt}, ${now.toISOString()}::timestamptz)`,
          arrivedByUserId: sql`coalesce(${testOrders.arrivedByUserId}, ${by}::uuid)`,
          ...(args.to !== 'arrived'
            ? {
                doneAt: sql`coalesce(${testOrders.doneAt}, ${now.toISOString()}::timestamptz)`,
                doneByUserId: sql`coalesce(${testOrders.doneByUserId}, ${by}::uuid)`,
              }
            : {}),
          ...(args.to === 'reported' ? { reportedAt: now, reportedByUserId: by } : {}),
        })
        .where(inArray(testOrders.id, movable))
        .returning({ id: testOrders.id });
      return updated.length;
    },
    clinical,
  );
}

/* =============================================================== the day */

export type DayPendingRow = {
  id: string;
  servicePointId: string;
  servicePointName: string;
  patientName: string;
  phone: string;
  setting: 'opd' | 'ipd';
  testName: string;
  status: TestOrderStatus;
  orderedAt: Date;
  escalatedAt: Date | null;
  lastCall: { outcome: CallOutcome; at: Date; by: string | null } | null;
};

export type TestDay = {
  date: string;
  points: { id: string; name: string; summary: PointDay }[];
  people: ({ userId: string; name: string } & PersonDay)[];
  /** Everything still open, ordered on or before this day: the day-end list. */
  pending: DayPendingRow[];
  /** Raised to the admin and still not arrived. */
  escalatedOpen: number;
};

/**
 * The admin's Today screen for one day (hospital time): per service point,
 * the funnel from ordered to report added, the tasks raised and escalated, the
 * calls; per person, their calls and what they marked; and the pending list.
 */
export async function getTestDay(args: { hospitalId: string; date?: string; now?: Date }): Promise<TestDay> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [hospital] = await tx.select({ timezone: hospitals.timezone }).from(hospitals).where(eq(hospitals.id, args.hospitalId));
      const date = args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : serviceDateIn(hospital.timezone, now);
      const start = zonedTimeToUtc(date, '00:00', hospital.timezone);
      const end = new Date(start.getTime() + 24 * 3_600_000);

      const [orders, calls, points, pendingRows] = await Promise.all([
        tx
          .select({
            id: testOrders.id,
            servicePointId: testOrders.servicePointId,
            status: testOrders.status,
            closedReason: testOrders.closedReason,
            taskRaisedAt: testOrders.taskRaisedAt,
            escalatedAt: testOrders.escalatedAt,
          })
          .from(testOrders)
          .where(and(gte(testOrders.orderedAt, start), lt(testOrders.orderedAt, end))),
        tx
          .select({
            orderId: testFollowUpCalls.orderId,
            servicePointId: testFollowUpCalls.servicePointId,
            calledByUserId: testFollowUpCalls.calledByUserId,
            outcome: testFollowUpCalls.outcome,
          })
          .from(testFollowUpCalls)
          .where(and(gte(testFollowUpCalls.calledAt, start), lt(testFollowUpCalls.calledAt, end))),
        tx.select({ id: servicePoints.id, name: servicePoints.name, active: servicePoints.active }).from(servicePoints).orderBy(asc(servicePoints.name)),
        tx
          .select({
            id: testOrders.id,
            servicePointId: testOrders.servicePointId,
            servicePointName: servicePoints.name,
            patientName: patients.name,
            phone: patients.phoneE164,
            setting: testOrders.setting,
            testName: testOrders.testName,
            status: testOrders.status,
            orderedAt: testOrders.orderedAt,
            escalatedAt: testOrders.escalatedAt,
          })
          .from(testOrders)
          .innerJoin(servicePoints, eq(servicePoints.id, testOrders.servicePointId))
          .innerJoin(patients, eq(patients.id, testOrders.patientId))
          .where(and(inArray(testOrders.status, [...OPEN_STATUSES]), lt(testOrders.orderedAt, end)))
          .orderBy(asc(servicePoints.name), asc(testOrders.orderedAt))
          .limit(500),
      ]);

      // Who marked which step that day, on any day's orders.
      const steps = await tx.execute<{ user_id: string; step: 'arrived' | 'done' | 'reported' }>(sql`
        select arrived_by_user_id as user_id, 'arrived' as step from test_orders
          where arrived_by_user_id is not null and arrived_at >= ${start.toISOString()}::timestamptz and arrived_at < ${end.toISOString()}::timestamptz
        union all
        select done_by_user_id, 'done' from test_orders
          where done_by_user_id is not null and done_at >= ${start.toISOString()}::timestamptz and done_at < ${end.toISOString()}::timestamptz
        union all
        select reported_by_user_id, 'reported' from test_orders
          where reported_by_user_id is not null and reported_at >= ${start.toISOString()}::timestamptz and reported_at < ${end.toISOString()}::timestamptz
      `);
      const { points: byPoint, people: byPerson } = summariseDay(
        orders,
        calls,
        [...steps].map((s) => ({ userId: s.user_id, step: s.step })),
      );
      const personIds = [...byPerson.keys()];
      const names = personIds.length
        ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, personIds))
        : [];
      const nameOf = new Map(names.map((n) => [n.id, n.name]));

      const pendingIds = pendingRows.map((r) => r.id);
      const caller = aliasedTable(users, 'caller');
      const lastCalls = pendingIds.length
        ? await tx
            .selectDistinctOn([testFollowUpCalls.orderId], {
              orderId: testFollowUpCalls.orderId,
              outcome: testFollowUpCalls.outcome,
              at: testFollowUpCalls.calledAt,
              by: caller.name,
            })
            .from(testFollowUpCalls)
            .leftJoin(caller, eq(caller.id, testFollowUpCalls.calledByUserId))
            .where(inArray(testFollowUpCalls.orderId, pendingIds))
            .orderBy(testFollowUpCalls.orderId, desc(testFollowUpCalls.calledAt))
        : [];
      const lastCallOf = new Map(lastCalls.map((c) => [c.orderId, { outcome: c.outcome, at: c.at, by: c.by }]));

      return {
        date,
        points: points
          .filter((p) => p.active || byPoint.has(p.id))
          .map((p) => ({ id: p.id, name: p.name, summary: byPoint.get(p.id) ?? emptyPointDay() })),
        people: [...byPerson.entries()]
          .map(([userId, s]) => ({ userId, name: nameOf.get(userId) ?? 'Former staff', ...s }))
          .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
        pending: pendingRows.map((r) => ({ ...r, lastCall: lastCallOf.get(r.id) ?? null })),
        escalatedOpen: pendingRows.filter((r) => r.status === 'ordered' && r.escalatedAt).length,
      };
    },
    clinical,
  );
}

/** For the owner's menu: tests raised to the admin and still not arrived. Cheap; zero when nothing is. */
export async function countEscalatedTests(hospitalId: string): Promise<number> {
  const [row] = await withTenant(
    hospitalId,
    (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(testOrders)
        .where(and(eq(testOrders.status, 'ordered'), isNotNull(testOrders.escalatedAt))),
    clinical,
  );
  return row?.n ?? 0;
}

/** The doctor took back ward tests within the undo window: their orders are cancelled with them. */
export async function cancelOrdersForCareEntries(args: {
  hospitalId: string;
  careEntryIds: readonly string[];
  actorUserId: string;
}): Promise<number> {
  if (args.careEntryIds.length === 0) return 0;
  const rows = await withTenant(
    args.hospitalId,
    (tx) =>
      tx
        .update(testOrders)
        .set({ status: 'cancelled', closedAt: new Date(), closedByUserId: args.actorUserId, closedNote: 'Taken back by the doctor' })
        .where(and(inArray(testOrders.careEntryId, [...args.careEntryIds]), inArray(testOrders.status, ['ordered', 'arrived'])))
        .returning({ id: testOrders.id }),
    clinical,
  );
  return rows.length;
}
