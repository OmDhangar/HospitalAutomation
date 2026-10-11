import { aliasedTable, and, asc, desc, eq, isNull } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { requestOrigin } from '@/lib/db/request-context';
import { admissions, dischargeSummaries, dischargeSummaryDrafts, doctors, ipdNotes, testOrders, treatmentOrders, users } from '@/lib/db/schema';
import {
  SummaryError,
  buildDraft,
  refreshFromRecord,
  type SummaryContent,
  type SummarySources,
} from '@/lib/domain/discharge-summary';
import { generalExamText, vitalsText, SYSTEMS, type SystemKey } from '@/lib/domain/notes';
import { ROUTES, isRoute } from '@/lib/domain/mar';
import { getMedRec } from '@/lib/services/medrec';

/**
 * The discharge summary (IPD sheets plan B5). The draft is a working copy,
 * started from the record and edited freely; finalising writes a numbered
 * version that is never edited — signed when the responsible doctor
 * finalises from their own login, otherwise waiting for that doctor's
 * countersign. A correction is a new version that supersedes the last.
 * Clinical: every call uses the clinical key.
 */

export { SummaryError };

const clinical = { clinical: true } as const;

async function admissionInTx(tx: Tx, admissionId: string) {
  const [row] = await tx
    .select({
      id: admissions.id,
      status: admissions.status,
      reason: admissions.reason,
      encounterId: admissions.encounterId,
      patientId: admissions.patientId,
      doctorId: admissions.admittingDoctorId,
    })
    .from(admissions)
    .where(eq(admissions.id, admissionId));
  if (!row) throw new SummaryError('Patient not found');
  if (row.status === 'cancelled' || row.status === 'awaiting_bed') throw new SummaryError('There is no stay to summarise yet');
  return row;
}

/** Everything the draft is built from, read from the record. */
async function sourcesInTx(tx: Tx, admissionId: string, reason: string | null): Promise<SummarySources> {
  const notes = await tx
    .select()
    .from(ipdNotes)
    .where(and(eq(ipdNotes.admissionId, admissionId), isNull(ipdNotes.voidedAt)))
    .orderBy(asc(ipdNotes.seenAt));
  const caseNote = notes.find((n) => n.kind === 'admission') ?? null;
  const tests = await tx
    .select({ name: testOrders.testName, status: testOrders.status, at: testOrders.orderedAt })
    .from(testOrders)
    .where(eq(testOrders.admissionId, admissionId))
    .orderBy(asc(testOrders.orderedAt));
  const lines = await tx
    .select({
      description: treatmentOrders.description,
      dose: treatmentOrders.dose,
      route: treatmentOrders.route,
      frequency: treatmentOrders.frequency,
      startedAt: treatmentOrders.orderedAt,
      stoppedAt: treatmentOrders.stoppedAt,
    })
    .from(treatmentOrders)
    .where(and(eq(treatmentOrders.admissionId, admissionId), eq(treatmentOrders.kind, 'medicine'), isNull(treatmentOrders.voidedAt)))
    .orderBy(asc(treatmentOrders.orderedAt));
  const examination = caseNote
    ? [
        generalExamText(caseNote.generalExam),
        vitalsText(caseNote.vitals),
        ...(Object.keys(SYSTEMS) as SystemKey[]).filter((k) => caseNote.systemicExam[k]).map((k) => `${SYSTEMS[k]}: ${caseNote.systemicExam[k]}`),
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  // Routes as the paper writes them ("IV", not the stored code).
  const treatment = lines.map((l) => ({ ...l, route: l.route && isRoute(l.route) ? ROUTES[l.route] : l.route }));
  return {
    reason,
    caseNote: caseNote
      ? { caseOf: caseNote.caseOf, complaints: caseNote.complaints, history: caseNote.history, pastHistory: caseNote.pastHistory, examination }
      : null,
    tests,
    treatment,
    progress: notes.filter((n) => n.kind === 'progress' && n.progress).map((n) => ({ at: n.seenAt, text: n.progress! })),
    goingHome: null,
    activeCardMedicines: lines.filter((l) => !l.stoppedAt).map((l) => ({ description: l.description, dose: l.dose, frequency: l.frequency })),
  };
}

/** Adds the discharge reconciliation's list when a doctor has completed it. */
async function withGoingHome(hospitalId: string, admissionId: string, sources: SummarySources): Promise<SummarySources> {
  const medrec = await getMedRec(hospitalId, admissionId);
  if (!medrec.discharge.signoff) return sources;
  return {
    ...sources,
    goingHome: medrec.discharge.goingHome.map((m) => ({ name: m.name, dose: m.dose, frequency: m.frequency, duration: m.duration, note: m.decision === 'change' ? m.decisionNote : null })),
  };
}

export type SummaryVersion = {
  id: string;
  version: number;
  content: SummaryContent;
  doctorId: string;
  doctorName: string;
  doctorUserId: string | null;
  finalisedAt: Date;
  finalisedBy: string | null;
  transcribed: boolean;
  signedAt: Date | null;
  signedBy: string | null;
  changeReason: string | null;
};

export type SummaryView = {
  /** The working copy: saved, or freshly built from the record. */
  draft: SummaryContent;
  draftSaved: { at: Date; by: string | null } | null;
  versions: SummaryVersion[];
  /** The latest version (signed or waiting). */
  current: SummaryVersion | null;
  doctorId: string;
};

export async function getSummaryView(args: { hospitalId: string; admissionId: string; timezone: string }): Promise<SummaryView> {
  const base = await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await admissionInTx(tx, args.admissionId);
      const editor = aliasedTable(users, 'editor');
      const [draft] = await tx
        .select({ content: dischargeSummaryDrafts.content, at: dischargeSummaryDrafts.updatedAt, by: editor.name })
        .from(dischargeSummaryDrafts)
        .leftJoin(editor, eq(editor.id, dischargeSummaryDrafts.updatedByUserId))
        .where(eq(dischargeSummaryDrafts.admissionId, admission.id));
      const finaliser = aliasedTable(users, 'finaliser');
      const signer = aliasedTable(users, 'signer');
      const versions = await tx
        .select({
          id: dischargeSummaries.id,
          version: dischargeSummaries.version,
          content: dischargeSummaries.content,
          doctorId: dischargeSummaries.doctorId,
          doctorName: doctors.name,
          doctorUserId: doctors.userId,
          finalisedAt: dischargeSummaries.finalisedAt,
          finalisedBy: finaliser.name,
          transcribed: dischargeSummaries.transcribed,
          signedAt: dischargeSummaries.signedAt,
          signedBy: signer.name,
          changeReason: dischargeSummaries.changeReason,
        })
        .from(dischargeSummaries)
        .innerJoin(doctors, eq(doctors.id, dischargeSummaries.doctorId))
        .leftJoin(finaliser, eq(finaliser.id, dischargeSummaries.finalisedByUserId))
        .leftJoin(signer, eq(signer.id, dischargeSummaries.signedByUserId))
        .where(eq(dischargeSummaries.admissionId, admission.id))
        .orderBy(desc(dischargeSummaries.version));
      const sources = draft || versions.length > 0 ? null : await sourcesInTx(tx, admission.id, admission.reason);
      return { admission, draft, versions, sources };
    },
    clinical,
  );
  let draftContent: SummaryContent;
  if (base.draft) draftContent = base.draft.content;
  else if (base.versions[0]) draftContent = base.versions[0].content;
  else draftContent = buildDraft(await withGoingHome(args.hospitalId, args.admissionId, base.sources!), args.timezone);
  return {
    draft: draftContent,
    draftSaved: base.draft ? { at: base.draft.at, by: base.draft.by } : null,
    versions: base.versions,
    current: base.versions[0] ?? null,
    doctorId: base.versions[0]?.doctorId ?? base.admission.doctorId,
  };
}

/** Saves the working copy (outside the record). */
export async function saveDraft(args: { hospitalId: string; admissionId: string; content: SummaryContent; actorUserId: string }): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await admissionInTx(tx, args.admissionId);
      await tx
        .insert(dischargeSummaryDrafts)
        .values({ hospitalId: args.hospitalId, admissionId: admission.id, content: args.content, updatedByUserId: args.actorUserId })
        .onConflictDoUpdate({
          target: [dischargeSummaryDrafts.hospitalId, dischargeSummaryDrafts.admissionId],
          set: { content: args.content, updatedAt: new Date(), updatedByUserId: args.actorUserId },
        });
    },
    clinical,
  );
}

/** Rebuilds the sections that come from the record (tests, treatment, medicines…), keeping what was written in the rest. */
export async function refreshDraft(args: { hospitalId: string; admissionId: string; current: SummaryContent; timezone: string; actorUserId: string }): Promise<SummaryContent> {
  const sources = await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await admissionInTx(tx, args.admissionId);
      return sourcesInTx(tx, admission.id, admission.reason);
    },
    clinical,
  );
  const fresh = buildDraft(await withGoingHome(args.hospitalId, args.admissionId, sources), args.timezone);
  const content = refreshFromRecord(args.current, fresh);
  await saveDraft({ hospitalId: args.hospitalId, admissionId: args.admissionId, content, actorUserId: args.actorUserId });
  return content;
}

/**
 * Finalises the summary as the next version. From the responsible doctor's
 * own login it is signed; from anyone else's it waits for that doctor's
 * countersign. Version 2 onwards says why it was changed. The draft is
 * cleared: the next edit starts from this version.
 */
export async function finaliseSummary(args: {
  hospitalId: string;
  admissionId: string;
  content: SummaryContent;
  doctorId: string;
  changeReason: string | null;
  actorUserId: string;
  /** Nurses/RMOs may finalise it for the doctor (then countersigned). */
  mayTranscribe: boolean;
  clientId: string;
}): Promise<{ id: string; version: number; signed: boolean; repeat: boolean }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [existing] = await tx
        .select({ id: dischargeSummaries.id, version: dischargeSummaries.version, signedAt: dischargeSummaries.signedAt })
        .from(dischargeSummaries)
        .where(eq(dischargeSummaries.clientId, args.clientId));
      if (existing) return { id: existing.id, version: existing.version, signed: Boolean(existing.signedAt), repeat: true };
      const admission = await admissionInTx(tx, args.admissionId);
      const [doctor] = await tx.select({ id: doctors.id, userId: doctors.userId, active: doctors.active }).from(doctors).where(eq(doctors.id, args.doctorId));
      if (!doctor?.active) throw new SummaryError('Choose the doctor responsible for the summary');
      const transcribed = doctor.userId !== args.actorUserId;
      if (transcribed && !args.mayTranscribe) throw new SummaryError('Only the doctor named can finalise this summary');
      const [last] = await tx
        .select({ id: dischargeSummaries.id, version: dischargeSummaries.version })
        .from(dischargeSummaries)
        .where(eq(dischargeSummaries.admissionId, admission.id))
        .orderBy(desc(dischargeSummaries.version))
        .limit(1)
        .for('update');
      const reason = args.changeReason?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
      if (last && (!reason || reason.length < 3)) throw new SummaryError('Say what changed in this version');
      const now = new Date();
      const origin = await requestOrigin();
      const [row] = await tx
        .insert(dischargeSummaries)
        .values({
          hospitalId: args.hospitalId,
          admissionId: admission.id,
          encounterId: admission.encounterId,
          patientId: admission.patientId,
          version: (last?.version ?? 0) + 1,
          supersedesId: last?.id ?? null,
          content: args.content,
          doctorId: doctor.id,
          finalisedAt: now,
          finalisedByUserId: args.actorUserId,
          transcribed,
          signedAt: transcribed ? null : now,
          signedByUserId: transcribed ? null : args.actorUserId,
          changeReason: last ? reason : null,
          recordedChannel: origin?.channel ?? null,
          recordedDeviceId: origin?.deviceId ?? null,
          recordedSessionId: origin?.sessionId ?? null,
          clientId: args.clientId,
        })
        .returning({ id: dischargeSummaries.id, version: dischargeSummaries.version });
      await tx.delete(dischargeSummaryDrafts).where(eq(dischargeSummaryDrafts.admissionId, admission.id));
      return { id: row.id, version: row.version, signed: !transcribed, repeat: false };
    },
    clinical,
  );
}

/** The responsible doctor countersigns a version finalised for them. */
export async function countersignSummary(args: { hospitalId: string; summaryId: string; actorUserId: string }): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [row] = await tx
        .select({ id: dischargeSummaries.id, signedAt: dischargeSummaries.signedAt, doctorUserId: doctors.userId })
        .from(dischargeSummaries)
        .innerJoin(doctors, eq(doctors.id, dischargeSummaries.doctorId))
        .where(eq(dischargeSummaries.id, args.summaryId))
        .for('update', { of: dischargeSummaries });
      if (!row) throw new SummaryError('Summary not found');
      if (row.signedAt) return;
      if (row.doctorUserId !== args.actorUserId) throw new SummaryError('Only the doctor named on the summary can sign it');
      await tx.update(dischargeSummaries).set({ signedAt: new Date(), signedByUserId: args.actorUserId }).where(eq(dischargeSummaries.id, row.id));
    },
    clinical,
  );
}

/** Summaries finalised for this doctor and waiting for their signature. */
export async function listSummariesToSign(args: { hospitalId: string; userId: string }) {
  return withTenant(
    args.hospitalId,
    (tx) =>
      tx
        .select({ id: dischargeSummaries.id, admissionId: dischargeSummaries.admissionId, version: dischargeSummaries.version })
        .from(dischargeSummaries)
        .innerJoin(doctors, eq(doctors.id, dischargeSummaries.doctorId))
        .where(and(eq(doctors.userId, args.userId), isNull(dischargeSummaries.signedAt))),
    clinical,
  );
}
