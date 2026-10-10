import { and, asc, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { requestOrigin } from '@/lib/db/request-context';
import { admissions, auditLogs, bedAssignments, beds, careEntries, chartEntries, users } from '@/lib/db/schema';
import { IN_BED_STATUSES } from '@/lib/domain/admission';
import { canUndoEntry, occurredAtRefusal } from '@/lib/domain/care-entry';
import {
  TPR_TEMPLATE,
  addDays,
  chartDayWindow,
  ioTotals,
  isLateEntry,
  localHour,
  type TprEntryInput,
} from '@/lib/domain/tpr';

/**
 * The T.P.R. chart (IPD sheets plan, phase B1).
 *
 * Each reading is its own transaction, as bedside entries are
 * (care-entries.ts `recordOne`): a phone flushing ten readings from its
 * outbox saves the nine good ones even if one is refused. A retry carries the
 * same client id and finds the saved row. Readings are clinical
 * (`clinical: true`), and never edited: a wrong one is voided with a reason.
 */

export class TprError extends Error {}

export type TprOutcome =
  | { clientId: string; ok: true; entryId: string; repeat: boolean }
  | { clientId: string; ok: false; error: string };

/** The ward a patient is in now, for a rollout that is switched on ward by ward. */
async function currentWardInTx(tx: Tx, admissionId: string): Promise<string | null> {
  const [row] = await tx
    .select({ wardId: beds.wardId })
    .from(bedAssignments)
    .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
    .where(and(eq(bedAssignments.admissionId, admissionId), isNull(bedAssignments.toAt)));
  return row?.wardId ?? null;
}

async function recordOne(args: {
  hospitalId: string;
  entry: TprEntryInput;
  actorUserId: string;
  now: Date;
  wardAllowed: (wardId: string | null) => boolean;
}): Promise<TprOutcome> {
  const { entry } = args;
  const observedAt = new Date(entry.observedAt);
  const refusal = occurredAtRefusal(observedAt, args.now);
  if (refusal) {
    return {
      clientId: entry.clientId,
      ok: false,
      error: refusal === 'future' ? 'The time given is in the future' : 'That was too long ago to record here. Tell the in-charge.',
    };
  }
  try {
    return await withTenant(
      args.hospitalId,
      async (tx) => {
        const [existing] = await tx
          .select({ id: chartEntries.id, admissionId: chartEntries.admissionId })
          .from(chartEntries)
          .where(and(eq(chartEntries.clientId, entry.clientId), eq(chartEntries.observedAt, observedAt)));
        if (existing) {
          if (existing.admissionId !== entry.admissionId) throw new TprError('Reading belongs to another patient');
          return { clientId: entry.clientId, ok: true as const, entryId: existing.id, repeat: true };
        }

        // FOR SHARE: a discharge finalising this stay waits for the reading, and is waited for.
        const [admission] = await tx
          .select({
            id: admissions.id,
            status: admissions.status,
            branchId: admissions.branchId,
            encounterId: admissions.encounterId,
            patientId: admissions.patientId,
          })
          .from(admissions)
          .where(eq(admissions.id, entry.admissionId))
          .for('share');
        if (!admission) throw new TprError('Patient not found');
        if (!(IN_BED_STATUSES as readonly string[]).includes(admission.status)) {
          throw new TprError(admission.status === 'discharged' ? 'This patient has been discharged' : 'This patient does not have a bed yet');
        }
        if (!args.wardAllowed(await currentWardInTx(tx, admission.id))) {
          throw new TprError('The T.P.R. chart is not switched on for this ward yet');
        }

        const origin = await requestOrigin();
        const [saved] = await tx
          .insert(chartEntries)
          .values({
            hospitalId: args.hospitalId,
            branchId: admission.branchId,
            admissionId: admission.id,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            templateKey: TPR_TEMPLATE.key,
            templateVersion: TPR_TEMPLATE.version,
            observedAt,
            pulse: entry.pulse ?? null,
            bpSystolic: entry.bpSystolic ?? null,
            bpDiastolic: entry.bpDiastolic ?? null,
            spo2: entry.spo2 ?? null,
            tempFTenths: entry.tempFTenths ?? null,
            bslMgDl: entry.bslMgDl ?? null,
            respRate: entry.respRate ?? null,
            abdGirthCm: entry.abdGirthCm ?? null,
            onOxygen: entry.onOxygen ?? null,
            consciousness: entry.consciousness ?? null,
            drainMl: entry.drainMl ?? null,
            urineMl: entry.urineMl ?? null,
            rtAspirateMl: entry.rtAspirateMl ?? null,
            oralMl: entry.oralMl ?? null,
            ivMl: entry.ivMl ?? null,
            note: entry.note || null,
            recordedAt: args.now,
            recordedByUserId: args.actorUserId,
            recordedChannel: origin?.channel ?? null,
            recordedDeviceId: origin?.deviceId ?? null,
            recordedSessionId: origin?.sessionId ?? null,
            clientId: entry.clientId,
          })
          .returning({ id: chartEntries.id });
        return { clientId: entry.clientId, ok: true as const, entryId: saved.id, repeat: false };
      },
      { clinical: true },
    );
  } catch (err) {
    // A concurrent retry won the race on the client id: the reading is saved.
    if (isClientKeyRace(err)) {
      const [saved] = await withTenant(
        args.hospitalId,
        (tx) =>
          tx
            .select({ id: chartEntries.id })
            .from(chartEntries)
            .where(and(eq(chartEntries.clientId, entry.clientId), eq(chartEntries.observedAt, observedAt))),
        { clinical: true },
      );
      if (saved) return { clientId: entry.clientId, ok: true, entryId: saved.id, repeat: true };
    }
    if (err instanceof TprError) return { clientId: entry.clientId, ok: false, error: err.message };
    throw err;
  }
}

const isClientKeyRace = (err: unknown): boolean => {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    // On a partition the unique index carries the partition's own name.
    if (e.code === '23505' && e.constraint_name?.startsWith('chart_entries')) return true;
  }
  return false;
};

export async function recordTprEntries(args: {
  hospitalId: string;
  entries: readonly TprEntryInput[];
  actorUserId: string;
  /** Is this ward in the module's rollout? Defaults to every ward. */
  wardAllowed?: (wardId: string | null) => boolean;
  now?: Date;
}): Promise<TprOutcome[]> {
  const now = args.now ?? new Date();
  const wardAllowed = args.wardAllowed ?? (() => true);
  const outcomes: TprOutcome[] = [];
  for (const entry of args.entries) {
    outcomes.push(await recordOne({ hospitalId: args.hospitalId, entry, actorUserId: args.actorUserId, now, wardAllowed }));
  }
  return outcomes;
}

async function voidInTx(tx: Tx, args: { hospitalId: string; entryId: string; actorUserId: string; reason: string; undo: boolean }) {
  await tx
    .update(chartEntries)
    .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: args.reason })
    .where(and(eq(chartEntries.id, args.entryId), isNull(chartEntries.voidedAt)));
  await tx.insert(auditLogs).values({
    hospitalId: args.hospitalId,
    actorUserId: args.actorUserId,
    action: args.undo ? 'ipd.chart_entry_undone' : 'ipd.chart_entry_voided',
    objectType: 'chart_entry',
    objectId: args.entryId,
    metadata: args.undo ? undefined : { reason: args.reason },
  });
}

async function lockEntryInTx(tx: Tx, entryId: string) {
  const [row] = await tx
    .select({
      id: chartEntries.id,
      recordedByUserId: chartEntries.recordedByUserId,
      recordedAt: chartEntries.recordedAt,
      voidedAt: chartEntries.voidedAt,
      status: admissions.status,
    })
    .from(chartEntries)
    .innerJoin(admissions, eq(admissions.id, chartEntries.admissionId))
    .where(eq(chartEntries.id, entryId))
    .for('update', { of: chartEntries });
  if (!row) throw new TprError('Reading not found');
  if (row.voidedAt) throw new TprError('This reading has already been removed');
  if (row.status === 'discharged') throw new TprError('The patient has been discharged; the chart is closed');
  return row;
}

/** The person who recorded it takes it back, within two minutes. */
export async function undoTprEntry(args: { hospitalId: string; entryId: string; actorUserId: string; now?: Date }): Promise<void> {
  const now = args.now ?? new Date();
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const row = await lockEntryInTx(tx, args.entryId);
      if (!canUndoEntry({ recordedByUserId: row.recordedByUserId, actorUserId: args.actorUserId, recordedAt: row.recordedAt, voided: false, now })) {
        throw new TprError('Undo is only for your own reading, within two minutes. Use Correct instead.');
      }
      await voidInTx(tx, { ...args, reason: 'Undone by the person who recorded it', undo: true });
    },
    { clinical: true },
  );
}

/** Anyone who may chart corrects a wrong reading, with a reason. Never an edit. */
export async function voidTprEntry(args: { hospitalId: string; entryId: string; actorUserId: string; reason: string }): Promise<void> {
  const reason = args.reason.trim().replace(/\s+/g, ' ');
  if (reason.length < 3) throw new TprError('Say why the reading is wrong');
  if (reason.length > 200) throw new TprError('Keep the reason under 200 characters');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      await lockEntryInTx(tx, args.entryId);
      await voidInTx(tx, { ...args, reason, undo: false });
    },
    { clinical: true },
  );
}

export type TprReading = {
  id: string;
  observedAt: Date;
  recordedAt: Date;
  hour: number;
  recordedByUserId: string | null;
  recordedByName: string | null;
  channel: 'personal' | 'ward_device' | null;
  late: boolean;
  pulse: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  spo2: number | null;
  tempFTenths: number | null;
  bslMgDl: number | null;
  respRate: number | null;
  abdGirthCm: number | null;
  onOxygen: boolean | null;
  consciousness: 'A' | 'C' | 'V' | 'P' | 'U' | null;
  drainMl: number | null;
  urineMl: number | null;
  rtAspirateMl: number | null;
  oralMl: number | null;
  ivMl: number | null;
  note: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
};

export type TprTreatment = { id: string; occurredAt: Date; hour: number; description: string; quantity: number };

export type TprDay = {
  day: string;
  from: Date;
  to: Date;
  readings: TprReading[];
  voided: TprReading[];
  /** What was given in the day's window: the paper's Treatment column. */
  treatment: TprTreatment[];
  totals: ReturnType<typeof ioTotals>;
};

/**
 * Chart days (8 am–8 am) of one patient, `fromDay` to `toDay` inclusive: the
 * readings in time order, what was given (from the bedside entries), and
 * intake/output by shift and for each day. Two indexed range reads whatever
 * the number of days, so printing a 10-day stay costs the same as one day.
 */
export async function getTprDays(args: {
  hospitalId: string;
  admissionId: string;
  fromDay: string;
  toDay: string;
  timezone: string;
}): Promise<TprDay[]> {
  const days: string[] = [];
  for (let day = args.fromDay; day <= args.toDay && days.length < 400; day = addDays(day, 1)) days.push(day);
  if (days.length === 0) return [];
  const from = chartDayWindow(days[0], args.timezone).from;
  const to = chartDayWindow(days.at(-1)!, args.timezone).to;

  const [rows, given] = await withTenant(
    args.hospitalId,
    (tx) =>
      Promise.all([
        tx
          .select({ entry: chartEntries, recordedByName: users.name })
          .from(chartEntries)
          .leftJoin(users, eq(users.id, chartEntries.recordedByUserId))
          .where(
            and(eq(chartEntries.admissionId, args.admissionId), gte(chartEntries.observedAt, from), lt(chartEntries.observedAt, to)),
          )
          .orderBy(asc(chartEntries.observedAt), asc(chartEntries.recordedAt)),
        tx
          .select({
            id: careEntries.id,
            occurredAt: careEntries.occurredAt,
            description: careEntries.description,
            quantity: careEntries.quantity,
          })
          .from(careEntries)
          .where(
            and(
              eq(careEntries.admissionId, args.admissionId),
              gte(careEntries.occurredAt, from),
              lt(careEntries.occurredAt, to),
              isNull(careEntries.voidedAt),
            ),
          )
          .orderBy(asc(careEntries.occurredAt)),
      ]),
    { clinical: true },
  );

  const readings: TprReading[] = rows.map(({ entry, recordedByName }) => ({
    id: entry.id,
    observedAt: entry.observedAt,
    recordedAt: entry.recordedAt,
    hour: localHour(entry.observedAt, args.timezone),
    recordedByUserId: entry.recordedByUserId,
    recordedByName,
    channel: entry.recordedChannel,
    late: isLateEntry(entry.observedAt, entry.recordedAt),
    pulse: entry.pulse,
    bpSystolic: entry.bpSystolic,
    bpDiastolic: entry.bpDiastolic,
    spo2: entry.spo2,
    tempFTenths: entry.tempFTenths,
    bslMgDl: entry.bslMgDl,
    respRate: entry.respRate,
    abdGirthCm: entry.abdGirthCm,
    onOxygen: entry.onOxygen,
    consciousness: entry.consciousness,
    drainMl: entry.drainMl,
    urineMl: entry.urineMl,
    rtAspirateMl: entry.rtAspirateMl,
    oralMl: entry.oralMl,
    ivMl: entry.ivMl,
    note: entry.note,
    voidedAt: entry.voidedAt,
    voidReason: entry.voidReason,
  }));

  return days.map((day) => {
    const window = chartDayWindow(day, args.timezone);
    const inDay = (at: Date) => at >= window.from && at < window.to;
    const ofDay = readings.filter((r) => inDay(r.observedAt));
    const live = ofDay.filter((r) => !r.voidedAt);
    return {
      day,
      from: window.from,
      to: window.to,
      readings: live,
      voided: ofDay.filter((r) => r.voidedAt),
      treatment: given
        .filter((g) => inDay(g.occurredAt))
        .map((g) => ({ ...g, hour: localHour(g.occurredAt, args.timezone) })),
      totals: ioTotals(live),
    };
  });
}

/** One chart day: the TPR tab and its API. Not polled. */
export async function getTprDay(args: { hospitalId: string; admissionId: string; day: string; timezone: string }): Promise<TprDay> {
  const [day] = await getTprDays({ ...args, fromDay: args.day, toDay: args.day });
  return day;
}

/** The most recent reading with each vital, for the doctor's O/E later (plan C3) and the header. */
export async function getLatestVitals(hospitalId: string, admissionId: string) {
  const [row] = await withTenant(
    hospitalId,
    (tx) =>
      tx
        .select()
        .from(chartEntries)
        .where(and(eq(chartEntries.admissionId, admissionId), isNull(chartEntries.voidedAt)))
        .orderBy(desc(chartEntries.observedAt))
        .limit(1),
    { clinical: true },
  );
  return row ?? null;
}

/** Undo windows for the readings this person just made, for the phone list. */
export function undoableUntil(reading: Pick<TprReading, 'recordedByUserId' | 'recordedAt' | 'voidedAt'>, actorUserId: string, now: Date): Date | null {
  return canUndoEntry({ recordedByUserId: reading.recordedByUserId, actorUserId, recordedAt: reading.recordedAt, voided: Boolean(reading.voidedAt), now })
    ? new Date(reading.recordedAt.getTime() + 2 * 60_000)
    : null;
}
