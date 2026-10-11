import { createHash } from 'node:crypto';
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import { requestOrigin } from '@/lib/db/request-context';
import {
  admissions,
  auditLogs,
  bedAssignments,
  beds,
  careEntries,
  doctors,
  medicineRiskClasses,
  medicines,
  marAdministrations,
  stockLocations,
  marWastes,
  presenceProofs,
  riskClasses,
  staffMemberships,
  treatmentOrders,
  users,
  wards,
  witnessRequests,
} from '@/lib/db/schema';
import {
  MarError,
  NOT_GIVEN,
  PRESENCE_VALID_MS,
  WITNESS_APPROVAL_MS,
  WITNESS_LATE_MS,
  WASTE_REASONS,
  checkGive,
  needsWitness,
  newBedCode,
  normaliseBedCode,
  notGivenRefusal,
  orderStatus,
  type ControlFlag,
  type DoseState,
  type NotGivenChoice,
  type OrderInput,
  type OrderStatus,
  type ReasonCode,
  type RiskInfo,
  type Route,
  type WasteInput,
  type WasteReason,
} from '@/lib/domain/mar';
import { medicineLabel } from '@/lib/domain/medicine';
import {
  instancesFor,
  timingFromRow,
  timingOfGive,
  windowFor,
  type DueRecord,
  type DueSettings,
  type TaskKind,
  type Timing,
} from '@/lib/domain/due';
import type { StaffRole } from '@/lib/domain/permissions';
import { chartDayWindow } from '@/lib/domain/tpr';
import type { ModuleStage } from '@/lib/modules/registry';
import { BILLABLE_ADMISSION_STATUSES, postCareEntryLineInTx, voidCareEntryLineInTx } from '@/lib/services/ipd-billing';
import { drawInTx, isStockedInTx, putBackInTx, wardStoresInTx } from '@/lib/services/mar-stock';
import { activeAllergiesInTx } from '@/lib/services/allergy';
import { matchAllergies, matchText, type AllergyMatch } from '@/lib/domain/allergy';
import { verifyWitnessPin, type WardDevice } from '@/lib/services/staff-access';

/**
 * The treatment card and the MAR (IPD sheets plan B3-min, §7.2; migration
 * 0048). Each operation is one clinical transaction. The database keeps the
 * card and the doses one-way (stop, countersign, strike out; never edit),
 * refuses a witness who gave the dose, and records every step in the evidence
 * log. Role permissions are the caller's; who may countersign, strike out or
 * witness a particular line is checked here.
 */

export { MarError };

/**
 * B2: the medicine matches the patient's allergies and no reason was given
 * for going ahead. Carries the matches so the screen can show them and ask.
 */
export class AllergyMatchError extends MarError {
  constructor(readonly matches: AllergyMatch[]) {
    super(`Allergy: ${matches.map(matchText).join('; ')}. Write why it is still to be given, or choose another medicine.`);
  }
}

const clinical = { clinical: true } as const;
const CLINICAL_PERSON_ROLES: readonly StaffRole[] = ['owner', 'doctor', 'nurse'];

export type Actor = {
  userId: string;
  channel: 'personal' | 'ward_device';
  /** The ward tablet this session is on, for a ward-device session. */
  wardDeviceId: string | null;
};

async function audit(tx: Tx, args: { hospitalId: string; actorUserId: string | null; action: string; objectType: string; objectId: string; metadata?: Record<string, unknown> }) {
  await tx.insert(auditLogs).values(args);
}

/** A stable id derived from another: a retried dose posts its bedside entry once. */
function derivedId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function admissionInBedInTx(tx: Tx, admissionId: string, lock = false) {
  const query = tx
    .select({
      id: admissions.id,
      branchId: admissions.branchId,
      encounterId: admissions.encounterId,
      patientId: admissions.patientId,
      status: admissions.status,
      admittingDoctorId: admissions.admittingDoctorId,
    })
    .from(admissions)
    .where(eq(admissions.id, admissionId));
  const [row] = lock ? await query.for('share') : await query;
  if (!row) throw new MarError('Patient not found');
  if (!(BILLABLE_ADMISSION_STATUSES as readonly string[]).includes(row.status)) {
    throw new MarError(row.status === 'discharged' ? 'This patient has been discharged' : 'This patient does not have a bed yet');
  }
  return row;
}

/** The ward of the patient's current bed (where a dose's stock comes from). */
async function currentWardInTx(tx: Tx, admissionId: string): Promise<string | null> {
  const [row] = await tx
    .select({ wardId: beds.wardId })
    .from(bedAssignments)
    .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
    .where(and(eq(bedAssignments.admissionId, admissionId), isNull(bedAssignments.toAt)))
    .limit(1);
  return row?.wardId ?? null;
}

/**
 * Where a risk-class dose or waste comes off stock (B4b): the store the nurse
 * chose if it is one of the ward's, else the ward's own store. Null when the
 * ward has no store (it is then taken off by hand, from the stock page).
 */
async function storeForInTx(tx: Tx, admissionId: string, chosen: string | null | undefined): Promise<string | null> {
  const stores = await wardStoresInTx(tx, await currentWardInTx(tx, admissionId));
  return stores.find((s) => s.id === chosen)?.id ?? stores[0]?.id ?? null;
}

async function riskOfMedicineInTx(tx: Tx, medicineId: string | null): Promise<RiskInfo> {
  if (!medicineId) return null;
  const [row] = await tx
    .select({ kind: riskClasses.kind, witnessAtGive: riskClasses.witnessAtGive, className: riskClasses.name })
    .from(medicineRiskClasses)
    .innerJoin(riskClasses, eq(riskClasses.id, medicineRiskClasses.riskClassId))
    .where(and(eq(medicineRiskClasses.medicineId, medicineId), isNull(riskClasses.archivedAt)));
  return row ?? null;
}

/* =================================================================== orders */

export type DoctorOption = { id: string; name: string; userId: string | null };

export async function listOrderingDoctors(hospitalId: string): Promise<DoctorOption[]> {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({ id: doctors.id, name: doctors.name, userId: doctors.userId })
      .from(doctors)
      .where(eq(doctors.active, true))
      .orderBy(asc(doctors.name)),
  );
}

/**
 * Writes a line on the treatment card. Signed when the person writing it is
 * the ordering doctor; otherwise transcribed, waiting for that doctor's
 * countersign — and only someone allowed to transcribe may write it. A
 * retried form writes nothing twice.
 */
export async function createOrder(args: {
  hospitalId: string;
  admissionId: string;
  input: OrderInput;
  orderingDoctorId: string;
  clientId: string;
  actor: Actor;
  mayTranscribe: boolean;
  /** B2: why to go ahead although the medicine matches an allergy (required when it does). */
  allergyOverride?: string | null;
  /** B2: whether the allergy check is in use (module `allergy`); on by default. */
  allergyCheck?: boolean;
  now?: Date;
}): Promise<{ orderId: string; transcribed: boolean; allergyMatches: string[] }> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [existing] = await tx
        .select({ id: treatmentOrders.id, transcribed: treatmentOrders.transcribed, admissionId: treatmentOrders.admissionId })
        .from(treatmentOrders)
        .where(eq(treatmentOrders.clientId, args.clientId));
      if (existing) {
        if (existing.admissionId !== args.admissionId) throw new MarError('That line belongs to another patient');
        return { orderId: existing.id, transcribed: existing.transcribed, allergyMatches: [] };
      }

      const admission = await admissionInBedInTx(tx, args.admissionId);
      const [doctor] = await tx
        .select({ id: doctors.id, userId: doctors.userId, active: doctors.active })
        .from(doctors)
        .where(eq(doctors.id, args.orderingDoctorId));
      if (!doctor?.active) throw new MarError('Choose the doctor who ordered it');
      const transcribed = doctor.userId !== args.actor.userId;
      if (transcribed && !args.mayTranscribe) throw new MarError('Only the named doctor can write this line');

      let description: string;
      let medicineId: string | null = null;
      let allergyMatches: string[] = [];
      let allergyOverride: string | null = null;
      if (args.input.kind === 'medicine') {
        const [medicine] = await tx
          .select({ id: medicines.id, name: medicines.name, genericName: medicines.genericName, strength: medicines.strength, form: medicines.form, active: medicines.active })
          .from(medicines)
          .where(eq(medicines.id, args.input.medicineId));
        if (!medicine?.active) throw new MarError('That medicine is not in the list');
        description = medicineLabel(medicine);
        medicineId = medicine.id;
        // B2: decision support. A match needs the doctor's reason to go ahead; it is kept on the line.
        if (args.allergyCheck !== false) {
          const matches = matchAllergies(await activeAllergiesInTx(tx, admission.patientId), medicine);
          if (matches.length > 0) {
            allergyOverride = args.allergyOverride?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
            if (!allergyOverride || allergyOverride.length < 3) throw new AllergyMatchError(matches);
            allergyMatches = matches.map(matchText);
          }
        }
      } else {
        description = args.input.description;
      }
      const timing = args.input.kind === 'instruction' ? null : args.input.timing;

      const origin = await requestOrigin();
      const [row] = await tx
        .insert(treatmentOrders)
        .values({
          hospitalId: args.hospitalId,
          branchId: admission.branchId,
          admissionId: admission.id,
          encounterId: admission.encounterId,
          patientId: admission.patientId,
          kind: args.input.kind,
          medicineId,
          description,
          dose: args.input.kind === 'medicine' ? args.input.dose : null,
          route: args.input.kind === 'medicine' ? args.input.route : null,
          frequency: args.input.kind === 'medicine' ? args.input.frequency : null,
          instructions: args.input.kind === 'medicine' ? args.input.instructions : null,
          taskKind: args.input.kind === 'task' ? args.input.taskKind : null,
          timingMode: timing?.mode ?? null,
          clockTimes: timing?.mode === 'clock' ? timing.clockTimes : null,
          intervalMin: timing?.mode === 'interval' ? timing.intervalMin : null,
          firstDueAt: timing && (timing.mode === 'interval' || timing.mode === 'once') ? timing.firstDueAt : null,
          latePolicy: timing && (timing.mode === 'clock' || timing.mode === 'interval') ? timing.latePolicy : null,
          orderingDoctorId: doctor.id,
          orderedAt: now,
          enteredByUserId: args.actor.userId,
          transcribed,
          allergyMatches: allergyMatches.length > 0 ? allergyMatches : null,
          allergyOverrideReason: allergyMatches.length > 0 ? allergyOverride : null,
          recordedChannel: origin?.channel ?? args.actor.channel,
          recordedDeviceId: origin?.deviceId ?? null,
          recordedSessionId: origin?.sessionId ?? null,
          clientId: args.clientId,
        })
        .returning({ id: treatmentOrders.id });
      if (allergyMatches.length > 0) {
        await audit(tx, {
          hospitalId: args.hospitalId,
          actorUserId: args.actor.userId,
          action: 'mar.allergy_override',
          objectType: 'treatment_order',
          objectId: row.id,
          metadata: { matches: allergyMatches.length },
        });
      }
      return { orderId: row.id, transcribed, allergyMatches };
    },
    clinical,
  );
}

type LockedOrder = Awaited<ReturnType<typeof lockOrderInTx>>;

/** What a dose against `dueAt` means for its timing, after checking the due time is one of the line's and still open. */
export type DueContext = { dueAt: Date | null; reason: string | null; settings: DueSettings; tcActive: boolean; timezone: string; enforce: boolean };

async function dueTimingInTx(tx: Tx, order: LockedOrder, due: DueContext | undefined, occurredAt: Date) {
  const timing = timingFromRow(order);
  if (!due || !timing || timing.mode === 'prn') {
    return { dueAt: null, timingStatus: timing && timing.mode !== 'prn' ? ('unscheduled' as const) : null, delayMin: null, timingReason: null };
  }
  if (!due.dueAt) return { dueAt: null, timingStatus: 'unscheduled' as const, delayMin: null, timingReason: due.reason };
  const window = windowFor({ timeCritical: Boolean(order.timeCritical) && due.tcActive, medicineBefore: order.tcBefore, medicineAfter: order.tcAfter, settings: due.settings });
  const records = await tx
    .select({ id: marAdministrations.id, dueAt: marAdministrations.dueAt, state: marAdministrations.state, occurredAt: marAdministrations.occurredAt })
    .from(marAdministrations)
    .where(and(eq(marAdministrations.orderId, order.id), isNull(marAdministrations.voidedAt)));
  const instances = instancesFor({
    line: { timing, orderedAt: order.orderedAt, stoppedAt: order.stoppedAt, windowBeforeMin: window.before, windowAfterMin: window.after },
    records: records as DueRecord[],
    from: new Date(due.dueAt.getTime() - 1),
    to: new Date(due.dueAt.getTime() + 1),
    now: occurredAt,
    timezone: due.timezone,
    settings: due.settings,
  });
  const instance = instances.find((i) => i.dueAt.getTime() === due.dueAt!.getTime());
  if (!instance) throw new MarError('That is not one of this line’s due times');
  if (instance.record && !instance.record.fromChart) throw new MarError('This dose is already recorded');
  const { status, delayMin } = timingOfGive({ dueAt: due.dueAt, occurredAt, windowBeforeMin: window.before, windowAfterMin: window.after });
  if (status !== 'on_time' && due.enforce && !due.reason) {
    throw new MarError(status === 'late' ? 'Given after its window: write why' : 'Given before its window: write why');
  }
  return { dueAt: due.dueAt, timingStatus: status, delayMin, timingReason: status === 'on_time' ? null : due.reason };
}

async function lockOrderInTx(tx: Tx, orderId: string) {
  const [order] = await tx
    .select({
      id: treatmentOrders.id,
      admissionId: treatmentOrders.admissionId,
      kind: treatmentOrders.kind,
      medicineId: treatmentOrders.medicineId,
      description: treatmentOrders.description,
      dose: treatmentOrders.dose,
      route: treatmentOrders.route,
      transcribed: treatmentOrders.transcribed,
      countersignedAt: treatmentOrders.countersignedAt,
      stoppedAt: treatmentOrders.stoppedAt,
      voidedAt: treatmentOrders.voidedAt,
      enteredByUserId: treatmentOrders.enteredByUserId,
      orderingDoctorId: treatmentOrders.orderingDoctorId,
      doctorUserId: doctors.userId,
      orderedAt: treatmentOrders.orderedAt,
      timingMode: treatmentOrders.timingMode,
      clockTimes: treatmentOrders.clockTimes,
      intervalMin: treatmentOrders.intervalMin,
      firstDueAt: treatmentOrders.firstDueAt,
      latePolicy: treatmentOrders.latePolicy,
      timeCritical: medicines.timeCritical,
      tcBefore: medicines.tcWindowBeforeMin,
      tcAfter: medicines.tcWindowAfterMin,
    })
    .from(treatmentOrders)
    .innerJoin(doctors, eq(doctors.id, treatmentOrders.orderingDoctorId))
    .leftJoin(medicines, eq(medicines.id, treatmentOrders.medicineId))
    .where(eq(treatmentOrders.id, orderId))
    .for('update', { of: treatmentOrders });
  if (!order) throw new MarError('Treatment line not found');
  return order;
}

/** The named doctor countersigns a telephone or verbal order written by someone else. Only their own login. */
export async function countersignOrder(args: { hospitalId: string; orderId: string; actorUserId: string; now?: Date }): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const order = await lockOrderInTx(tx, args.orderId);
      if (order.doctorUserId !== args.actorUserId) throw new MarError('Only the doctor named on the line can countersign it');
      if (!order.transcribed) throw new MarError('The doctor wrote this line; it needs no countersign');
      if (order.countersignedAt) return;
      if (order.voidedAt) throw new MarError('This line was struck out');
      await tx
        .update(treatmentOrders)
        .set({ countersignedAt: args.now ?? new Date(), countersignedByUserId: args.actorUserId })
        .where(eq(treatmentOrders.id, args.orderId));
    },
    clinical,
  );
}

/** A doctor stops a line. It stays on the card, stopped, with the reason. */
export async function stopOrder(args: { hospitalId: string; orderId: string; actorUserId: string; reason: string; now?: Date }): Promise<void> {
  const reason = args.reason.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Stopped by doctor';
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const order = await lockOrderInTx(tx, args.orderId);
      if (order.voidedAt) throw new MarError('This line was struck out');
      if (order.stoppedAt) return;
      await tx
        .update(treatmentOrders)
        .set({ stoppedAt: args.now ?? new Date(), stoppedByUserId: args.actorUserId, stopReason: reason })
        .where(eq(treatmentOrders.id, args.orderId));
    },
    clinical,
  );
}

/**
 * A line written in error is struck out, by whoever wrote it or the owner,
 * while no dose has been recorded against it (after that it is stopped).
 */
export async function strikeOutOrder(args: { hospitalId: string; orderId: string; actorUserId: string; isOwner: boolean; reason: string }): Promise<void> {
  const reason = args.reason.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Written in error';
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const order = await lockOrderInTx(tx, args.orderId);
      if (order.voidedAt) return;
      if (!args.isOwner && order.enteredByUserId !== args.actorUserId) throw new MarError('Only whoever wrote the line can strike it out');
      const [dose] = await tx
        .select({ id: marAdministrations.id })
        .from(marAdministrations)
        .where(and(eq(marAdministrations.orderId, args.orderId), isNull(marAdministrations.voidedAt)))
        .limit(1);
      if (dose) throw new MarError('A dose is already recorded on this line. Stop it instead.');
      await tx
        .update(treatmentOrders)
        .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: reason })
        .where(eq(treatmentOrders.id, args.orderId));
    },
    clinical,
  );
}

/* ==================================================================== doses */

export type DoseOutcome = {
  marId: string;
  occurredAt: Date;
  witness: 'not_needed' | 'ward_device' | 'approval' | 'skipped';
  flags: ControlFlag[];
  /** B4b: taken off a store, or short (saved; to be taken off by hand); null when nothing comes off stock. */
  stock: 'posted' | 'short' | 'reversed' | null;
  repeat: boolean;
};

async function existingDoseInTx(tx: Tx, clientId: string) {
  const [row] = await tx
    .select({
      id: marAdministrations.id,
      occurredAt: marAdministrations.occurredAt,
      orderId: marAdministrations.orderId,
      witnessStatus: marAdministrations.witnessStatus,
      controlFlags: marAdministrations.controlFlags,
      stockStatus: marAdministrations.stockStatus,
    })
    .from(marAdministrations)
    .where(eq(marAdministrations.clientId, clientId));
  return row;
}

async function recentPresenceInTx(tx: Tx, args: { admissionId: string; userId: string; now: Date }) {
  const [proof] = await tx
    .select({ id: presenceProofs.id })
    .from(presenceProofs)
    .where(
      and(
        eq(presenceProofs.admissionId, args.admissionId),
        eq(presenceProofs.userId, args.userId),
        gte(presenceProofs.provedAt, new Date(args.now.getTime() - PRESENCE_VALID_MS)),
      ),
    )
    .orderBy(desc(presenceProofs.provedAt))
    .limit(1);
  return proof?.id ?? null;
}

async function assertWitnessCandidateInTx(tx: Tx, args: { witnessUserId: string; actorUserId: string }) {
  if (args.witnessUserId === args.actorUserId) throw new MarError('The witness must be someone else');
  const [member] = await tx
    .select({ role: staffMemberships.role, active: staffMemberships.active, userActive: users.active })
    .from(staffMemberships)
    .innerJoin(users, eq(users.id, staffMemberships.userId))
    .where(eq(staffMemberships.userId, args.witnessUserId));
  if (!member?.active || !member.userActive || !CLINICAL_PERSON_ROLES.includes(member.role)) {
    throw new MarError('The witness must be a doctor or nurse on your staff');
  }
}

/**
 * Records a dose as given, against an active medicine line. Posts its bill
 * line through a bedside entry (unless the quantity is 0). For a risk-class
 * medicine the module's stage decides whether a missing countersign, bedside
 * proof or witness refuses the give or is flagged on it; a give that needs a
 * witness is saved at once ("given — awaiting witness"), never delayed.
 */
export async function recordGive(args: {
  hospitalId: string;
  orderId: string;
  occurredAt: Date;
  dose: string | null;
  quantity: number;
  lateReason: string | null;
  witnessUserId: string | null;
  clientId: string;
  actor: Actor;
  stage: ModuleStage;
  /** The due time this dose answers (B3b); absent for a dose outside the schedule. */
  due?: DueContext;
  /**
   * B4b: whether risk-class stock is in use for the patient's ward (so the dose
   * comes off a store) — a flag, or decided from the ward — and which store, if
   * the nurse chose.
   */
  stock?: { on: boolean | ((wardId: string | null) => boolean); locationId?: string | null };
  now?: Date;
}): Promise<DoseOutcome> {
  const now = args.now ?? new Date();
  if (!Number.isInteger(args.quantity) || args.quantity < 0 || args.quantity > 100) throw new MarError('Quantity must be 0 to 100');
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const existing = await existingDoseInTx(tx, args.clientId);
      if (existing) {
        if (existing.orderId !== args.orderId) throw new MarError('That dose belongs to another line');
        return {
          marId: existing.id,
          occurredAt: existing.occurredAt,
          witness: existing.witnessStatus === 'skipped' ? 'skipped' : existing.witnessStatus === 'not_needed' ? 'not_needed' : args.actor.channel === 'ward_device' ? 'ward_device' : 'approval',
          flags: existing.controlFlags,
          stock: existing.stockStatus,
          repeat: true,
        };
      }

      const order = await lockOrderInTx(tx, args.orderId);
      const status = orderStatus(order);
      if (order.kind !== 'medicine') throw new MarError('An instruction has no doses');
      if (status === 'struck_out') throw new MarError('This line was struck out');
      if (status === 'stopped') throw new MarError('This line was stopped');
      const admission = await admissionInBedInTx(tx, order.admissionId, true);
      const risk = await riskOfMedicineInTx(tx, order.medicineId);
      const presenceProofId = risk ? await recentPresenceInTx(tx, { admissionId: admission.id, userId: args.actor.userId, now }) : null;

      const check = checkGive({
        stage: args.stage,
        risk,
        route: order.route as Route | null,
        channel: args.actor.channel,
        order,
        hasPresenceProof: Boolean(presenceProofId),
        witnessUserId: args.witnessUserId,
        occurredAt: args.occurredAt,
        now,
      });
      if (check.refusal) throw new MarError(check.refusal);
      const lateReason = args.lateReason?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
      if (check.needsLateReason && !lateReason) throw new MarError('This is over 2 hours ago: write why it is written late');
      if (check.witness === 'approval') await assertWitnessCandidateInTx(tx, { witnessUserId: args.witnessUserId!, actorUserId: args.actor.userId });
      if (check.witness === 'ward_device' && !args.actor.wardDeviceId) throw new MarError('Ward tablet not found');

      const timing = await dueTimingInTx(tx, order, args.due, args.occurredAt);
      const origin = await requestOrigin();
      const marId = crypto.randomUUID();

      // The bill line, through the same path as any bedside entry.
      let careEntryId: string | null = null;
      if (args.quantity > 0) {
        const [entry] = await tx
          .insert(careEntries)
          .values({
            hospitalId: args.hospitalId,
            admissionId: admission.id,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            medicineId: order.medicineId,
            chargeItemId: null,
            description: order.description,
            quantity: args.quantity,
            occurredAt: args.occurredAt,
            recordedAt: now,
            recordedByUserId: args.actor.userId,
            clientId: derivedId(`mar:${args.clientId}`),
            recordedChannel: origin?.channel ?? args.actor.channel,
            recordedDeviceId: origin?.deviceId ?? null,
          })
          .returning();
        await postCareEntryLineInTx(tx, { entry, actorUserId: args.actor.userId });
        careEntryId = entry.id;
      }

      // B4b: a risk-class dose comes off the ward's store with it, or is marked short (never refused for it).
      let stockStatus: 'posted' | 'short' | null = null;
      let stockLocationId: string | null = null;
      const stockOn = (wardId: string | null) => (typeof args.stock?.on === 'function' ? args.stock.on(wardId) : Boolean(args.stock?.on));
      if (risk && args.quantity > 0 && args.stock && stockOn(await currentWardInTx(tx, admission.id)) && (await isStockedInTx(tx, order.medicineId))) {
        stockLocationId = await storeForInTx(tx, admission.id, args.stock.locationId);
        stockStatus = stockLocationId
          ? await drawInTx(tx, {
              hospitalId: args.hospitalId,
              subject: { kind: 'dose', id: marId },
              locationId: stockLocationId,
              medicineId: order.medicineId!,
              units: args.quantity,
              occurredAt: args.occurredAt,
              actorUserId: args.actor.userId,
              now,
            })
          : 'short';
      }

      const witnessStatus = check.witness === 'not_needed' ? 'not_needed' : check.witness === 'skipped' ? 'skipped' : 'awaiting';
      await tx.insert(marAdministrations).values({
        id: marId,
        hospitalId: args.hospitalId,
        branchId: admission.branchId,
        admissionId: admission.id,
        encounterId: admission.encounterId,
        patientId: admission.patientId,
        orderId: order.id,
        medicineId: order.medicineId,
        state: 'given',
        occurredAt: args.occurredAt,
        dose: (args.dose?.trim() || order.dose || '').slice(0, 40) || null,
        quantity: args.quantity,
        reasonCode: check.needsLateReason ? 'late_entry' : null,
        reasonText: check.needsLateReason ? lateReason : null,
        careEntryId,
        witnessStatus,
        presenceProofId,
        controlFlags: check.flags,
        stockStatus,
        stockLocationId,
        ...timing,
        recordedAt: now,
        recordedByUserId: args.actor.userId,
        recordedChannel: origin?.channel ?? args.actor.channel,
        recordedDeviceId: origin?.deviceId ?? null,
        recordedSessionId: origin?.sessionId ?? null,
        clientId: args.clientId,
      });

      if (witnessStatus === 'awaiting') {
        await tx.insert(witnessRequests).values({
          hospitalId: args.hospitalId,
          admissionId: admission.id,
          marId,
          marOccurredAt: args.occurredAt,
          actorUserId: args.actor.userId,
          method: check.witness === 'ward_device' ? 'ward_device' : 'approval',
          deviceId: check.witness === 'ward_device' ? args.actor.wardDeviceId : null,
          witnessUserId: check.witness === 'approval' ? args.witnessUserId : null,
          requestedAt: now,
          expiresAt: new Date(now.getTime() + WITNESS_APPROVAL_MS),
        });
      }
      return { marId, occurredAt: args.occurredAt, witness: check.witness, flags: check.flags, stock: stockStatus, repeat: false };
    },
    clinical,
  );
}

/** A dose not given: held, refused, not available, or omitted, with its reason. */
export async function recordNotGiven(args: {
  hospitalId: string;
  orderId: string;
  occurredAt: Date;
  choice: NotGivenChoice;
  reasonText: string | null;
  clientId: string;
  actor: Actor;
  due?: DueContext;
  now?: Date;
}): Promise<{ marId: string; repeat: boolean }> {
  const now = args.now ?? new Date();
  const text = args.reasonText?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const refusal = notGivenRefusal(args.choice, text);
  if (refusal) throw new MarError(refusal);
  if (args.occurredAt.getTime() > now.getTime() + 5 * 60_000) throw new MarError('The time given is in the future');
  if (now.getTime() - args.occurredAt.getTime() > 48 * 3_600_000) throw new MarError('That was over 48 hours ago. Tell the desk.');
  const { state, reason } = NOT_GIVEN[args.choice];
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const existing = await existingDoseInTx(tx, args.clientId);
      if (existing) return { marId: existing.id, repeat: true };
      const order = await lockOrderInTx(tx, args.orderId);
      if (order.kind === 'instruction') throw new MarError('An instruction has no doses');
      if (order.voidedAt) throw new MarError('This line was struck out');
      const admission = await admissionInBedInTx(tx, order.admissionId, true);
      const timing = await dueTimingInTx(tx, order, args.due ? { ...args.due, enforce: false } : undefined, args.occurredAt);
      const origin = await requestOrigin();
      const [row] = await tx
        .insert(marAdministrations)
        .values({
          hospitalId: args.hospitalId,
          branchId: admission.branchId,
          admissionId: admission.id,
          encounterId: admission.encounterId,
          patientId: admission.patientId,
          orderId: order.id,
          medicineId: order.medicineId,
          state: state as DoseState,
          occurredAt: args.occurredAt,
          reasonCode: reason as ReasonCode,
          reasonText: text,
          dueAt: timing.dueAt,
          timingStatus: timing.dueAt ? null : timing.timingStatus,
          recordedAt: now,
          recordedByUserId: args.actor.userId,
          recordedChannel: origin?.channel ?? args.actor.channel,
          recordedDeviceId: origin?.deviceId ?? null,
          recordedSessionId: origin?.sessionId ?? null,
          clientId: args.clientId,
        })
        .returning({ id: marAdministrations.id });
      return { marId: row.id, repeat: false };
    },
    clinical,
  );
}

/** A timed task (vitals, sugar check, dressing, turning) marked done at the bedside, against its due time. */
export async function recordTaskDone(args: {
  hospitalId: string;
  orderId: string;
  occurredAt: Date;
  note: string | null;
  clientId: string;
  actor: Actor;
  due?: DueContext;
  now?: Date;
}): Promise<{ marId: string; repeat: boolean }> {
  const now = args.now ?? new Date();
  if (args.occurredAt.getTime() > now.getTime() + 5 * 60_000) throw new MarError('The time given is in the future');
  if (now.getTime() - args.occurredAt.getTime() > 48 * 3_600_000) throw new MarError('That was over 48 hours ago. Tell the desk.');
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const existing = await existingDoseInTx(tx, args.clientId);
      if (existing) return { marId: existing.id, repeat: true };
      const order = await lockOrderInTx(tx, args.orderId);
      if (order.kind !== 'task') throw new MarError('Only a task line is marked done');
      if (order.voidedAt || order.stoppedAt) throw new MarError('This line is no longer active');
      const admission = await admissionInBedInTx(tx, order.admissionId, true);
      const timing = await dueTimingInTx(tx, order, args.due ? { ...args.due, enforce: false } : undefined, args.occurredAt);
      const origin = await requestOrigin();
      const [row] = await tx
        .insert(marAdministrations)
        .values({
          hospitalId: args.hospitalId,
          branchId: admission.branchId,
          admissionId: admission.id,
          encounterId: admission.encounterId,
          patientId: admission.patientId,
          orderId: order.id,
          state: 'given',
          occurredAt: args.occurredAt,
          quantity: 0,
          reasonText: args.note?.replace(/\s+/g, ' ').trim().slice(0, 200) || null,
          ...timing,
          recordedAt: now,
          recordedByUserId: args.actor.userId,
          recordedChannel: origin?.channel ?? args.actor.channel,
          recordedDeviceId: origin?.deviceId ?? null,
          recordedSessionId: origin?.sessionId ?? null,
          clientId: args.clientId,
        })
        .returning({ id: marAdministrations.id });
      return { marId: row.id, repeat: false };
    },
    clinical,
  );
}

/**
 * Strikes out a dose recorded in error, by whoever recorded it or the owner,
 * with a reason. Its bedside entry and bill line go with it; an open witness
 * request is withdrawn.
 */
export async function strikeOutDose(args: {
  hospitalId: string;
  marId: string;
  actorUserId: string;
  isOwner: boolean;
  reason: string;
}): Promise<void> {
  const reason = args.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!reason) throw new MarError('Write why the dose is struck out');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [dose] = await tx
        .select({
          id: marAdministrations.id,
          occurredAt: marAdministrations.occurredAt,
          recordedByUserId: marAdministrations.recordedByUserId,
          careEntryId: marAdministrations.careEntryId,
          voidedAt: marAdministrations.voidedAt,
          admissionId: marAdministrations.admissionId,
          stockStatus: marAdministrations.stockStatus,
        })
        .from(marAdministrations)
        .where(eq(marAdministrations.id, args.marId))
        .for('update');
      if (!dose) throw new MarError('Dose not found');
      if (dose.voidedAt) return;
      if (!args.isOwner && dose.recordedByUserId !== args.actorUserId) throw new MarError('Only whoever recorded the dose can strike it out');
      const [admission] = await tx.select({ status: admissions.status }).from(admissions).where(eq(admissions.id, dose.admissionId));
      if (admission?.status === 'discharged') throw new MarError('This stay is discharged and its bill is final. Correct it on the bill.');
      const now = new Date();
      // B4b: what it took off stock goes back, by reversal rows (the ledger is never edited).
      const putBack = dose.stockStatus === 'posted' && (await putBackInTx(tx, { hospitalId: args.hospitalId, subject: { kind: 'dose', id: dose.id }, actorUserId: args.actorUserId, now })) > 0;
      await tx
        .update(marAdministrations)
        .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: reason, ...(putBack ? { stockStatus: 'reversed' as const } : {}) })
        .where(and(eq(marAdministrations.id, dose.id), eq(marAdministrations.occurredAt, dose.occurredAt)));
      if (dose.careEntryId) {
        await tx
          .update(careEntries)
          .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: `Dose struck out: ${reason}` })
          .where(and(eq(careEntries.id, dose.careEntryId), isNull(careEntries.voidedAt)));
        await voidCareEntryLineInTx(tx, { careEntryId: dose.careEntryId, actorUserId: args.actorUserId, reason: `Dose struck out: ${reason}` });
      }
      await tx
        .update(witnessRequests)
        .set({ status: 'withdrawn', decidedAt: now })
        .where(and(eq(witnessRequests.marId, dose.id), eq(witnessRequests.status, 'pending')));
    },
    clinical,
  );
}

/* ================================================================= witness */

export type WitnessRequestRow = {
  id: string;
  /** A give, or a waste (B4b): then `dose` says what was wasted. */
  action: 'give' | 'waste';
  admissionId: string;
  patientName: string;
  bed: string | null;
  description: string;
  dose: string | null;
  route: string | null;
  occurredAt: Date;
  actorUserId: string;
  actorName: string;
  requestedAt: Date;
  expiresAt: Date;
};

async function listRequestsInTx(tx: Tx, where: ReturnType<typeof and>): Promise<WitnessRequestRow[]> {
  const actor = aliasedTable(users, 'actor');
  const rows = await tx.execute<{
    id: string;
    action: 'give' | 'waste';
    admission_id: string;
    patient_name: string;
    bed: string | null;
    description: string;
    dose: string | null;
    route: string | null;
    occurred_at: string;
    actor_user_id: string;
    actor_name: string;
    requested_at: string;
    expires_at: string;
  }>(sql`
    select r.id, r.action, r.admission_id, p.name as patient_name,
      (select w.name || ' · Bed ' || b.label from bed_assignments ba join beds b on b.id = ba.bed_id join wards w on w.id = b.ward_id
        where ba.admission_id = r.admission_id and ba.to_at is null limit 1) as bed,
      o.description,
      case when r.action = 'waste'
        then 'Waste: ' || concat_ws(' · ', case when x.units > 0 then x.units || ' unit' || case when x.units > 1 then 's' else '' end end, x.amount)
        else m.dose end as dose,
      o.route, coalesce(m.occurred_at, x.occurred_at) as occurred_at, r.actor_user_id, ${actor.name} as actor_name, r.requested_at, r.expires_at
    from witness_requests r
    left join mar_administrations m on m.id = r.mar_id and m.occurred_at = r.mar_occurred_at
    left join mar_wastes x on x.id = r.waste_id
    join treatment_orders o on o.id = coalesce(m.order_id, x.order_id)
    join patients p on p.id = coalesce(m.patient_id, x.patient_id)
    join users ${actor} on ${actor.id} = r.actor_user_id
    where r.status = 'pending' and ${where}
    order by r.requested_at
  `);
  return [...rows].map((r) => ({
    id: r.id,
    action: r.action,
    admissionId: r.admission_id,
    patientName: r.patient_name,
    bed: r.bed,
    description: r.description,
    dose: r.dose,
    route: r.route,
    occurredAt: new Date(r.occurred_at),
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    requestedAt: new Date(r.requested_at),
    expiresAt: new Date(r.expires_at),
  }));
}

/** Doses on this ward tablet waiting for someone to witness them with their PIN. */
export async function listDeviceWitnessRequests(args: { hospitalId: string; deviceId: string; now?: Date }): Promise<WitnessRequestRow[]> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    (tx) => listRequestsInTx(tx, and(sql`r.method = 'ward_device'`, sql`r.device_id = ${args.deviceId}`, sql`r.expires_at > ${now.toISOString()}::timestamptz`)),
    clinical,
  );
}

/** Doses someone has asked me to witness, from my own session. */
export async function listMyWitnessRequests(args: { hospitalId: string; userId: string; now?: Date }): Promise<WitnessRequestRow[]> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    (tx) => listRequestsInTx(tx, and(sql`r.method = 'approval'`, sql`r.witness_user_id = ${args.userId}::uuid`, sql`r.expires_at > ${now.toISOString()}::timestamptz`)),
    clinical,
  );
}

export async function countMyWitnessRequests(args: { hospitalId: string; userId: string; now?: Date }): Promise<number> {
  const now = args.now ?? new Date();
  const [row] = await withTenant(
    args.hospitalId,
    (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(witnessRequests)
        .where(
          and(
            eq(witnessRequests.status, 'pending'),
            eq(witnessRequests.method, 'approval'),
            eq(witnessRequests.witnessUserId, args.userId),
            sql`${witnessRequests.expiresAt} > ${now.toISOString()}::timestamptz`,
          ),
        ),
    clinical,
  );
  return row?.n ?? 0;
}

/** Doctors and nurses who can be asked to witness, not the person asking. */
export async function listWitnessCandidates(hospitalId: string, exceptUserId: string) {
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({ userId: users.id, name: users.name, role: staffMemberships.role })
      .from(staffMemberships)
      .innerJoin(users, eq(users.id, staffMemberships.userId))
      .where(and(eq(staffMemberships.active, true), eq(users.active, true), ne(users.id, exceptUserId)))
      .orderBy(asc(users.name)),
  );
  return rows.filter((r) => CLINICAL_PERSON_ROLES.includes(r.role));
}

async function approveInTx(
  tx: Tx,
  args: { requestId: string; witnessUserId: string; channel: 'personal' | 'ward_device'; deviceId: string | null; sessionId: string | null; now: Date },
) {
  const [request] = await tx
    .select()
    .from(witnessRequests)
    .where(eq(witnessRequests.id, args.requestId))
    .for('update');
  if (!request) throw new MarError('Witness request not found');
  if (request.status !== 'pending' || request.expiresAt <= args.now) throw new MarError('This request has closed. Ask the nurse to ask again.');
  if (request.actorUserId === args.witnessUserId) {
    throw new MarError(request.action === 'waste' ? 'You recorded this waste; someone else must witness it' : 'You gave this dose; someone else must witness it');
  }
  await assertWitnessCandidateInTx(tx, { witnessUserId: args.witnessUserId, actorUserId: request.actorUserId });
  await tx
    .update(witnessRequests)
    .set({
      status: 'approved',
      witnessUserId: args.witnessUserId,
      decidedAt: args.now,
      decidedChannel: args.channel,
      decidedDeviceId: args.deviceId,
      decidedSessionId: args.sessionId,
    })
    .where(eq(witnessRequests.id, request.id));
  if (request.action === 'waste') {
    await witnessWasteInTx(tx, { wasteId: request.wasteId!, witnessUserId: args.witnessUserId, now: args.now });
    return;
  }
  await tx
    .update(marAdministrations)
    .set({ witnessStatus: 'witnessed', witnessedByUserId: args.witnessUserId, witnessedAt: args.now })
    .where(
      and(
        eq(marAdministrations.id, request.marId!),
        eq(marAdministrations.occurredAt, request.marOccurredAt!),
        inArray(marAdministrations.witnessStatus, ['awaiting', 'skipped']),
        isNull(marAdministrations.voidedAt),
      ),
    );
}

/** A waste is witnessed: only now do its units come off stock (D-WITNESS: nothing is decremented before). */
async function witnessWasteInTx(tx: Tx, args: { wasteId: string; witnessUserId: string; now: Date }) {
  const [waste] = await tx.select().from(marWastes).where(eq(marWastes.id, args.wasteId)).for('update');
  if (!waste || waste.voidedAt || waste.witnessStatus !== 'awaiting') return;
  let stockStatus: 'posted' | 'short' | null = null;
  if (waste.units > 0 && waste.locationId) {
    stockStatus = await drawInTx(tx, {
      hospitalId: waste.hospitalId,
      subject: { kind: 'waste', id: waste.id },
      locationId: waste.locationId,
      medicineId: waste.medicineId,
      units: waste.units,
      occurredAt: waste.occurredAt,
      actorUserId: waste.recordedByUserId,
      now: args.now,
    });
  }
  await tx
    .update(marWastes)
    .set({ witnessStatus: 'witnessed', witnessedByUserId: args.witnessUserId, witnessedAt: args.now, stockStatus })
    .where(eq(marWastes.id, waste.id));
}

/**
 * Witness on the shared ward tablet: the witness picks their name and enters
 * their own PIN on it (D-WITNESS (a)). Only on a ward-tablet session; a wrong
 * PIN is counted against the person and the tablet like an unlock.
 */
export async function witnessOnDevice(args: {
  hospitalId: string;
  requestId: string;
  device: WardDevice;
  witnessUserId: string;
  pin: string;
  sessionId: string | null;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  const [request] = await withTenant(
    args.hospitalId,
    (tx) => tx.select({ method: witnessRequests.method, deviceId: witnessRequests.deviceId }).from(witnessRequests).where(eq(witnessRequests.id, args.requestId)),
    clinical,
  );
  if (!request || request.method !== 'ward_device' || request.deviceId !== args.device.id) throw new MarError('Witness request not found on this tablet');
  const pin = await verifyWitnessPin({ device: args.device, userId: args.witnessUserId, pin: args.pin, now });
  if (!pin.ok) throw new MarError(pin.error);
  await withTenant(
    args.hospitalId,
    (tx) => approveInTx(tx, { requestId: args.requestId, witnessUserId: args.witnessUserId, channel: 'ward_device', deviceId: args.device.id, sessionId: args.sessionId, now }),
    clinical,
  );
}

/**
 * Witness from one's own signed-in session (D-WITNESS (b)): only the person
 * asked, within 10 minutes. Declining leaves the dose waiting for someone else.
 */
export async function decideWitnessRequest(args: {
  hospitalId: string;
  requestId: string;
  userId: string;
  approve: boolean;
  channel: 'personal' | 'ward_device';
  deviceId: string | null;
  sessionId: string | null;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [request] = await tx
        .select({ witnessUserId: witnessRequests.witnessUserId, method: witnessRequests.method })
        .from(witnessRequests)
        .where(eq(witnessRequests.id, args.requestId));
      if (!request || request.method !== 'approval' || request.witnessUserId !== args.userId) throw new MarError('Witness request not found');
      if (args.approve) {
        await approveInTx(tx, { requestId: args.requestId, witnessUserId: args.userId, channel: args.channel, deviceId: args.deviceId, sessionId: args.sessionId, now });
        return;
      }
      const updated = await tx
        .update(witnessRequests)
        .set({ status: 'declined', decidedAt: now, decidedChannel: args.channel, decidedDeviceId: args.deviceId, decidedSessionId: args.sessionId })
        .where(and(eq(witnessRequests.id, args.requestId), eq(witnessRequests.status, 'pending')))
        .returning({ id: witnessRequests.id });
      if (updated.length === 0) throw new MarError('This request has closed');
    },
    clinical,
  );
}

/** The nurse asks again (a request closed, or there was no witness at the time): on this tablet, or of a named person. */
export async function askWitnessAgain(args: {
  hospitalId: string;
  /** The dose, or (B4b) the waste, that needs its witness. */
  marId?: string;
  wasteId?: string;
  witnessUserId: string | null;
  actor: Actor;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await withTenant(
    args.hospitalId,
    async (tx) => {
      let subject: { admissionId: string; mar: { id: string; occurredAt: Date } | null; wasteId: string | null };
      if (args.wasteId) {
        const [waste] = await tx
          .select({ id: marWastes.id, admissionId: marWastes.admissionId, recordedByUserId: marWastes.recordedByUserId, witnessStatus: marWastes.witnessStatus, voidedAt: marWastes.voidedAt })
          .from(marWastes)
          .where(eq(marWastes.id, args.wasteId))
          .for('update');
        if (!waste || waste.voidedAt) throw new MarError('Waste not found');
        if (waste.recordedByUserId !== args.actor.userId) throw new MarError('Only whoever recorded the waste can ask for its witness');
        if (waste.witnessStatus !== 'awaiting') throw new MarError('This waste is already witnessed');
        subject = { admissionId: waste.admissionId, mar: null, wasteId: waste.id };
      } else {
        const [dose] = await tx
          .select({
            id: marAdministrations.id,
            occurredAt: marAdministrations.occurredAt,
            admissionId: marAdministrations.admissionId,
            recordedByUserId: marAdministrations.recordedByUserId,
            witnessStatus: marAdministrations.witnessStatus,
            voidedAt: marAdministrations.voidedAt,
          })
          .from(marAdministrations)
          .where(eq(marAdministrations.id, args.marId ?? ''))
          .for('update');
        if (!dose || dose.voidedAt) throw new MarError('Dose not found');
        if (dose.recordedByUserId !== args.actor.userId) throw new MarError('Only whoever gave the dose can ask for its witness');
        if (dose.witnessStatus !== 'awaiting' && dose.witnessStatus !== 'skipped') throw new MarError('This dose needs no witness now');
        subject = { admissionId: dose.admissionId, mar: { id: dose.id, occurredAt: dose.occurredAt }, wasteId: null };
      }
      await insertWitnessRequestInTx(tx, { hospitalId: args.hospitalId, ...subject, witnessUserId: args.witnessUserId, actor: args.actor, now });
    },
    clinical,
  );
}

/** Withdraws any open request for the dose or waste and opens a new one: on this tablet, or of the named person. */
async function insertWitnessRequestInTx(
  tx: Tx,
  args: { hospitalId: string; admissionId: string; mar: { id: string; occurredAt: Date } | null; wasteId: string | null; witnessUserId: string | null; actor: Actor; now: Date },
) {
  const method = args.actor.channel === 'ward_device' && !args.witnessUserId ? 'ward_device' : 'approval';
  if (method === 'approval') {
    if (!args.witnessUserId) throw new MarError(args.wasteId ? 'Choose who will witness this waste' : 'Choose who will witness this dose');
    await assertWitnessCandidateInTx(tx, { witnessUserId: args.witnessUserId, actorUserId: args.actor.userId });
  } else if (!args.actor.wardDeviceId) throw new MarError('Ward tablet not found');
  await tx
    .update(witnessRequests)
    .set({ status: 'withdrawn', decidedAt: args.now })
    .where(and(args.wasteId ? eq(witnessRequests.wasteId, args.wasteId) : eq(witnessRequests.marId, args.mar!.id), eq(witnessRequests.status, 'pending')));
  await tx.insert(witnessRequests).values({
    hospitalId: args.hospitalId,
    admissionId: args.admissionId,
    action: args.wasteId ? 'waste' : 'give',
    marId: args.mar?.id ?? null,
    marOccurredAt: args.mar?.occurredAt ?? null,
    wasteId: args.wasteId,
    actorUserId: args.actor.userId,
    method,
    deviceId: method === 'ward_device' ? args.actor.wardDeviceId : null,
    witnessUserId: method === 'approval' ? args.witnessUserId : null,
    requestedAt: args.now,
    expiresAt: new Date(args.now.getTime() + WITNESS_APPROVAL_MS),
  });
}

/* =================================================================== waste */

/**
 * Records a risk-class medicine wasted (B4b, D-WITNESS): broken, dropped,
 * drawn up and not given, or the rest of an opened ampoule. It always needs a
 * second person — on the ward tablet, or by approval from the named witness —
 * and nothing comes off stock until they confirm it. Whole units come off
 * the ward's store (or the one chosen); a remainder only records the amount.
 */
export async function recordWaste(args: {
  hospitalId: string;
  orderId: string;
  /** The dose it was left over from, if any. */
  marId: string | null;
  occurredAt: Date;
  waste: WasteInput;
  locationId: string | null;
  witnessUserId: string | null;
  clientId: string;
  actor: Actor;
  /** Whether risk-class stock is in use for the patient's ward, as for a give. */
  stockOn: boolean | ((wardId: string | null) => boolean);
  now?: Date;
}): Promise<{ wasteId: string; repeat: boolean }> {
  const now = args.now ?? new Date();
  if (args.occurredAt.getTime() > now.getTime() + 5 * 60_000) throw new MarError('The time given is in the future');
  if (now.getTime() - args.occurredAt.getTime() > 48 * 3_600_000) throw new MarError('That was over 48 hours ago. Tell the desk.');
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [existing] = await tx.select({ id: marWastes.id }).from(marWastes).where(eq(marWastes.clientId, args.clientId));
      if (existing) return { wasteId: existing.id, repeat: true };
      const order = await lockOrderInTx(tx, args.orderId);
      if (order.kind !== 'medicine' || !order.medicineId) throw new MarError('Only a medicine line can have waste');
      if (order.voidedAt) throw new MarError('This line was struck out');
      const admission = await admissionInBedInTx(tx, order.admissionId, true);
      if (!(await riskOfMedicineInTx(tx, order.medicineId))) throw new MarError('Waste is recorded for risk-class medicines only');
      let mar: { id: string; occurredAt: Date } | null = null;
      if (args.marId) {
        const [dose] = await tx
          .select({ id: marAdministrations.id, occurredAt: marAdministrations.occurredAt, orderId: marAdministrations.orderId, state: marAdministrations.state, voidedAt: marAdministrations.voidedAt })
          .from(marAdministrations)
          .where(eq(marAdministrations.id, args.marId));
        if (!dose || dose.voidedAt || dose.orderId !== order.id || dose.state !== 'given') throw new MarError('That dose is not a give on this line');
        mar = { id: dose.id, occurredAt: dose.occurredAt };
      }
      // Whole units come off the ward's store once witnessed; without stock in use on the ward it is recorded only.
      const wardId = await currentWardInTx(tx, admission.id);
      const stockOn = typeof args.stockOn === 'function' ? args.stockOn(wardId) : args.stockOn;
      const locationId = args.waste.units > 0 && stockOn ? await storeForInTx(tx, admission.id, args.locationId) : null;
      if (args.waste.units > 0 && stockOn && !locationId) throw new MarError('This ward has no store set up. Ask the owner to add it under Stock.');
      const origin = await requestOrigin();
      const [row] = await tx
        .insert(marWastes)
        .values({
          hospitalId: args.hospitalId,
          branchId: admission.branchId,
          admissionId: admission.id,
          encounterId: admission.encounterId,
          patientId: admission.patientId,
          orderId: order.id,
          medicineId: order.medicineId,
          marId: mar?.id ?? null,
          marOccurredAt: mar?.occurredAt ?? null,
          locationId,
          units: args.waste.units,
          amount: args.waste.amount,
          reasonCode: args.waste.reason,
          reasonText: args.waste.reasonText,
          occurredAt: args.occurredAt,
          recordedAt: now,
          recordedByUserId: args.actor.userId,
          recordedChannel: origin?.channel ?? args.actor.channel,
          recordedDeviceId: origin?.deviceId ?? null,
          recordedSessionId: origin?.sessionId ?? null,
          clientId: args.clientId,
        })
        .returning({ id: marWastes.id });
      await insertWitnessRequestInTx(tx, { hospitalId: args.hospitalId, admissionId: admission.id, mar: null, wasteId: row.id, witnessUserId: args.witnessUserId, actor: args.actor, now });
      return { wasteId: row.id, repeat: false };
    },
    clinical,
  );
}

/** Strikes out a waste recorded in error: its request is withdrawn, and any stock it took is put back. */
export async function strikeOutWaste(args: { hospitalId: string; wasteId: string; actorUserId: string; isOwner: boolean; reason: string }): Promise<void> {
  const reason = args.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!reason) throw new MarError('Write why the waste is struck out');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [waste] = await tx.select().from(marWastes).where(eq(marWastes.id, args.wasteId)).for('update');
      if (!waste) throw new MarError('Waste not found');
      if (waste.voidedAt) return;
      if (!args.isOwner && waste.recordedByUserId !== args.actorUserId) throw new MarError('Only whoever recorded the waste can strike it out');
      const now = new Date();
      const putBack = waste.stockStatus === 'posted' && (await putBackInTx(tx, { hospitalId: args.hospitalId, subject: { kind: 'waste', id: waste.id }, actorUserId: args.actorUserId, now })) > 0;
      await tx
        .update(marWastes)
        .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: reason, ...(putBack ? { stockStatus: 'reversed' as const } : {}) })
        .where(eq(marWastes.id, waste.id));
      await tx
        .update(witnessRequests)
        .set({ status: 'withdrawn', decidedAt: now })
        .where(and(eq(witnessRequests.wasteId, waste.id), eq(witnessRequests.status, 'pending')));
    },
    clinical,
  );
}

export type CardWaste = {
  id: string;
  orderId: string;
  marId: string | null;
  occurredAt: Date;
  units: number;
  amount: string | null;
  reason: WasteReason;
  reasonLabel: string;
  reasonText: string | null;
  recordedBy: string | null;
  recordedByUserId: string | null;
  witnessStatus: 'awaiting' | 'witnessed';
  witnessedBy: string | null;
  stockStatus: 'posted' | 'short' | 'reversed' | null;
  voided: boolean;
  voidReason: string | null;
  pendingRequest: { method: 'ward_device' | 'approval'; witnessName: string | null } | null;
};

/** The wastes of one stay in a time window, for the treatment card. */
export async function listWastes(args: { hospitalId: string; admissionId: string; from: Date; to: Date }): Promise<CardWaste[]> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const recorder = aliasedTable(users, 'recorder');
      const witness = aliasedTable(users, 'witness');
      const asked = aliasedTable(users, 'asked');
      const rows = await tx
        .select({
          id: marWastes.id,
          orderId: marWastes.orderId,
          marId: marWastes.marId,
          occurredAt: marWastes.occurredAt,
          units: marWastes.units,
          amount: marWastes.amount,
          reason: marWastes.reasonCode,
          reasonText: marWastes.reasonText,
          recordedBy: recorder.name,
          recordedByUserId: marWastes.recordedByUserId,
          witnessStatus: marWastes.witnessStatus,
          witnessedBy: witness.name,
          stockStatus: marWastes.stockStatus,
          voidedAt: marWastes.voidedAt,
          voidReason: marWastes.voidReason,
          requestMethod: witnessRequests.method,
          requestWitness: asked.name,
        })
        .from(marWastes)
        .leftJoin(recorder, eq(recorder.id, marWastes.recordedByUserId))
        .leftJoin(witness, eq(witness.id, marWastes.witnessedByUserId))
        .leftJoin(witnessRequests, and(eq(witnessRequests.wasteId, marWastes.id), eq(witnessRequests.status, 'pending')))
        .leftJoin(asked, eq(asked.id, witnessRequests.witnessUserId))
        .where(and(eq(marWastes.admissionId, args.admissionId), gte(marWastes.occurredAt, args.from), lt(marWastes.occurredAt, args.to)))
        .orderBy(asc(marWastes.occurredAt));
      return rows.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        marId: r.marId,
        occurredAt: r.occurredAt,
        units: r.units,
        amount: r.amount,
        reason: r.reason,
        reasonLabel: WASTE_REASONS[r.reason],
        reasonText: r.reasonText,
        recordedBy: r.recordedBy,
        recordedByUserId: r.recordedByUserId,
        witnessStatus: r.witnessStatus,
        witnessedBy: r.witnessedBy,
        stockStatus: r.stockStatus,
        voided: Boolean(r.voidedAt),
        voidReason: r.voidReason,
        pendingRequest: r.requestMethod ? { method: r.requestMethod, witnessName: r.requestWitness } : null,
      }));
    },
    clinical,
  );
}

/** The stores of a patient's ward a nurse can take a dose from (B4b): to choose when there is more than one. */
export async function listWardStoresFor(hospitalId: string, admissionId: string) {
  return withTenant(hospitalId, async (tx) => wardStoresInTx(tx, await currentWardInTx(tx, admissionId)), clinical);
}

/* ============================================================ stock (B4b) */

export type StockToResolve = {
  kind: 'dose' | 'waste';
  id: string;
  /** short: saved, but no store could cover it; awaiting_witness: a waste not yet confirmed (nothing taken off). */
  status: 'short' | 'awaiting_witness';
  occurredAt: Date;
  admissionId: string;
  patientName: string;
  bed: string | null;
  description: string;
  medicineId: string;
  units: number;
  storeId: string | null;
  storeName: string | null;
  recordedBy: string | null;
};

/**
 * What the stock page must still settle from the treatment card: doses and
 * wastes that no store could cover (to take off by hand), and wastes still
 * waiting for their witness after 15 minutes (nothing is taken off until
 * then). Names the patient, so it reads with the clinical key.
 */
export async function listStockToResolve(args: { hospitalId: string; now?: Date }): Promise<StockToResolve[]> {
  const now = args.now ?? new Date();
  const rows = await withTenant(
    args.hospitalId,
    (tx) =>
      tx.execute<{
        kind: 'dose' | 'waste';
        id: string;
        status: 'short' | 'awaiting_witness';
        occurred_at: string;
        admission_id: string;
        patient_name: string;
        bed: string | null;
        description: string;
        medicine_id: string;
        units: number;
        store_id: string | null;
        store_name: string | null;
        recorded_by: string | null;
      }>(sql`
        with items as (
          select 'dose' as kind, m.id, 'short' as status, m.occurred_at, m.admission_id, m.patient_id, m.order_id, m.medicine_id,
            m.quantity::int as units, m.stock_location_id as store_id, m.recorded_by_user_id
          from mar_administrations m
          where m.stock_status = 'short' and m.voided_at is null
          union all
          select 'waste', w.id, case when w.witness_status = 'awaiting' then 'awaiting_witness' else 'short' end, w.occurred_at,
            w.admission_id, w.patient_id, w.order_id, w.medicine_id, w.units::int, w.location_id, w.recorded_by_user_id
          from mar_wastes w
          where w.voided_at is null and (w.stock_status = 'short'
            or (w.witness_status = 'awaiting' and w.recorded_at <= ${now.toISOString()}::timestamptz - make_interval(secs => ${WITNESS_LATE_MS / 1000})))
        )
        select i.kind, i.id, i.status, i.occurred_at, i.admission_id, p.name as patient_name,
          (select wd.name || ' · Bed ' || b.label from bed_assignments ba join beds b on b.id = ba.bed_id join wards wd on wd.id = b.ward_id
            where ba.admission_id = i.admission_id order by ba.from_at desc limit 1) as bed,
          o.description, i.medicine_id, i.units, i.store_id, l.name as store_name, u.name as recorded_by
        from items i
        join patients p on p.id = i.patient_id
        join treatment_orders o on o.id = i.order_id
        left join stock_locations l on l.id = i.store_id
        left join users u on u.id = i.recorded_by_user_id
        order by i.occurred_at
      `),
    clinical,
  );
  return [...rows].map((r) => ({
    kind: r.kind,
    id: r.id,
    status: r.status,
    occurredAt: new Date(r.occurred_at),
    admissionId: r.admission_id,
    patientName: r.patient_name,
    bed: r.bed,
    description: r.description,
    medicineId: r.medicine_id,
    units: Number(r.units),
    storeId: r.store_id,
    storeName: r.store_name,
    recordedBy: r.recorded_by,
  }));
}

/**
 * Takes a short dose or waste off a store by hand, once that store holds it
 * (stock arrived, or it came from another store). Whoever does this is in the
 * evidence log; it is all or nothing, as at the bedside.
 */
export async function postShortByHand(args: {
  hospitalId: string;
  kind: 'dose' | 'waste';
  id: string;
  locationId: string;
  actorUserId: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [store] = await tx.select({ id: stockLocations.id, active: stockLocations.active }).from(stockLocations).where(eq(stockLocations.id, args.locationId));
      if (!store?.active) throw new MarError('Choose an open store');
      if (args.kind === 'dose') {
        const [dose] = await tx
          .select({ id: marAdministrations.id, occurredAt: marAdministrations.occurredAt, medicineId: marAdministrations.medicineId, quantity: marAdministrations.quantity, stockStatus: marAdministrations.stockStatus, voidedAt: marAdministrations.voidedAt })
          .from(marAdministrations)
          .where(eq(marAdministrations.id, args.id))
          .for('update');
        if (!dose || dose.voidedAt || dose.stockStatus !== 'short' || !dose.medicineId || !dose.quantity) throw new MarError('This dose has nothing waiting to come off stock');
        const result = await drawInTx(tx, { hospitalId: args.hospitalId, subject: { kind: 'dose', id: dose.id }, locationId: store.id, medicineId: dose.medicineId, units: dose.quantity, occurredAt: dose.occurredAt, actorUserId: args.actorUserId, now });
        if (result === 'short') throw new MarError('That store does not hold enough of it (unexpired). Receive or send it there first.');
        await tx
          .update(marAdministrations)
          .set({ stockStatus: 'posted', stockLocationId: store.id })
          .where(and(eq(marAdministrations.id, dose.id), eq(marAdministrations.occurredAt, dose.occurredAt)));
        return;
      }
      const [waste] = await tx.select().from(marWastes).where(eq(marWastes.id, args.id)).for('update');
      if (!waste || waste.voidedAt || waste.stockStatus !== 'short') throw new MarError('This waste has nothing waiting to come off stock');
      const result = await drawInTx(tx, { hospitalId: args.hospitalId, subject: { kind: 'waste', id: waste.id }, locationId: store.id, medicineId: waste.medicineId, units: waste.units, occurredAt: waste.occurredAt, actorUserId: args.actorUserId, now });
      if (result === 'short') throw new MarError('That store does not hold enough of it (unexpired). Receive or send it there first.');
      await tx.update(marWastes).set({ stockStatus: 'posted', locationId: store.id }).where(eq(marWastes.id, waste.id));
    },
    clinical,
  );
}

export type RegisterRow = {
  kind: 'give' | 'waste';
  id: string;
  occurredAt: Date;
  patientName: string;
  ipdNumber: number | null;
  dose: string | null;
  units: number;
  amount: string | null;
  batches: string | null;
  storeName: string | null;
  recordedBy: string | null;
  witnessedBy: string | null;
  stockStatus: 'posted' | 'short' | 'reversed' | null;
  /** Why it was wasted (a waste), in words. */
  reason: string | null;
  note: string | null;
  voided: boolean;
};

/**
 * The patient-wise account of one risk-class medicine over a period (the
 * shape of the NDPS Form 3E — wording still to be confirmed, D-DRUG): every
 * give and waste from the treatment card, with patient, batch, store, who
 * gave it and who witnessed. Struck-out rows stay, marked.
 */
export async function getDoseRegister(args: { hospitalId: string; medicineId: string; from: Date; to: Date }): Promise<RegisterRow[]> {
  const rows = await withTenant(
    args.hospitalId,
    (tx) =>
      tx.execute<{
        kind: 'give' | 'waste';
        id: string;
        occurred_at: string;
        patient_name: string;
        ipd_number: number | null;
        dose: string | null;
        units: number;
        amount: string | null;
        batches: string | null;
        store_name: string | null;
        recorded_by: string | null;
        witnessed_by: string | null;
        stock_status: 'posted' | 'short' | 'reversed' | null;
        reason: WasteReason | null;
        note: string | null;
        voided: boolean;
      }>(sql`
        with items as (
          select 'give' as kind, m.id, m.occurred_at, m.admission_id, m.patient_id, m.dose, coalesce(m.quantity, 0)::int as units, null::text as amount,
            m.stock_location_id as store_id, m.recorded_by_user_id, m.witnessed_by_user_id, m.stock_status, null::text as reason, m.void_reason as note,
            m.voided_at is not null as voided, 'mar:' || m.id || ':%' as ref
          from mar_administrations m
          where m.medicine_id = ${args.medicineId}::uuid and m.state = 'given'
            and m.occurred_at >= ${args.from.toISOString()}::timestamptz and m.occurred_at < ${args.to.toISOString()}::timestamptz
          union all
          select 'waste', w.id, w.occurred_at, w.admission_id, w.patient_id, null, w.units::int, w.amount, w.location_id, w.recorded_by_user_id,
            w.witnessed_by_user_id, w.stock_status, w.reason_code, coalesce(w.void_reason, w.reason_text), w.voided_at is not null, 'waste:' || w.id || ':%'
          from mar_wastes w
          where w.medicine_id = ${args.medicineId}::uuid
            and w.occurred_at >= ${args.from.toISOString()}::timestamptz and w.occurred_at < ${args.to.toISOString()}::timestamptz
        )
        select i.kind, i.id, i.occurred_at, p.name as patient_name, a.ipd_number, i.dose, i.units, i.amount,
          (select string_agg(b.batch_no || ' ×' || (-g.quantity), ', ' order by b.expiry_date)
             from stock_ledger g join stock_batches b on b.id = g.batch_id
            where g.reference_key like i.ref) as batches,
          l.name as store_name, ru.name as recorded_by, wu.name as witnessed_by, i.stock_status, i.reason, i.note, i.voided
        from items i
        join patients p on p.id = i.patient_id
        join admissions a on a.id = i.admission_id
        left join stock_locations l on l.id = i.store_id
        left join users ru on ru.id = i.recorded_by_user_id
        left join users wu on wu.id = i.witnessed_by_user_id
        order by i.occurred_at
      `),
    clinical,
  );
  return [...rows].map((r) => ({
    kind: r.kind,
    id: r.id,
    occurredAt: new Date(r.occurred_at),
    patientName: r.patient_name,
    ipdNumber: r.ipd_number,
    dose: r.dose,
    units: Number(r.units),
    amount: r.amount,
    batches: r.batches,
    storeName: r.store_name,
    recordedBy: r.recorded_by,
    witnessedBy: r.witnessed_by,
    stockStatus: r.stock_status,
    reason: r.reason ? WASTE_REASONS[r.reason] : null,
    note: r.note,
    voided: r.voided,
  }));
}

/* ================================================================ presence */

/** Gives every bed of the hospital (or one ward) without a code a new one. Codes never change once given. */
export async function ensureBedCodes(hospitalId: string, wardId: string | null = null): Promise<number> {
  let assigned = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      assigned += await withTenant(hospitalId, async (tx) => {
        const missing = await tx
          .select({ id: beds.id })
          .from(beds)
          .where(and(isNull(beds.bedCode), wardId ? eq(beds.wardId, wardId) : undefined));
        for (const bed of missing) {
          await tx.update(beds).set({ bedCode: newBedCode() }).where(and(eq(beds.id, bed.id), isNull(beds.bedCode)));
        }
        return missing.length;
      });
      return assigned;
    } catch (err) {
      // Two beds drew the same code (1 in ~900 million per pair): draw again.
      const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
      if (code !== '23505') throw err;
    }
  }
  throw new Error('Could not give the beds unique codes');
}

export async function listBedCodes(hospitalId: string, wardId: string | null) {
  await ensureBedCodes(hospitalId, wardId);
  return withTenant(hospitalId, (tx) =>
    tx
      .select({ id: beds.id, label: beds.label, code: beds.bedCode, wardId: wards.id, wardName: wards.name })
      .from(beds)
      .innerJoin(wards, eq(wards.id, beds.wardId))
      .where(and(eq(beds.active, true), wardId ? eq(beds.wardId, wardId) : undefined))
      .orderBy(asc(wards.sortOrder), asc(wards.name), asc(beds.sortOrder), asc(beds.label)),
  );
}

/**
 * The nurse typed (or scanned) the code on the patient's bed: proof of being
 * at the bedside for the next 5 minutes. The code must be the bed the patient
 * is in now.
 */
export async function proveAtBed(args: { hospitalId: string; admissionId: string; code: string; method?: 'code' | 'qr'; actor: Actor; now?: Date }): Promise<void> {
  const code = normaliseBedCode(args.code);
  if (!code) throw new MarError('A bed code is 6 letters and numbers, as printed on the bed');
  const now = args.now ?? new Date();
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [bed] = await tx
        .select({ id: beds.id, code: beds.bedCode })
        .from(bedAssignments)
        .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
        .where(and(eq(bedAssignments.admissionId, args.admissionId), isNull(bedAssignments.toAt)));
      if (!bed) throw new MarError('This patient is not in a bed');
      if (!bed.code) throw new MarError('This bed has no code yet. Ask the owner to print the bed codes.');
      if (bed.code !== code) {
        await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actor.userId, action: 'mar.bed_code_wrong', objectType: 'admission', objectId: args.admissionId });
        throw new MarError('That is not the code on this patient’s bed');
      }
      const origin = await requestOrigin();
      await tx.insert(presenceProofs).values({
        hospitalId: args.hospitalId,
        admissionId: args.admissionId,
        bedId: bed.id,
        userId: args.actor.userId,
        method: args.method ?? 'code',
        provedAt: now,
        channel: origin?.channel ?? args.actor.channel,
        deviceId: origin?.deviceId ?? null,
        sessionId: origin?.sessionId ?? null,
      });
    },
    clinical,
  );
}

/* ================================================================ the card */

export type CardOrder = {
  id: string;
  kind: 'medicine' | 'instruction' | 'task';
  taskKind: TaskKind | null;
  timing: Timing | null;
  timeCritical: boolean;
  tcBefore: number | null;
  tcAfter: number | null;
  medicineId: string | null;
  description: string;
  dose: string | null;
  route: Route | null;
  frequency: string | null;
  instructions: string | null;
  orderedAt: Date;
  doctorName: string;
  doctorUserId: string | null;
  enteredBy: string | null;
  enteredByUserId: string | null;
  transcribed: boolean;
  countersignedAt: Date | null;
  stoppedAt: Date | null;
  stopReason: string | null;
  status: OrderStatus;
  risk: { className: string; kind: string; needsWitness: boolean } | null;
  dosesRecorded: number;
  /** B2: the allergies matched when the line was written, and why the doctor went ahead. */
  allergyMatches: string[];
  allergyOverrideReason: string | null;
};

export type CardDose = {
  id: string;
  orderId: string;
  state: DoseState;
  occurredAt: Date;
  dueAt: Date | null;
  timingStatus: 'on_time' | 'late' | 'early' | 'unscheduled' | null;
  delayMin: number | null;
  timingReason: string | null;
  dose: string | null;
  quantity: number | null;
  reasonCode: ReasonCode | null;
  reasonText: string | null;
  recordedBy: string | null;
  recordedByUserId: string | null;
  witnessStatus: 'not_needed' | 'awaiting' | 'witnessed' | 'skipped';
  witnessedBy: string | null;
  flags: ControlFlag[];
  voidedAt: Date | null;
  voidReason: string | null;
  pendingRequest: { id: string; method: 'ward_device' | 'approval'; witnessName: string | null; expiresAt: Date } | null;
  stockStatus: 'posted' | 'short' | 'reversed' | null;
};

/**
 * The treatment card of one stay and the doses of one chart day (8 am–8 am,
 * like the paper): every line, active first, with its risk class and how many
 * doses it has; each dose with who gave it, its witness and its flags.
 */
export async function getTreatmentCard(args: {
  hospitalId: string;
  admissionId: string;
  day: string;
  /** For the print: doses from `day` through `toDay`. */
  toDay?: string;
  timezone: string;
}): Promise<{ orders: CardOrder[]; doses: CardDose[] }> {
  const window = { from: chartDayWindow(args.day, args.timezone).from, to: chartDayWindow(args.toDay ?? args.day, args.timezone).to };
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const entered = aliasedTable(users, 'entered');
      const orderRows = await tx
        .select({
          id: treatmentOrders.id,
          kind: treatmentOrders.kind,
          medicineId: treatmentOrders.medicineId,
          description: treatmentOrders.description,
          dose: treatmentOrders.dose,
          route: treatmentOrders.route,
          frequency: treatmentOrders.frequency,
          instructions: treatmentOrders.instructions,
          orderedAt: treatmentOrders.orderedAt,
          doctorName: doctors.name,
          doctorUserId: doctors.userId,
          enteredBy: entered.name,
          enteredByUserId: treatmentOrders.enteredByUserId,
          transcribed: treatmentOrders.transcribed,
          countersignedAt: treatmentOrders.countersignedAt,
          stoppedAt: treatmentOrders.stoppedAt,
          stopReason: treatmentOrders.stopReason,
          voidedAt: treatmentOrders.voidedAt,
          riskName: riskClasses.name,
          riskKind: riskClasses.kind,
          riskWitness: riskClasses.witnessAtGive,
          taskKind: treatmentOrders.taskKind,
          timingMode: treatmentOrders.timingMode,
          clockTimes: treatmentOrders.clockTimes,
          intervalMin: treatmentOrders.intervalMin,
          firstDueAt: treatmentOrders.firstDueAt,
          latePolicy: treatmentOrders.latePolicy,
          timeCritical: medicines.timeCritical,
          tcBefore: medicines.tcWindowBeforeMin,
          tcAfter: medicines.tcWindowAfterMin,
          dosesRecorded: sql<number>`(select count(*)::int from mar_administrations m where m.order_id = ${treatmentOrders.id} and m.voided_at is null)`,
          allergyMatches: treatmentOrders.allergyMatches,
          allergyOverrideReason: treatmentOrders.allergyOverrideReason,
        })
        .from(treatmentOrders)
        .innerJoin(doctors, eq(doctors.id, treatmentOrders.orderingDoctorId))
        .leftJoin(entered, eq(entered.id, treatmentOrders.enteredByUserId))
        .leftJoin(medicines, eq(medicines.id, treatmentOrders.medicineId))
        .leftJoin(medicineRiskClasses, eq(medicineRiskClasses.medicineId, treatmentOrders.medicineId))
        .leftJoin(riskClasses, and(eq(riskClasses.id, medicineRiskClasses.riskClassId), isNull(riskClasses.archivedAt)))
        .where(eq(treatmentOrders.admissionId, args.admissionId))
        .orderBy(asc(treatmentOrders.orderedAt));

      const recorder = aliasedTable(users, 'recorder');
      const witness = aliasedTable(users, 'witness');
      const doseRows = await tx
        .select({
          id: marAdministrations.id,
          orderId: marAdministrations.orderId,
          state: marAdministrations.state,
          occurredAt: marAdministrations.occurredAt,
          dueAt: marAdministrations.dueAt,
          timingStatus: marAdministrations.timingStatus,
          delayMin: marAdministrations.delayMin,
          timingReason: marAdministrations.timingReason,
          dose: marAdministrations.dose,
          quantity: marAdministrations.quantity,
          reasonCode: marAdministrations.reasonCode,
          reasonText: marAdministrations.reasonText,
          recordedBy: recorder.name,
          recordedByUserId: marAdministrations.recordedByUserId,
          witnessStatus: marAdministrations.witnessStatus,
          witnessedBy: witness.name,
          flags: marAdministrations.controlFlags,
          voidedAt: marAdministrations.voidedAt,
          voidReason: marAdministrations.voidReason,
          stockStatus: marAdministrations.stockStatus,
        })
        .from(marAdministrations)
        .leftJoin(recorder, eq(recorder.id, marAdministrations.recordedByUserId))
        .leftJoin(witness, eq(witness.id, marAdministrations.witnessedByUserId))
        .where(
          and(
            eq(marAdministrations.admissionId, args.admissionId),
            gte(marAdministrations.occurredAt, window.from),
            lt(marAdministrations.occurredAt, window.to),
          ),
        )
        .orderBy(asc(marAdministrations.occurredAt));

      const waiting = doseRows.filter((d) => d.witnessStatus === 'awaiting' || d.witnessStatus === 'skipped').map((d) => d.id);
      const asked = aliasedTable(users, 'asked');
      const requests = waiting.length
        ? await tx
            .select({
              id: witnessRequests.id,
              marId: witnessRequests.marId,
              method: witnessRequests.method,
              witnessName: asked.name,
              expiresAt: witnessRequests.expiresAt,
            })
            .from(witnessRequests)
            .leftJoin(asked, eq(asked.id, witnessRequests.witnessUserId))
            .where(and(inArray(witnessRequests.marId, waiting), eq(witnessRequests.status, 'pending')))
        : [];
      const requestOf = new Map(requests.map((r) => [r.marId, r]));

      const statusRank: Record<OrderStatus, number> = { awaiting_countersign: 0, active: 0, stopped: 1, struck_out: 2 };
      const orders: CardOrder[] = orderRows
        .map((o) => {
          const status = orderStatus(o);
          const risk: RiskInfo = o.riskKind ? { kind: o.riskKind, witnessAtGive: o.riskWitness ?? false } : null;
          return {
            id: o.id,
            kind: o.kind,
            taskKind: o.taskKind,
            timing: timingFromRow(o),
            timeCritical: Boolean(o.timeCritical),
            tcBefore: o.tcBefore,
            tcAfter: o.tcAfter,
            medicineId: o.medicineId,
            description: o.description,
            dose: o.dose,
            route: o.route,
            frequency: o.frequency,
            instructions: o.instructions,
            orderedAt: o.orderedAt,
            doctorName: o.doctorName,
            doctorUserId: o.doctorUserId,
            enteredBy: o.enteredBy,
            enteredByUserId: o.enteredByUserId,
            transcribed: o.transcribed,
            countersignedAt: o.countersignedAt,
            stoppedAt: o.stoppedAt,
            stopReason: o.stopReason,
            status,
            risk: risk ? { className: o.riskName!, kind: o.riskKind!, needsWitness: needsWitness(risk, o.route) } : null,
            dosesRecorded: o.dosesRecorded,
            allergyMatches: o.allergyMatches ?? [],
            allergyOverrideReason: o.allergyOverrideReason,
          };
        })
        .sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.orderedAt.getTime() - b.orderedAt.getTime());

      const doses: CardDose[] = doseRows.map((d) => {
        const request = requestOf.get(d.id);
        return {
          ...d,
          pendingRequest: request ? { id: request.id, method: request.method, witnessName: request.witnessName, expiresAt: request.expiresAt } : null,
        };
      });
      return { orders, doses };
    },
    clinical,
  );
}

/** Lines waiting for this doctor's countersign, across their patients. */
export async function listAwaitingCountersign(args: { hospitalId: string; userId: string }) {
  return withTenant(
    args.hospitalId,
    (tx) =>
      tx
        .select({ id: treatmentOrders.id, admissionId: treatmentOrders.admissionId, description: treatmentOrders.description, orderedAt: treatmentOrders.orderedAt })
        .from(treatmentOrders)
        .innerJoin(doctors, eq(doctors.id, treatmentOrders.orderingDoctorId))
        .where(
          and(
            eq(doctors.userId, args.userId),
            eq(treatmentOrders.transcribed, true),
            isNull(treatmentOrders.countersignedAt),
            isNull(treatmentOrders.voidedAt),
          ),
        )
        .orderBy(asc(treatmentOrders.orderedAt)),
    clinical,
  );
}

/* =================================================================== sweep */

/**
 * The sweep: an open approval request past its 10 minutes is closed
 * (expired); a give still waiting for its witness 15 minutes after it was
 * recorded gets the `witness_late` flag (D-WITNESS: a missing witness raises
 * a flag; the dose itself stands).
 */
export async function sweepWitnesses(now: Date = new Date()): Promise<{ expired: number; late: number }> {
  const db = getAdminDb();
  const at = now.toISOString();
  const expired = await db.execute<{ id: string }>(sql`
    update witness_requests set status = 'expired', decided_at = ${at}::timestamptz
    where status = 'pending' and expires_at <= ${at}::timestamptz
    returning id
  `);
  const late = await db.execute<{ id: string }>(sql`
    update mar_administrations set control_flags = control_flags || array['witness_late']::text[]
    where witness_status = 'awaiting' and voided_at is null
      and recorded_at <= ${at}::timestamptz - make_interval(secs => ${WITNESS_LATE_MS / 1000})
      and not ('witness_late' = any(control_flags))
    returning id
  `);
  return { expired: expired.length, late: late.length };
}

/* ======================================================= risk rule (bedside) */

/**
 * The bedside record screen (care entries) is not the place for risk-class
 * medicines once the MAR is on: in enforce they are refused there ("give it
 * from the treatment card"); before that they are allowed and the evidence
 * log notes a give with no order behind it.
 */
export async function riskClassMedicineIds(hospitalId: string, medicineIds: readonly string[]): Promise<Set<string>> {
  if (medicineIds.length === 0) return new Set();
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({ id: medicineRiskClasses.medicineId })
      .from(medicineRiskClasses)
      .innerJoin(riskClasses, eq(riskClasses.id, medicineRiskClasses.riskClassId))
      .where(and(inArray(medicineRiskClasses.medicineId, [...medicineIds]), isNull(riskClasses.archivedAt))),
  );
  return new Set(rows.map((r) => r.id));
}

export async function noteUnlinkedRiskGives(args: { hospitalId: string; actorUserId: string; entryIds: readonly string[] }): Promise<void> {
  if (args.entryIds.length === 0) return;
  await withTenant(args.hospitalId, async (tx) => {
    for (const entryId of args.entryIds) {
      await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actorUserId, action: 'mar.unlinked_risk_give', objectType: 'care_entry', objectId: entryId });
    }
  });
}
