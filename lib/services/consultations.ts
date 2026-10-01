import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  auditLogs,
  branches,
  clinicalNotes,
  consultationDrafts,
  diagnoses,
  doctors,
  encounters,
  hospitals,
  medicines,
  patients,
  prescriptionItems,
  prescriptions,
  recordAccessLogs,
} from '@/lib/db/schema';
import {
  parseConsultation,
  parseDraft,
  samePrescription,
  type ConsultationDraft,
  type DraftLine,
  type PrescriptionLine,
} from '@/lib/domain/consultation';
import { medicineLabel } from '@/lib/domain/medicine';
import { can, type StaffRole } from '@/lib/domain/permissions';
import {
  getEncounterInTx,
  openEncounterForAppointmentInTx,
  type EncounterRow,
} from '@/lib/services/encounters';

/**
 * The OPD consultation: what the doctor concluded (diagnosis), observed
 * (notes) and ordered (prescription) at one visit.
 *
 * Three rules shape this module:
 *
 *   - Every transaction here opens with `{ clinical: true }`. Without it the
 *     clinical tables are invisible — see 0028 — so this module is, by
 *     construction, the only way in.
 *   - Until Save, the doctor's work is a draft: scratch space, freely
 *     overwritten, not part of the record. Save writes the record in one
 *     transaction and deletes the draft. After that nothing is edited: a
 *     change is a void plus a new row, or a new prescription that supersedes
 *     the old one. That is what keeps a printed prescription true.
 *   - Only the visit's attending doctor may write it, identified by the login
 *     linked to that doctor (doctors.user_id), not by role alone.
 *
 * Nothing clinical is copied into audit_logs; they record that something
 * happened and to which record, not what it said.
 */

export class ConsultationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsultationError';
  }
}

/** Another screen saved this draft first. */
export class DraftConflictError extends ConsultationError {
  constructor() {
    super('This consultation was changed on another screen. Reload to see the latest.');
    this.name = 'DraftConflictError';
  }
}

export type Actor = { userId: string; role: StaffRole };

/* ------------------------------------------------------------ access */

type AttendingDoctor = { id: string; name: string; userId: string | null };

async function attendingDoctorInTx(tx: Tx, encounter: EncounterRow): Promise<AttendingDoctor> {
  const [doctor] = await tx
    .select({ id: doctors.id, name: doctors.name, userId: doctors.userId })
    .from(doctors)
    .where(eq(doctors.id, encounter.attendingDoctorId));
  if (!doctor) throw new ConsultationError('Doctor not found');
  return doctor;
}

/** Why this person may not write this visit, or null if they may. */
function writeRefusal(actor: Actor, doctor: AttendingDoctor): string | null {
  if (!can(actor.role, 'clinical.write')) {
    return `Only ${doctor.name} can write this consultation.`;
  }
  if (doctor.userId !== actor.userId) {
    return (
      `Only ${doctor.name} can write this consultation. If you are ${doctor.name}, ` +
      'ask the owner to link your login to this doctor in Settings → Doctors.'
    );
  }
  return null;
}

async function assertAttendingInTx(tx: Tx, encounter: EncounterRow, actor: Actor) {
  const doctor = await attendingDoctorInTx(tx, encounter);
  const refusal = writeRefusal(actor, doctor);
  if (refusal) throw new ConsultationError(refusal);
  return doctor;
}

function assertCanRead(actor: Actor) {
  if (!can(actor.role, 'clinical.read')) {
    throw new ConsultationError('You do not have access to medical records');
  }
}

/* --------------------------------------------------- current record */

export type SavedConsultation = {
  diagnosis: string;
  notes: string;
  items: DraftLine[];
  advice: string;
  followUpOn: string | null;
  /** The current prescription, if the visit has one. */
  prescriptionId: string | null;
  savedAt: string;
};

type CurrentRecord = {
  diagnosis: { id: string; text: string } | null;
  note: { id: string; body: string } | null;
  prescription: {
    id: string;
    advice: string;
    followUpOn: string | null;
    createdAt: Date;
    items: (PrescriptionLine & { label: string })[];
  } | null;
};

/** The live diagnosis, note and prescription of a visit — what Save last wrote. */
async function currentRecordInTx(tx: Tx, encounterId: string): Promise<CurrentRecord> {
  const [diagnosisRows, noteRows, prescriptionRows] = await Promise.all([
    tx
      .select({ id: diagnoses.id, text: diagnoses.text, createdAt: diagnoses.createdAt })
      .from(diagnoses)
      .where(and(eq(diagnoses.encounterId, encounterId), isNull(diagnoses.voidedAt)))
      .orderBy(desc(diagnoses.createdAt))
      .limit(1),
    tx
      .select({ id: clinicalNotes.id, body: clinicalNotes.body })
      .from(clinicalNotes)
      .where(
        and(
          eq(clinicalNotes.encounterId, encounterId),
          eq(clinicalNotes.kind, 'consultation'),
          isNull(clinicalNotes.voidedAt),
        ),
      )
      .orderBy(desc(clinicalNotes.createdAt))
      .limit(1),
    tx
      .select()
      .from(prescriptions)
      .where(and(eq(prescriptions.encounterId, encounterId), eq(prescriptions.status, 'final'))),
  ]);

  const current = prescriptionRows[0];
  const items = current
    ? await tx
        .select()
        .from(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, current.id))
        .orderBy(prescriptionItems.sortOrder)
    : [];

  return {
    diagnosis: diagnosisRows[0] ?? null,
    note: noteRows[0] ?? null,
    prescription: current
      ? {
          id: current.id,
          advice: current.advice ?? '',
          followUpOn: current.followUpOn,
          createdAt: current.createdAt,
          items: items.map((item) => ({
            medicineId: item.medicineId,
            dose: item.dose,
            frequency: item.frequency,
            durationDays: item.durationDays,
            instructions: item.instructions ?? '',
            label: medicineLabel({ name: item.medicineName, strength: item.strength, form: item.form }),
          })),
        }
      : null,
  };
}

/* ---------------------------------------------------- frequent picks */

export type FrequentMedicine = DraftLine;

/**
 * The medicines this doctor prescribes most, each with how they last wrote it,
 * so one tap adds a complete line. A query over their own prescriptions — not
 * a favourites table somebody has to maintain.
 */
async function frequentMedicinesInTx(tx: Tx, doctorId: string): Promise<FrequentMedicine[]> {
  const rows = await tx.execute<{
    medicine_id: string;
    name: string;
    strength: string | null;
    form: string | null;
    dose: string;
    frequency: string;
    duration_days: number | null;
    instructions: string | null;
  }>(sql`
    with recent as (
      select pi.medicine_id, pi.dose, pi.frequency, pi.duration_days, pi.instructions, p.created_at
      from prescription_items pi
      join prescriptions p on p.id = pi.prescription_id
      where p.prescriber_doctor_id = ${doctorId}
        and p.created_at > now() - interval '90 days'
    ),
    ranked as (
      select medicine_id, count(*) as uses
      from recent
      group by medicine_id
      order by uses desc
      limit 8
    ),
    latest as (
      select distinct on (medicine_id)
        medicine_id, dose, frequency, duration_days, instructions
      from recent
      order by medicine_id, created_at desc
    )
    select m.id as medicine_id, m.name, m.strength, m.form,
           latest.dose, latest.frequency, latest.duration_days, latest.instructions
    from ranked
    join latest on latest.medicine_id = ranked.medicine_id
    join medicines m on m.id = ranked.medicine_id
    where m.active
    order by ranked.uses desc
  `);

  return rows.map((row) => ({
    medicineId: row.medicine_id,
    medicineLabel: medicineLabel(row),
    dose: row.dose,
    frequency: row.frequency,
    durationDays: row.duration_days === null ? null : Number(row.duration_days),
    instructions: row.instructions ?? '',
  }));
}

/* ---------------------------------------------------------------- open */

export type ConsultationView = {
  encounterId: string;
  patient: { name: string; age: number | null; gender: string | null };
  doctorName: string;
  canWrite: boolean;
  /** Shown instead of the form when `canWrite` is false. */
  cannotWriteReason: string | null;
  draft: { version: number; content: ConsultationDraft } | null;
  saved: SavedConsultation | null;
  frequent: FrequentMedicine[];
  /** Whether "Prior visits" and "Repeat last prescription" have anything to show. */
  hasEarlierVisits: boolean;
};

/**
 * Everything the consultation panel needs for the patient in the room.
 * Opens the visit's encounter if this is the first time anyone has.
 */
export async function openConsultation(args: {
  hospitalId: string;
  appointmentId: string;
  actor: Actor;
}): Promise<ConsultationView> {
  assertCanRead(args.actor);

  return withTenant(
    args.hospitalId,
    async (tx) => {
      const encounter = await openEncounterForAppointmentInTx(tx, {
        appointmentId: args.appointmentId,
        actorUserId: args.actor.userId,
      });
      const doctor = await attendingDoctorInTx(tx, encounter);
      const refusal = writeRefusal(args.actor, doctor);

      const [[patient], [draft], current, frequent, [earlier]] = await Promise.all([
        tx
          .select({ name: patients.name, age: patients.age, gender: patients.gender })
          .from(patients)
          .where(eq(patients.id, encounter.patientId)),
        tx
          .select({ version: consultationDrafts.version, payload: consultationDrafts.payload })
          .from(consultationDrafts)
          .where(eq(consultationDrafts.encounterId, encounter.id)),
        currentRecordInTx(tx, encounter.id),
        refusal ? Promise.resolve([]) : frequentMedicinesInTx(tx, doctor.id),
        tx.execute<{ exists: boolean }>(sql`
          select exists (
            select 1 from prescriptions p
            where p.patient_id = ${encounter.patientId}
              and p.encounter_id <> ${encounter.id}
              and p.status = 'final'
          ) or exists (
            select 1 from diagnoses d
            where d.patient_id = ${encounter.patientId}
              and d.encounter_id <> ${encounter.id}
              and d.voided_at is null
          ) as exists
        `),
      ]);

      const parsedDraft = draft ? parseDraft(draft.payload) : null;
      const hasSaved = current.diagnosis || current.note || current.prescription;

      return {
        encounterId: encounter.id,
        patient: patient ?? { name: 'Patient', age: null, gender: null },
        doctorName: doctor.name,
        canWrite: refusal === null,
        cannotWriteReason: refusal,
        draft:
          draft && parsedDraft?.ok ? { version: draft.version, content: parsedDraft.value } : null,
        saved: hasSaved
          ? {
              diagnosis: current.diagnosis?.text ?? '',
              notes: current.note?.body ?? '',
              advice: current.prescription?.advice ?? '',
              followUpOn: current.prescription?.followUpOn ?? null,
              items: (current.prescription?.items ?? []).map(({ label, ...line }) => ({
                ...line,
                medicineLabel: label,
              })),
              prescriptionId: current.prescription?.id ?? null,
              savedAt: (current.prescription?.createdAt ?? new Date()).toISOString(),
            }
          : null,
        frequent,
        hasEarlierVisits: Boolean(earlier?.exists),
      };
    },
    { clinical: true },
  );
}

/* --------------------------------------------------------------- draft */

/**
 * Autosave. The draft is versioned: a write carries the version it was based
 * on, and is refused if another screen has saved since — rather than one
 * device silently erasing what the doctor typed on the other.
 */
export async function saveDraft(args: {
  hospitalId: string;
  encounterId: string;
  content: unknown;
  /** The version this edit started from; null when no draft exists yet. */
  expectedVersion: number | null;
  actor: Actor;
}): Promise<{ version: number }> {
  const parsed = parseDraft(args.content);
  if (!parsed.ok) throw new ConsultationError(parsed.error);

  return withTenant(
    args.hospitalId,
    async (tx) => {
      const encounter = await getEncounterInTx(tx, args.encounterId, { lock: true });
      const doctor = await assertAttendingInTx(tx, encounter, args.actor);

      if (args.expectedVersion === null) {
        const [created] = await tx
          .insert(consultationDrafts)
          .values({
            hospitalId: encounter.hospitalId,
            encounterId: encounter.id,
            patientId: encounter.patientId,
            doctorId: doctor.id,
            payload: parsed.value,
            updatedByUserId: args.actor.userId,
          })
          .onConflictDoNothing({ target: consultationDrafts.encounterId })
          .returning({ version: consultationDrafts.version });
        if (!created) throw new DraftConflictError();
        return created;
      }

      const [updated] = await tx
        .update(consultationDrafts)
        .set({
          payload: parsed.value,
          version: sql`${consultationDrafts.version} + 1`,
          updatedByUserId: args.actor.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(consultationDrafts.encounterId, encounter.id),
            eq(consultationDrafts.version, args.expectedVersion),
          ),
        )
        .returning({ version: consultationDrafts.version });
      if (!updated) throw new DraftConflictError();
      return updated;
    },
    { clinical: true },
  );
}

/* ---------------------------------------------------------------- save */

/**
 * Writes the consultation into the patient's record, in one transaction.
 *
 *   - diagnosis and notes: unchanged text is left alone; changed text voids
 *     the previous row (reason "Revised") and inserts the new one.
 *   - prescription: an unchanged prescription is left alone; a changed one
 *     supersedes the previous version, whose printout stays readable as
 *     "superseded". Each line snapshots the medicine's name as it is now.
 *   - the draft is deleted.
 *
 * Any failure — an inactive medicine, a medicine from another hospital, a
 * database error — leaves nothing half-written.
 */
export async function saveConsultation(args: {
  hospitalId: string;
  encounterId: string;
  input: unknown;
  actor: Actor;
}): Promise<{ prescriptionId: string | null }> {
  const parsed = parseConsultation(args.input);
  if (!parsed.ok) throw new ConsultationError(parsed.error);
  const input = parsed.value;

  return withTenant(
    args.hospitalId,
    async (tx) => {
      const encounter = await getEncounterInTx(tx, args.encounterId, { lock: true });
      const doctor = await assertAttendingInTx(tx, encounter, args.actor);

      // Read every medicine again, here, under this hospital's security policy.
      // The browser sent ids; the names printed come from the catalogue.
      const ids = input.items.map((item) => item.medicineId);
      const found = ids.length
        ? await tx
            .select({
              id: medicines.id,
              name: medicines.name,
              strength: medicines.strength,
              form: medicines.form,
              active: medicines.active,
            })
            .from(medicines)
            .where(inArray(medicines.id, ids))
        : [];
      const byId = new Map(found.map((row) => [row.id, row]));
      for (const id of ids) {
        const medicine = byId.get(id);
        if (!medicine) throw new ConsultationError('A medicine on this prescription was not found');
        if (!medicine.active) {
          throw new ConsultationError(
            `${medicineLabel(medicine)} is no longer offered by this hospital. Choose another.`,
          );
        }
      }

      const current = await currentRecordInTx(tx, encounter.id);
      const now = new Date();
      const base = {
        hospitalId: encounter.hospitalId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
      };

      if (input.diagnosis !== (current.diagnosis?.text ?? '')) {
        if (current.diagnosis) {
          await tx
            .update(diagnoses)
            .set({ voidedAt: now, voidedByUserId: args.actor.userId, voidReason: 'Revised' })
            .where(eq(diagnoses.id, current.diagnosis.id));
        }
        if (input.diagnosis) {
          await tx.insert(diagnoses).values({
            ...base,
            doctorId: doctor.id,
            text: input.diagnosis,
            recordedByUserId: args.actor.userId,
          });
        }
      }

      if (input.notes !== (current.note?.body ?? '')) {
        if (current.note) {
          await tx
            .update(clinicalNotes)
            .set({ voidedAt: now, voidedByUserId: args.actor.userId, voidReason: 'Revised' })
            .where(eq(clinicalNotes.id, current.note.id));
        }
        if (input.notes) {
          await tx.insert(clinicalNotes).values({
            ...base,
            kind: 'consultation',
            body: input.notes,
            authorUserId: args.actor.userId,
            doctorId: doctor.id,
          });
        }
      }

      const previous = current.prescription;
      let prescriptionId = previous?.id ?? null;
      const unchanged = samePrescription(
        {
          items: previous?.items ?? [],
          advice: previous?.advice ?? '',
          followUpOn: previous?.followUpOn ?? null,
        },
        input,
      );

      if (!unchanged) {
        // Supersede first: one visit has at most one current prescription, and
        // the unique index checks that at every statement.
        if (previous) {
          await tx
            .update(prescriptions)
            .set({ status: 'superseded' })
            .where(eq(prescriptions.id, previous.id));
        }

        const hasPrescription = input.items.length > 0 || input.advice !== '' || input.followUpOn !== null;
        prescriptionId = null;
        if (hasPrescription) {
          const [created] = await tx
            .insert(prescriptions)
            .values({
              ...base,
              prescriberDoctorId: doctor.id,
              prescriberName: doctor.name,
              advice: input.advice || null,
              followUpOn: input.followUpOn,
              supersedesPrescriptionId: previous?.id ?? null,
              createdByUserId: args.actor.userId,
            })
            .returning({ id: prescriptions.id });
          prescriptionId = created.id;

          if (input.items.length > 0) {
            await tx.insert(prescriptionItems).values(
              input.items.map((item, index) => {
                const medicine = byId.get(item.medicineId)!;
                return {
                  hospitalId: encounter.hospitalId,
                  prescriptionId: created.id,
                  medicineId: medicine.id,
                  medicineName: medicine.name,
                  strength: medicine.strength,
                  form: medicine.form,
                  dose: item.dose,
                  frequency: item.frequency,
                  durationDays: item.durationDays,
                  instructions: item.instructions || null,
                  sortOrder: index,
                };
              }),
            );
          }
        }

        await tx.insert(auditLogs).values({
          hospitalId: encounter.hospitalId,
          actorUserId: args.actor.userId,
          action: previous ? 'prescription.revised' : 'prescription.created',
          objectType: 'prescription',
          objectId: prescriptionId,
          metadata: { encounterId: encounter.id, supersedes: previous?.id ?? null },
        });
      }

      await tx.delete(consultationDrafts).where(eq(consultationDrafts.encounterId, encounter.id));

      await tx.insert(auditLogs).values({
        hospitalId: encounter.hospitalId,
        actorUserId: args.actor.userId,
        action: 'consultation.saved',
        objectType: 'encounter',
        objectId: encounter.id,
      });

      return { prescriptionId };
    },
    { clinical: true },
  );
}

/* ---------------------------------------------------------- repeat last */

/**
 * The patient's most recent prescription from an earlier visit, ready to drop
 * into the form — the fastest path for a chronic patient on the same medicines.
 * Medicines the hospital has since removed are left out and named.
 */
export async function lastPrescriptionForRepeat(args: {
  hospitalId: string;
  encounterId: string;
  actor: Actor;
}): Promise<{ items: DraftLine[]; skipped: string[]; fromDate: string; doctorName: string } | null> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const encounter = await getEncounterInTx(tx, args.encounterId);
      await assertAttendingInTx(tx, encounter, args.actor);

      const [last] = await tx
        .select({
          id: prescriptions.id,
          createdAt: prescriptions.createdAt,
          doctorName: prescriptions.prescriberName,
        })
        .from(prescriptions)
        .where(
          and(
            eq(prescriptions.patientId, encounter.patientId),
            eq(prescriptions.status, 'final'),
            ne(prescriptions.encounterId, encounter.id),
          ),
        )
        .orderBy(desc(prescriptions.createdAt))
        .limit(1);
      if (!last) return null;

      const items = await tx
        .select({
          item: prescriptionItems,
          active: medicines.active,
        })
        .from(prescriptionItems)
        .innerJoin(medicines, eq(medicines.id, prescriptionItems.medicineId))
        .where(eq(prescriptionItems.prescriptionId, last.id))
        .orderBy(prescriptionItems.sortOrder);

      const label = (item: typeof prescriptionItems.$inferSelect) =>
        medicineLabel({ name: item.medicineName, strength: item.strength, form: item.form });

      return {
        items: items
          .filter((row) => row.active)
          .map(({ item }) => ({
            medicineId: item.medicineId,
            medicineLabel: label(item),
            dose: item.dose,
            frequency: item.frequency,
            durationDays: item.durationDays,
            instructions: item.instructions ?? '',
          })),
        skipped: items.filter((row) => !row.active).map(({ item }) => label(item)),
        fromDate: last.createdAt.toISOString(),
        doctorName: last.doctorName,
      };
    },
    { clinical: true },
  );
}

/* ------------------------------------------------------------- history */

export type HistoryVisit = {
  encounterId: string;
  date: string;
  doctorName: string;
  diagnosis: string | null;
  notes: string | null;
  prescription: {
    id: string;
    items: { label: string; dose: string; frequency: string; durationDays: number | null; instructions: string | null }[];
    advice: string | null;
    followUpOn: string | null;
  } | null;
};

/**
 * The patient's earlier visits, derived from the records themselves — there is
 * no stored "history" to fall out of date. Every call is written to
 * record_access_logs, so the owner can answer "who looked at this patient?".
 */
export async function getPatientHistory(args: {
  hospitalId: string;
  encounterId: string;
  actor: Actor;
}): Promise<HistoryVisit[]> {
  assertCanRead(args.actor);

  return withTenant(
    args.hospitalId,
    async (tx) => {
      const encounter = await getEncounterInTx(tx, args.encounterId);

      await tx.insert(recordAccessLogs).values({
        hospitalId: encounter.hospitalId,
        actorUserId: args.actor.userId,
        patientId: encounter.patientId,
        encounterId: encounter.id,
        action: 'view_history',
      });

      const visits = await tx
        .select({ id: encounters.id, openedAt: encounters.openedAt, doctorName: doctors.name })
        .from(encounters)
        .innerJoin(doctors, eq(doctors.id, encounters.attendingDoctorId))
        .where(and(eq(encounters.patientId, encounter.patientId), ne(encounters.id, encounter.id)))
        .orderBy(desc(encounters.openedAt))
        .limit(20);
      if (visits.length === 0) return [];
      const visitIds = visits.map((v) => v.id);

      const [diagnosisRows, noteRows, prescriptionRows] = await Promise.all([
        tx
          .select({ encounterId: diagnoses.encounterId, text: diagnoses.text })
          .from(diagnoses)
          .where(and(inArray(diagnoses.encounterId, visitIds), isNull(diagnoses.voidedAt))),
        tx
          .select({ encounterId: clinicalNotes.encounterId, body: clinicalNotes.body })
          .from(clinicalNotes)
          .where(and(inArray(clinicalNotes.encounterId, visitIds), isNull(clinicalNotes.voidedAt))),
        tx
          .select()
          .from(prescriptions)
          .where(and(inArray(prescriptions.encounterId, visitIds), eq(prescriptions.status, 'final'))),
      ]);
      const itemRows = prescriptionRows.length
        ? await tx
            .select()
            .from(prescriptionItems)
            .where(
              inArray(
                prescriptionItems.prescriptionId,
                prescriptionRows.map((p) => p.id),
              ),
            )
            .orderBy(prescriptionItems.sortOrder)
        : [];

      return visits
        .map((visit): HistoryVisit => {
          const prescription = prescriptionRows.find((p) => p.encounterId === visit.id);
          return {
            encounterId: visit.id,
            date: visit.openedAt.toISOString(),
            doctorName: prescription?.prescriberName ?? visit.doctorName,
            diagnosis: diagnosisRows.find((d) => d.encounterId === visit.id)?.text ?? null,
            notes: noteRows.find((n) => n.encounterId === visit.id)?.body ?? null,
            prescription: prescription
              ? {
                  id: prescription.id,
                  advice: prescription.advice,
                  followUpOn: prescription.followUpOn,
                  items: itemRows
                    .filter((item) => item.prescriptionId === prescription.id)
                    .map((item) => ({
                      label: medicineLabel({
                        name: item.medicineName,
                        strength: item.strength,
                        form: item.form,
                      }),
                      dose: item.dose,
                      frequency: item.frequency,
                      durationDays: item.durationDays,
                      instructions: item.instructions,
                    })),
                }
              : null,
          };
        })
        // A visit where only the fee was taken has nothing clinical to show.
        .filter((visit) => visit.diagnosis || visit.notes || visit.prescription);
    },
    { clinical: true },
  );
}

/* --------------------------------------------------------------- print */

export type PrescriptionPrint = {
  id: string;
  superseded: boolean;
  createdAt: string;
  hospital: { name: string; branchName: string; branchAddress: string | null };
  doctor: { name: string; specialty: string | null };
  patient: { name: string; age: number | null; gender: string | null; phone: string };
  diagnosis: string | null;
  items: {
    label: string;
    dose: string;
    frequency: string;
    durationDays: number | null;
    instructions: string | null;
  }[];
  advice: string | null;
  followUpOn: string | null;
};

/**
 * Everything the printed slip shows, and nothing it does not: no price, no
 * internal notes. The name printed is the one saved with the prescription, not
 * whatever the catalogue says today. Logged, like any read of a record.
 */
export async function getPrescriptionForPrint(args: {
  hospitalId: string;
  prescriptionId: string;
  actor: Actor;
}): Promise<PrescriptionPrint> {
  assertCanRead(args.actor);

  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [row] = await tx
        .select({
          prescription: prescriptions,
          hospitalName: hospitals.name,
          branchName: branches.name,
          branchAddress: branches.address,
          specialty: doctors.specialty,
          patientName: patients.name,
          patientAge: patients.age,
          patientGender: patients.gender,
          patientPhone: patients.phoneE164,
        })
        .from(prescriptions)
        .innerJoin(encounters, eq(encounters.id, prescriptions.encounterId))
        .innerJoin(hospitals, eq(hospitals.id, prescriptions.hospitalId))
        .innerJoin(branches, eq(branches.id, encounters.branchId))
        .innerJoin(doctors, eq(doctors.id, prescriptions.prescriberDoctorId))
        .innerJoin(patients, eq(patients.id, prescriptions.patientId))
        .where(eq(prescriptions.id, args.prescriptionId));
      if (!row) throw new ConsultationError('Prescription not found');
      const p = row.prescription;

      const [items, [diagnosis]] = await Promise.all([
        tx
          .select()
          .from(prescriptionItems)
          .where(eq(prescriptionItems.prescriptionId, p.id))
          .orderBy(prescriptionItems.sortOrder),
        tx
          .select({ text: diagnoses.text })
          .from(diagnoses)
          .where(and(eq(diagnoses.encounterId, p.encounterId), isNull(diagnoses.voidedAt)))
          .orderBy(desc(diagnoses.createdAt))
          .limit(1),
      ]);

      await tx.insert(recordAccessLogs).values({
        hospitalId: p.hospitalId,
        actorUserId: args.actor.userId,
        patientId: p.patientId,
        encounterId: p.encounterId,
        action: 'print_prescription',
      });

      return {
        id: p.id,
        superseded: p.status === 'superseded',
        createdAt: p.createdAt.toISOString(),
        hospital: { name: row.hospitalName, branchName: row.branchName, branchAddress: row.branchAddress },
        doctor: { name: p.prescriberName, specialty: row.specialty },
        patient: {
          name: row.patientName,
          age: row.patientAge,
          gender: row.patientGender,
          phone: row.patientPhone,
        },
        diagnosis: diagnosis?.text ?? null,
        items: items.map((item) => ({
          label: medicineLabel({ name: item.medicineName, strength: item.strength, form: item.form }),
          dose: item.dose,
          frequency: item.frequency,
          durationDays: item.durationDays,
          instructions: item.instructions,
        })),
        advice: p.advice,
        followUpOn: p.followUpOn,
      };
    },
    { clinical: true },
  );
}
