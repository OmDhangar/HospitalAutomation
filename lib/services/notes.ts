import { createHash } from 'node:crypto';
import { aliasedTable, and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { requestOrigin } from '@/lib/db/request-context';
import { admissions, auditLogs, chartEntries, doctors, ipdNotes, users } from '@/lib/db/schema';
import {
  NoteError,
  RECENT_READING_MS,
  chartAction,
  vitalsOf,
  type Complaint,
  type GeneralExam,
  type NoteInput,
  type NoteKind,
  type NoteVitals,
  type SystemicExam,
} from '@/lib/domain/notes';
import { TPR_TEMPLATE } from '@/lib/domain/tpr';

/**
 * The doctor's case sheet and progress notes (IPD sheets plan C3). One
 * clinical transaction per call. A note written from the named doctor's own
 * login is signed; anyone else's is transcribed and waits for that doctor's
 * countersign. The O/E vitals confirm a recent chart reading or put a new
 * one on the chart, in the same transaction. The database keeps notes
 * struck-out-only and one live case sheet per stay.
 */

export { NoteError };

const clinical = { clinical: true } as const;
const OPEN_STATUSES = ['awaiting_bed', 'admitted', 'discharge_ready'] as const;

function derivedId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The latest chart reading with any vital within 2 hours before `at` (the O/E's starting point). */
async function recentReadingInTx(tx: Tx, admissionId: string, at: Date) {
  const [row] = await tx
    .select({
      id: chartEntries.id,
      observedAt: chartEntries.observedAt,
      pulse: chartEntries.pulse,
      bpSystolic: chartEntries.bpSystolic,
      bpDiastolic: chartEntries.bpDiastolic,
      tempFTenths: chartEntries.tempFTenths,
      spo2: chartEntries.spo2,
      respRate: chartEntries.respRate,
    })
    .from(chartEntries)
    .where(
      and(
        eq(chartEntries.admissionId, admissionId),
        isNull(chartEntries.voidedAt),
        gte(chartEntries.observedAt, new Date(at.getTime() - RECENT_READING_MS)),
        lte(chartEntries.observedAt, new Date(at.getTime() + 5 * 60_000)),
        sql`coalesce(${chartEntries.pulse}, ${chartEntries.bpSystolic}, ${chartEntries.tempFTenths}, ${chartEntries.spo2}, ${chartEntries.respRate}) is not null`,
      ),
    )
    .orderBy(desc(chartEntries.observedAt))
    .limit(1);
  return row ? { id: row.id, observedAt: row.observedAt, vitals: vitalsOf(row) } : null;
}

export type NoteContext = {
  /** The vitals to start the O/E from, and when they were charted. */
  recent: { observedAt: Date; vitals: NoteVitals } | null;
  hasAdmissionNote: boolean;
};

export async function getNoteContext(hospitalId: string, admissionId: string, now: Date = new Date()): Promise<NoteContext> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const recent = await recentReadingInTx(tx, admissionId, now);
      const [admissionNote] = await tx
        .select({ id: ipdNotes.id })
        .from(ipdNotes)
        .where(and(eq(ipdNotes.admissionId, admissionId), eq(ipdNotes.kind, 'admission'), isNull(ipdNotes.voidedAt)));
      return { recent: recent ? { observedAt: recent.observedAt, vitals: recent.vitals } : null, hasAdmissionNote: Boolean(admissionNote) };
    },
    clinical,
  );
}

/**
 * Writes a note. The vitals on it confirm the recent chart reading (kept as
 * charted) or, when changed or when there is none, go on the chart as one
 * reading from this note — unless the chart is not in use (`chart: false`),
 * when they stay on the note only.
 */
export async function writeNote(args: {
  hospitalId: string;
  admissionId: string;
  input: NoteInput;
  seenByDoctorId: string;
  actorUserId: string;
  /** Nurses and RMOs may write it for the doctor (transcribed). */
  mayTranscribe: boolean;
  /** Whether the T.P.R. chart is in use for this patient. */
  chart: boolean;
  clientId: string;
  now?: Date;
}): Promise<{ noteId: string; transcribed: boolean; chart: 'none' | 'confirmed' | 'written' | 'off'; repeat: boolean }> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [existing] = await tx
        .select({ id: ipdNotes.id, transcribed: ipdNotes.transcribed, admissionId: ipdNotes.admissionId })
        .from(ipdNotes)
        .where(eq(ipdNotes.clientId, args.clientId));
      if (existing) {
        if (existing.admissionId !== args.admissionId) throw new NoteError('That note belongs to another patient');
        return { noteId: existing.id, transcribed: existing.transcribed, chart: 'none' as const, repeat: true };
      }
      const [admission] = await tx
        .select({ id: admissions.id, status: admissions.status, branchId: admissions.branchId, encounterId: admissions.encounterId, patientId: admissions.patientId })
        .from(admissions)
        .where(eq(admissions.id, args.admissionId))
        .for('share');
      if (!admission) throw new NoteError('Patient not found');
      if (!(OPEN_STATUSES as readonly string[]).includes(admission.status)) throw new NoteError('This stay is closed');
      const [doctor] = await tx.select({ id: doctors.id, userId: doctors.userId, active: doctors.active }).from(doctors).where(eq(doctors.id, args.seenByDoctorId));
      if (!doctor?.active) throw new NoteError('Choose the doctor who saw the patient');
      const transcribed = doctor.userId !== args.actorUserId;
      if (transcribed && !args.mayTranscribe) throw new NoteError('Only the doctor named can write this note');
      if (args.input.kind === 'admission') {
        const [already] = await tx
          .select({ id: ipdNotes.id })
          .from(ipdNotes)
          .where(and(eq(ipdNotes.admissionId, admission.id), eq(ipdNotes.kind, 'admission'), isNull(ipdNotes.voidedAt)));
        if (already) throw new NoteError('The case sheet is already written. Strike it out to write it again, or add a progress note.');
      }

      const origin = await requestOrigin();
      let chart: 'none' | 'confirmed' | 'written' | 'off' = 'none';
      let link: { id: string; observedAt: Date } | null = null;
      const recent = await recentReadingInTx(tx, admission.id, args.input.seenAt);
      const action = chartAction(args.input.vitals, recent);
      if (action.kind === 'confirm' && recent) {
        link = { id: recent.id, observedAt: recent.observedAt };
        chart = 'confirmed';
      } else if (action.kind === 'write') {
        if (!args.chart) chart = 'off';
        else {
          const v = args.input.vitals;
          const [row] = await tx
            .insert(chartEntries)
            .values({
              hospitalId: args.hospitalId,
              branchId: admission.branchId,
              admissionId: admission.id,
              encounterId: admission.encounterId,
              patientId: admission.patientId,
              templateKey: TPR_TEMPLATE.key,
              templateVersion: TPR_TEMPLATE.version,
              observedAt: args.input.seenAt,
              pulse: v.pulse ?? null,
              bpSystolic: v.bpSystolic ?? null,
              bpDiastolic: v.bpDiastolic ?? null,
              tempFTenths: v.tempFTenths ?? null,
              spo2: v.spo2 ?? null,
              respRate: v.respRate ?? null,
              note: 'From the doctor’s note',
              source: 'doctor_note',
              recordedAt: now,
              recordedByUserId: args.actorUserId,
              recordedChannel: origin?.channel ?? null,
              recordedDeviceId: origin?.deviceId ?? null,
              recordedSessionId: origin?.sessionId ?? null,
              clientId: derivedId(`note-chart:${args.clientId}`),
            })
            .returning({ id: chartEntries.id, observedAt: chartEntries.observedAt });
          link = row;
          chart = 'written';
        }
      }

      const [row] = await tx
        .insert(ipdNotes)
        .values({
          hospitalId: args.hospitalId,
          branchId: admission.branchId,
          admissionId: admission.id,
          encounterId: admission.encounterId,
          patientId: admission.patientId,
          kind: args.input.kind,
          seenAt: args.input.seenAt,
          caseOf: args.input.caseOf,
          complaints: args.input.complaints,
          history: args.input.history,
          pastHistory: args.input.pastHistory,
          generalExam: args.input.generalExam,
          vitals: args.input.vitals,
          systemicExam: args.input.systemicExam,
          progress: args.input.progress,
          advice: args.input.advice,
          seenByDoctorId: doctor.id,
          chartEntryId: link?.id ?? null,
          chartObservedAt: link?.observedAt ?? null,
          writtenByUserId: args.actorUserId,
          transcribed,
          recordedAt: now,
          recordedChannel: origin?.channel ?? null,
          recordedDeviceId: origin?.deviceId ?? null,
          recordedSessionId: origin?.sessionId ?? null,
          clientId: args.clientId,
        })
        .returning({ id: ipdNotes.id });
      return { noteId: row.id, transcribed, chart, repeat: false };
    },
    clinical,
  );
}

export type NoteView = {
  id: string;
  kind: NoteKind;
  seenAt: Date;
  caseOf: string | null;
  complaints: Complaint[];
  history: string | null;
  pastHistory: string | null;
  generalExam: GeneralExam;
  vitals: NoteVitals;
  systemicExam: SystemicExam;
  progress: string | null;
  advice: string | null;
  doctorName: string;
  doctorUserId: string | null;
  writtenBy: string | null;
  writtenByUserId: string | null;
  transcribed: boolean;
  countersignedAt: Date | null;
  countersignedBy: string | null;
  chartLinked: boolean;
  voidedAt: Date | null;
  voidReason: string | null;
};

/** The notes of a stay, the case sheet first, then progress notes newest first. */
export async function listNotes(hospitalId: string, admissionId: string): Promise<NoteView[]> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const writer = aliasedTable(users, 'writer');
      const signer = aliasedTable(users, 'signer');
      const rows = await tx
        .select({
          id: ipdNotes.id,
          kind: ipdNotes.kind,
          seenAt: ipdNotes.seenAt,
          caseOf: ipdNotes.caseOf,
          complaints: ipdNotes.complaints,
          history: ipdNotes.history,
          pastHistory: ipdNotes.pastHistory,
          generalExam: ipdNotes.generalExam,
          vitals: ipdNotes.vitals,
          systemicExam: ipdNotes.systemicExam,
          progress: ipdNotes.progress,
          advice: ipdNotes.advice,
          doctorName: doctors.name,
          doctorUserId: doctors.userId,
          writtenBy: writer.name,
          writtenByUserId: ipdNotes.writtenByUserId,
          transcribed: ipdNotes.transcribed,
          countersignedAt: ipdNotes.countersignedAt,
          countersignedBy: signer.name,
          chartEntryId: ipdNotes.chartEntryId,
          voidedAt: ipdNotes.voidedAt,
          voidReason: ipdNotes.voidReason,
        })
        .from(ipdNotes)
        .innerJoin(doctors, eq(doctors.id, ipdNotes.seenByDoctorId))
        .leftJoin(writer, eq(writer.id, ipdNotes.writtenByUserId))
        .leftJoin(signer, eq(signer.id, ipdNotes.countersignedByUserId))
        .where(eq(ipdNotes.admissionId, admissionId))
        .orderBy(asc(ipdNotes.seenAt));
      return rows
        .map(({ chartEntryId, ...r }) => ({ ...r, chartLinked: Boolean(chartEntryId) }))
        .sort((a, b) => (a.kind === b.kind ? b.seenAt.getTime() - a.seenAt.getTime() : a.kind === 'admission' ? -1 : 1));
    },
    clinical,
  );
}

/** Only the doctor named on a transcribed note countersigns it, from their own login. */
export async function countersignNote(args: { hospitalId: string; noteId: string; actorUserId: string; now?: Date }): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [note] = await tx
        .select({ id: ipdNotes.id, transcribed: ipdNotes.transcribed, countersignedAt: ipdNotes.countersignedAt, voidedAt: ipdNotes.voidedAt, doctorUserId: doctors.userId })
        .from(ipdNotes)
        .innerJoin(doctors, eq(doctors.id, ipdNotes.seenByDoctorId))
        .where(eq(ipdNotes.id, args.noteId))
        .for('update', { of: ipdNotes });
      if (!note || note.voidedAt) throw new NoteError('Note not found');
      if (!note.transcribed) throw new NoteError('This note was written by the doctor; it needs no countersign');
      if (note.countersignedAt) return;
      if (note.doctorUserId !== args.actorUserId) throw new NoteError('Only the doctor named on the note can countersign it');
      await tx.update(ipdNotes).set({ countersignedAt: args.now ?? new Date(), countersignedByUserId: args.actorUserId }).where(eq(ipdNotes.id, note.id));
    },
    clinical,
  );
}

/**
 * Strikes out a note written in error, by whoever wrote it or the owner. A
 * chart reading this note put on the chart goes with it; one it only
 * confirmed stays.
 */
export async function strikeOutNote(args: { hospitalId: string; noteId: string; reason: string; actorUserId: string; isOwner: boolean }): Promise<void> {
  const reason = args.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason.length < 3) throw new NoteError('Write why the note is struck out');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [note] = await tx.select().from(ipdNotes).where(eq(ipdNotes.id, args.noteId)).for('update');
      if (!note) throw new NoteError('Note not found');
      if (note.voidedAt) return;
      if (!args.isOwner && note.writtenByUserId !== args.actorUserId) throw new NoteError('Only whoever wrote the note can strike it out');
      const now = new Date();
      await tx.update(ipdNotes).set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: reason }).where(eq(ipdNotes.id, note.id));
      if (note.chartEntryId && note.chartObservedAt) {
        const voided = await tx
          .update(chartEntries)
          .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: `Doctor’s note struck out: ${reason}` })
          .where(
            and(
              eq(chartEntries.id, note.chartEntryId),
              eq(chartEntries.observedAt, note.chartObservedAt),
              eq(chartEntries.source, 'doctor_note'),
              eq(chartEntries.clientId, derivedId(`note-chart:${note.clientId}`)),
              isNull(chartEntries.voidedAt),
            ),
          )
          .returning({ id: chartEntries.id });
        if (voided.length > 0) {
          await tx.insert(auditLogs).values({
            hospitalId: args.hospitalId,
            actorUserId: args.actorUserId,
            action: 'ipd.chart_entry_voided',
            objectType: 'chart_entry',
            objectId: voided[0].id,
            metadata: { reason: 'doctor note struck out' },
          });
        }
      }
    },
    clinical,
  );
}

/** Transcribed notes waiting for this doctor's countersign, across their patients. */
export async function listNotesAwaitingCountersign(args: { hospitalId: string; userId: string }) {
  return withTenant(
    args.hospitalId,
    (tx) =>
      tx
        .select({ id: ipdNotes.id, admissionId: ipdNotes.admissionId, kind: ipdNotes.kind, seenAt: ipdNotes.seenAt })
        .from(ipdNotes)
        .innerJoin(doctors, eq(doctors.id, ipdNotes.seenByDoctorId))
        .where(and(eq(doctors.userId, args.userId), eq(ipdNotes.transcribed, true), isNull(ipdNotes.countersignedAt), isNull(ipdNotes.voidedAt))),
    clinical,
  );
}
