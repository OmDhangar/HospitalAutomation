import { createHash } from 'node:crypto';
import { aliasedTable, and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { admissions, doctors, medRecItems, medRecSignoffs, medicines, treatmentOrders, users } from '@/lib/db/schema';
import {
  MedRecError,
  decisionNeedsNote,
  goingHome,
  isDecisionFor,
  medRecProgress,
  type MedRecDecision,
  type MedRecItemInput,
  type MedRecPhase,
  type MedRecProgress,
  type MedRecSource,
} from '@/lib/domain/medrec';
import { medicineLabel } from '@/lib/domain/medicine';

/**
 * Medication reconciliation (IPD sheets plan B2). One clinical transaction per
 * call. The patient's home medicines at admission, and the list going home at
 * discharge, each with a doctor's decision; a doctor completes each list.
 * The database keeps each medicine as written (only its decision moves) and
 * the sign-offs append-only.
 */

export { MedRecError };

const clinical = { clinical: true } as const;

function derivedId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function admissionInTx(tx: Tx, admissionId: string) {
  const [row] = await tx
    .select({ id: admissions.id, encounterId: admissions.encounterId, patientId: admissions.patientId, status: admissions.status })
    .from(admissions)
    .where(eq(admissions.id, admissionId));
  if (!row) throw new MedRecError('Patient not found');
  if (row.status === 'discharged' || row.status === 'cancelled') throw new MedRecError('This stay is closed');
  return row;
}

export type MedRecItemView = {
  id: string;
  phase: MedRecPhase;
  name: string;
  dose: string | null;
  frequency: string | null;
  route: string | null;
  duration: string | null;
  source: MedRecSource | null;
  orderId: string | null;
  fromItemId: string | null;
  decision: MedRecDecision | null;
  decisionNote: string | null;
  decidedBy: string | null;
  recordedBy: string | null;
};

export type MedRecSignoffView = { signedAt: Date; doctorName: string; noneAtHome: boolean; items: number };

export type MedRecView = {
  admission: { items: MedRecItemView[]; progress: MedRecProgress; signoff: MedRecSignoffView | null };
  discharge: { items: MedRecItemView[]; progress: MedRecProgress; signoff: MedRecSignoffView | null; goingHome: MedRecItemView[] };
  /** Active medicine lines on the card not yet on the discharge list. */
  cardLinesNotListed: { orderId: string; description: string; dose: string | null; frequency: string | null; route: string | null }[];
};

export async function getMedRec(hospitalId: string, admissionId: string): Promise<MedRecView> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const decider = aliasedTable(users, 'decider');
      const recorder = aliasedTable(users, 'recorder');
      const items: MedRecItemView[] = await tx
        .select({
          id: medRecItems.id,
          phase: medRecItems.phase,
          name: medRecItems.name,
          dose: medRecItems.dose,
          frequency: medRecItems.frequency,
          route: medRecItems.route,
          duration: medRecItems.duration,
          source: medRecItems.source,
          orderId: medRecItems.orderId,
          fromItemId: medRecItems.fromItemId,
          decision: medRecItems.decision,
          decisionNote: medRecItems.decisionNote,
          decidedBy: decider.name,
          recordedBy: recorder.name,
        })
        .from(medRecItems)
        .leftJoin(decider, eq(decider.id, medRecItems.decidedByUserId))
        .leftJoin(recorder, eq(recorder.id, medRecItems.recordedByUserId))
        .where(and(eq(medRecItems.admissionId, admissionId), isNull(medRecItems.voidedAt)))
        .orderBy(asc(medRecItems.recordedAt));
      const signoffs = await tx
        .select({ phase: medRecSignoffs.phase, signedAt: medRecSignoffs.signedAt, doctorName: doctors.name, noneAtHome: medRecSignoffs.noneAtHome, items: medRecSignoffs.items })
        .from(medRecSignoffs)
        .innerJoin(doctors, eq(doctors.id, medRecSignoffs.doctorId))
        .where(eq(medRecSignoffs.admissionId, admissionId))
        .orderBy(desc(medRecSignoffs.signedAt));
      const lines = await tx
        .select({ orderId: treatmentOrders.id, description: treatmentOrders.description, dose: treatmentOrders.dose, frequency: treatmentOrders.frequency, route: treatmentOrders.route })
        .from(treatmentOrders)
        .where(
          and(
            eq(treatmentOrders.admissionId, admissionId),
            eq(treatmentOrders.kind, 'medicine'),
            isNull(treatmentOrders.stoppedAt),
            isNull(treatmentOrders.voidedAt),
          ),
        )
        .orderBy(asc(treatmentOrders.orderedAt));
      const admissionItems = items.filter((i) => i.phase === 'admission');
      const dischargeItems = items.filter((i) => i.phase === 'discharge');
      const listed = new Set(dischargeItems.map((i) => i.orderId).filter(Boolean));
      return {
        admission: { items: admissionItems, progress: medRecProgress(admissionItems), signoff: signoffs.find((s) => s.phase === 'admission') ?? null },
        discharge: {
          items: dischargeItems,
          progress: medRecProgress(dischargeItems),
          signoff: signoffs.find((s) => s.phase === 'discharge') ?? null,
          goingHome: goingHome(dischargeItems),
        },
        cardLinesNotListed: lines.filter((l) => !listed.has(l.orderId)),
      };
    },
    clinical,
  );
}

/** Adds a medicine to a list: a home medicine at admission, or a new one at discharge. */
export async function addMedRecItem(args: {
  hospitalId: string;
  admissionId: string;
  phase: MedRecPhase;
  input: MedRecItemInput;
  source: MedRecSource;
  medicineId?: string | null;
  clientId: string;
  actorUserId: string;
}): Promise<{ id: string }> {
  if (args.phase === 'admission' && !['patient', 'family', 'prescription', 'records'].includes(args.source)) throw new MedRecError('Say where this medicine came from');
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [existing] = await tx.select({ id: medRecItems.id }).from(medRecItems).where(eq(medRecItems.clientId, args.clientId));
      if (existing) return existing;
      const admission = await admissionInTx(tx, args.admissionId);
      let name = args.input.name;
      if (args.medicineId) {
        const [medicine] = await tx.select({ name: medicines.name, strength: medicines.strength, form: medicines.form }).from(medicines).where(eq(medicines.id, args.medicineId));
        if (!medicine) throw new MedRecError('That medicine is not in the list');
        name = medicineLabel(medicine);
      }
      const isNew = args.phase === 'discharge';
      const now = new Date();
      const [row] = await tx
        .insert(medRecItems)
        .values({
          hospitalId: args.hospitalId,
          admissionId: admission.id,
          encounterId: admission.encounterId,
          patientId: admission.patientId,
          phase: args.phase,
          name,
          medicineId: args.medicineId ?? null,
          dose: args.input.dose,
          frequency: args.input.frequency,
          route: args.input.route,
          duration: args.input.duration,
          source: isNew ? 'new' : args.source,
          // A medicine added at discharge is new by definition: decided as it is written.
          decision: isNew ? 'new' : null,
          decidedAt: isNew ? now : null,
          decidedByUserId: isNew ? args.actorUserId : null,
          recordedByUserId: args.actorUserId,
          clientId: args.clientId,
        })
        .returning({ id: medRecItems.id });
      return row;
    },
    clinical,
  );
}

/**
 * Starts the discharge list from what is current: every active medicine on
 * the treatment card, and every home medicine that was continued or held at
 * admission (and not already listed). Safe to run again: it adds only what is
 * missing.
 */
export async function prepareDischargeList(args: { hospitalId: string; admissionId: string; actorUserId: string }): Promise<{ added: number }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await admissionInTx(tx, args.admissionId);
      const lines = await tx
        .select({ id: treatmentOrders.id, description: treatmentOrders.description, medicineId: treatmentOrders.medicineId, dose: treatmentOrders.dose, frequency: treatmentOrders.frequency, route: treatmentOrders.route })
        .from(treatmentOrders)
        .where(and(eq(treatmentOrders.admissionId, admission.id), eq(treatmentOrders.kind, 'medicine'), isNull(treatmentOrders.stoppedAt), isNull(treatmentOrders.voidedAt)));
      const home = await tx
        .select()
        .from(medRecItems)
        .where(and(eq(medRecItems.admissionId, admission.id), eq(medRecItems.phase, 'admission'), isNull(medRecItems.voidedAt)));
      let added = 0;
      const base = { hospitalId: args.hospitalId, admissionId: admission.id, encounterId: admission.encounterId, patientId: admission.patientId, phase: 'discharge' as const, recordedByUserId: args.actorUserId };
      for (const line of lines) {
        const inserted = await tx
          .insert(medRecItems)
          .values({ ...base, name: line.description, medicineId: line.medicineId, dose: line.dose, frequency: line.frequency, route: line.route, source: 'treatment_card', orderId: line.id, clientId: derivedId(`medrec:discharge:order:${line.id}`) })
          .onConflictDoNothing()
          .returning({ id: medRecItems.id });
        added += inserted.length;
      }
      for (const item of home.filter((h) => h.decision === 'continue' || h.decision === 'hold' || h.decision === 'change')) {
        const inserted = await tx
          .insert(medRecItems)
          .values({ ...base, name: item.name, medicineId: item.medicineId, dose: item.dose, frequency: item.frequency, route: item.route, source: 'home', fromItemId: item.id, clientId: derivedId(`medrec:discharge:home:${item.id}`) })
          .onConflictDoNothing()
          .returning({ id: medRecItems.id });
        added += inserted.length;
      }
      return { added };
    },
    clinical,
  );
}

/** A doctor's decision on one medicine; a change, hold or stop says why. */
export async function decideMedRecItem(args: {
  hospitalId: string;
  itemId: string;
  decision: string;
  note: string | null;
  /** At discharge, "changed" may give the new dose and how long. */
  duration?: string | null;
  actorUserId: string;
}): Promise<void> {
  const note = args.note?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [item] = await tx.select().from(medRecItems).where(eq(medRecItems.id, args.itemId)).for('update');
      if (!item || item.voidedAt) throw new MedRecError('Medicine not found');
      await admissionInTx(tx, item.admissionId);
      if (!isDecisionFor(item.phase, args.decision) || (item.phase === 'discharge' && args.decision === 'new' && item.source !== 'new')) {
        throw new MedRecError('Choose a decision');
      }
      if (decisionNeedsNote(args.decision) && !note) throw new MedRecError(args.decision === 'change' ? 'Say what changes' : 'Say why');
      await tx
        .update(medRecItems)
        .set({ decision: args.decision, decisionNote: note, decidedAt: new Date(), decidedByUserId: args.actorUserId })
        .where(eq(medRecItems.id, item.id));
    },
    clinical,
  );
}

export async function strikeOutMedRecItem(args: { hospitalId: string; itemId: string; reason: string; actorUserId: string }): Promise<void> {
  const reason = args.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason.length < 3) throw new MedRecError('Write why it is struck out');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [item] = await tx
        .update(medRecItems)
        .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: reason })
        .where(and(eq(medRecItems.id, args.itemId), isNull(medRecItems.voidedAt)))
        .returning({ id: medRecItems.id });
      if (!item) throw new MedRecError('Medicine not found');
    },
    clinical,
  );
}

/**
 * A doctor completes a list: every medicine decided (at admission, an empty
 * list only with "takes nothing at home"). Signing again later records the
 * list as it then is; the latest sign-off counts.
 */
export async function signMedRec(args: {
  hospitalId: string;
  admissionId: string;
  phase: MedRecPhase;
  noneAtHome: boolean;
  actorUserId: string;
}): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await admissionInTx(tx, args.admissionId);
      const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(and(eq(doctors.userId, args.actorUserId), eq(doctors.active, true)));
      if (!doctor) throw new MedRecError('Only a doctor’s own login can complete the reconciliation');
      const items = await tx
        .select({ decision: medRecItems.decision })
        .from(medRecItems)
        .where(and(eq(medRecItems.admissionId, admission.id), eq(medRecItems.phase, args.phase), isNull(medRecItems.voidedAt)));
      const progress = medRecProgress(items);
      if (!progress.complete) throw new MedRecError(`${progress.total - progress.decided} medicine${progress.total - progress.decided === 1 ? ' has' : 's have'} no decision yet`);
      if (args.phase === 'admission' && items.length === 0 && !args.noneAtHome) throw new MedRecError('Add the home medicines, or tick “takes nothing at home”');
      if (args.noneAtHome && items.length > 0) throw new MedRecError('Home medicines are listed: untick “takes nothing at home”');
      if (args.phase === 'discharge' && items.length === 0) throw new MedRecError('Nothing is listed for home. Add the medicines, or “Start from the card” first.');
      await tx.insert(medRecSignoffs).values({
        hospitalId: args.hospitalId,
        admissionId: admission.id,
        phase: args.phase,
        noneAtHome: args.phase === 'admission' && args.noneAtHome,
        items: items.length,
        signedByUserId: args.actorUserId,
        doctorId: doctor.id,
      });
    },
    clinical,
  );
}

/** For the patient lists: admissions whose admission reconciliation is not completed yet. */
export async function admissionsWithoutMedRec(hospitalId: string, admissionIds: readonly string[]): Promise<Set<string>> {
  if (admissionIds.length === 0) return new Set();
  return withTenant(
    hospitalId,
    async (tx) => {
      const done = await tx
        .selectDistinct({ admissionId: medRecSignoffs.admissionId })
        .from(medRecSignoffs)
        .where(and(eq(medRecSignoffs.phase, 'admission'), inArray(medRecSignoffs.admissionId, [...admissionIds])));
      const signed = new Set(done.map((d) => d.admissionId));
      return new Set(admissionIds.filter((id) => !signed.has(id)));
    },
    clinical,
  );
}
