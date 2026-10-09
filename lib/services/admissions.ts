import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  appointments,
  auditLogs,
  bedAssignments,
  beds,
  branches,
  careEntries,
  doctors,
  encounters,
  patients,
  wards,
} from '@/lib/db/schema';
import {
  UNDO_SHIFT_MESSAGES,
  canMoveAdmission,
  tidyReason,
  undoShiftRefusal,
  type AdmissionStatus,
} from '@/lib/domain/admission';
import type { PayerInput } from '@/lib/domain/payer';
import type { AppointmentStatus } from '@/lib/domain/types';
import { setPayerInTx } from '@/lib/services/encounter-payers';
import { getEncounterInTx, openEncounterForAppointmentInTx, type EncounterRow } from '@/lib/services/encounters';
import { recordDepositInTx } from '@/lib/services/patient-billing';
import { resolvePatientInTx, type PatientInput } from '@/lib/services/patients';

/**
 * Admissions: Shift to IPD, the admission sheet, transfers, cancellation and
 * the doctor's Discharge ready (IPD plan §5.1–5.5, tasks T1.4 and T1.6).
 *
 * Every function runs with the clinical key — admissions are medical
 * records — and locks the admission (or the encounter, for Shift to IPD) so
 * two people acting on the same patient at once are serialised rather than
 * interleaved. Authorisation is the caller's (`ipd.shift`, `ipd.admit`,
 * `ipd.dischargeReady`).
 */

export class AdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionError';
  }
}

/** Someone took the bed between the grid loading and Confirm. */
export class BedTakenError extends AdmissionError {
  constructor(readonly bedLabel: string) {
    super(`Bed ${bedLabel} was just taken. Pick another.`);
    this.name = 'BedTakenError';
  }
}

export type AdmissionRow = typeof admissions.$inferSelect;

const UNIQUE_VIOLATION = '23505';
const violatedConstraint = (err: unknown): string | null => {
  for (
    let e = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (e.code === UNIQUE_VIOLATION) return e.constraint_name ?? e.constraint ?? '';
  }
  return null;
};

async function lockAdmissionInTx(tx: Tx, admissionId: string): Promise<AdmissionRow> {
  const [row] = await tx.select().from(admissions).where(eq(admissions.id, admissionId)).for('update');
  if (!row) throw new AdmissionError('Admission not found');
  return row;
}

const audit = (
  tx: Tx,
  row: { hospitalId: string; id: string },
  actorUserId: string,
  action: string,
  metadata?: Record<string, unknown>,
) =>
  tx.insert(auditLogs).values({
    hospitalId: row.hospitalId,
    actorUserId,
    action,
    objectType: 'admission',
    objectId: row.id,
    metadata,
  });

/* ----------------------------------------------------------- Shift to IPD */

export type ShiftResult = {
  admissionId: string;
  /** False when the patient was already shifted: a double tap, or two doctors. */
  created: boolean;
  patientName: string;
  doctorId: string;
  /** The OPD token's status, so the caller knows whether to complete it. */
  appointmentStatus: AppointmentStatus;
};

/**
 * The doctor's one-click Shift to IPD.
 *
 * Opens (and locks) the visit's encounter, creates the admission awaiting a
 * bed, and turns the same encounter to IPD. Idempotent: the live-admission
 * index makes a second tap find the first admission instead of making a
 * second. Completing the OPD token is the caller's job, through the queue's
 * own applyQueueAction, so the queue state machine is never bypassed.
 */
export async function shiftToIpd(args: {
  hospitalId: string;
  appointmentId: string;
  actorUserId: string;
  reason?: string | null;
}): Promise<ShiftResult> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const encounter = await openEncounterForAppointmentInTx(tx, {
        appointmentId: args.appointmentId,
        actorUserId: args.actorUserId,
      });
      if (encounter.status !== 'open') throw new AdmissionError('This visit is closed');

      const inserted = await tx
        .insert(admissions)
        .values({
          hospitalId: encounter.hospitalId,
          encounterId: encounter.id,
          patientId: encounter.patientId,
          branchId: encounter.branchId,
          admittingDoctorId: encounter.attendingDoctorId,
          reason: tidyReason(args.reason),
          requestedByUserId: args.actorUserId,
        })
        .onConflictDoNothing({
          target: admissions.encounterId,
          where: sql`status <> 'cancelled'`,
        })
        .returning({ id: admissions.id });

      const [live] = await tx
        .select({ id: admissions.id, status: admissions.status })
        .from(admissions)
        .where(and(eq(admissions.encounterId, encounter.id), ne(admissions.status, 'cancelled')));
      if (!live) throw new AdmissionError('Could not shift the patient. Try again.');

      if (encounter.stage !== 'ipd') {
        await tx
          .update(encounters)
          .set({ stage: 'ipd', updatedAt: new Date() })
          .where(eq(encounters.id, encounter.id));
      }

      const [info] = await tx
        .select({ patientName: patients.name, status: appointments.status })
        .from(appointments)
        .innerJoin(patients, eq(patients.id, appointments.patientId))
        .where(eq(appointments.id, args.appointmentId));

      if (inserted.length > 0) {
        await audit(tx, { hospitalId: encounter.hospitalId, id: live.id }, args.actorUserId, 'ipd.shifted', {
          encounterId: encounter.id,
          appointmentId: args.appointmentId,
        });
      }

      return {
        admissionId: live.id,
        created: inserted.length > 0,
        patientName: info.patientName,
        doctorId: encounter.attendingDoctorId,
        appointmentStatus: info.status,
      };
    },
    { clinical: true },
  );
}

/**
 * The toast's Undo. Cancels the request and returns the visit to OPD — but
 * only while it is a mis-tap: still awaiting a bed, within ten minutes, with
 * nothing recorded (decision D-UD: the OPD token stays completed).
 */
export async function undoShiftToIpd(args: {
  hospitalId: string;
  admissionId: string;
  actorUserId: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await lockAdmissionInTx(tx, args.admissionId);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(careEntries)
        .where(eq(careEntries.admissionId, admission.id));
      const refusal = undoShiftRefusal({
        status: admission.status,
        requestedAt: admission.requestedAt,
        careEntryCount: count,
        now,
      });
      if (refusal) throw new AdmissionError(UNDO_SHIFT_MESSAGES[refusal]);

      await tx
        .update(admissions)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancelledByUserId: args.actorUserId,
          cancelReason: 'Undone by doctor',
          updatedAt: now,
        })
        .where(eq(admissions.id, admission.id));
      await tx
        .update(encounters)
        .set({ stage: 'opd', updatedAt: now })
        .where(and(eq(encounters.id, admission.encounterId), isNull(encounters.closedAt)));
      await audit(tx, admission, args.actorUserId, 'ipd.shift_undone');
    },
    { clinical: true },
  );
}

/* ---------------------------------------------------- the admission sheet */

export type AdmissionExtras = {
  reason?: string | null;
  payer?: PayerInput | null;
  /** In paise; the caller must have checked `billing.collect`. */
  depositPaise?: number | null;
  depositMethod?: 'cash' | 'upi' | 'card' | 'bank' | 'other';
};

/** A bed the patient may be put in: active, in an active ward, in their branch, free. */
async function freeBedInTx(tx: Tx, args: { bedId: string; branchId: string }) {
  const [bed] = await tx
    .select({
      id: beds.id,
      label: beds.label,
      active: beds.active,
      wardActive: wards.active,
      wardBranchId: wards.branchId,
    })
    .from(beds)
    .innerJoin(wards, eq(wards.id, beds.wardId))
    .where(eq(beds.id, args.bedId));
  if (!bed) throw new AdmissionError('Bed not found');
  if (!bed.active || !bed.wardActive) throw new AdmissionError(`Bed ${bed.label} is out of use`);
  if (bed.wardBranchId !== args.branchId) {
    throw new AdmissionError(`Bed ${bed.label} is in another branch`);
  }
  const [occupied] = await tx
    .select({ id: bedAssignments.id })
    .from(bedAssignments)
    .where(and(eq(bedAssignments.bedId, bed.id), isNull(bedAssignments.toAt)));
  if (occupied) throw new BedTakenError(bed.label);
  return bed;
}

/** Writes the payer and the deposit; returns the deposit's id, for Undo. */
async function writeExtrasInTx(
  tx: Tx,
  args: { encounter: EncounterRow; extras: AdmissionExtras; actorUserId: string },
): Promise<string | null> {
  if (args.extras.payer) {
    await setPayerInTx(tx, { encounter: args.encounter, payer: args.extras.payer, actorUserId: args.actorUserId });
  }
  if (!args.extras.depositPaise) return null;
  const deposit = await recordDepositInTx(tx, {
    encounter: args.encounter,
    amountPaise: args.extras.depositPaise,
    method: args.extras.depositMethod,
    actorUserId: args.actorUserId,
  });
  return deposit.id;
}

/**
 * Turns a bed-race unique violation, which aborts the transaction, into the
 * friendly "Bed 12 was just taken" the sheet can show.
 */
async function withBedRace<T>(bedLabel: () => Promise<string>, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (violatedConstraint(err) === 'bed_assignments_bed_occupied') throw new BedTakenError(await bedLabel());
    throw err;
  }
}

const labelOf = (hospitalId: string, bedId: string) => async () => {
  const [row] = await withTenant(hospitalId, (tx) =>
    tx.select({ label: beds.label }).from(beds).where(eq(beds.id, bedId)),
  );
  return row?.label ?? '';
};

/**
 * Confirm bed: the patient is now admitted. Writes the bed, the payer and
 * the deposit in one transaction, so the sheet either fully succeeds or
 * changes nothing.
 */
export async function assignBed(args: {
  hospitalId: string;
  admissionId: string;
  bedId: string;
  extras?: AdmissionExtras;
  actorUserId: string;
}): Promise<{ depositId: string | null }> {
  return withBedRace(labelOf(args.hospitalId, args.bedId), () =>
    withTenant(
      args.hospitalId,
      async (tx) => {
        const admission = await lockAdmissionInTx(tx, args.admissionId);
        if (!canMoveAdmission(admission.status, 'admitted')) {
          throw new AdmissionError(
            admission.status === 'cancelled'
              ? 'This admission was cancelled'
              : 'This patient already has a bed. Use Transfer to move them.',
          );
        }
        const bed = await freeBedInTx(tx, { bedId: args.bedId, branchId: admission.branchId });
        const now = new Date();
        await tx.insert(bedAssignments).values({
          hospitalId: admission.hospitalId,
          admissionId: admission.id,
          bedId: bed.id,
          fromAt: now,
          assignedByUserId: args.actorUserId,
        });
        await tx
          .update(admissions)
          .set({
            status: 'admitted',
            admittedAt: now,
            admittedByUserId: args.actorUserId,
            reason: tidyReason(args.extras?.reason) ?? admission.reason,
            updatedAt: now,
          })
          .where(eq(admissions.id, admission.id));

        const encounter = await getEncounterInTx(tx, admission.encounterId, { lock: true });
        const depositId = await writeExtrasInTx(tx, { encounter, extras: args.extras ?? {}, actorUserId: args.actorUserId });
        await audit(tx, admission, args.actorUserId, 'ipd.bed_assigned', { bedId: bed.id, bedLabel: bed.label });
        return { depositId };
      },
      { clinical: true },
    ),
  );
}

/**
 * Moves an admitted patient to another bed. The old assignment is closed and
 * the new one opened in one transaction; every entry stays on the same
 * admission, and the bed-day charge reads the history to know which ward
 * each day belongs to.
 */
export async function transferBed(args: {
  hospitalId: string;
  admissionId: string;
  bedId: string;
  actorUserId: string;
}): Promise<{ previousBedId: string | null }> {
  return withBedRace(labelOf(args.hospitalId, args.bedId), () =>
    withTenant(
      args.hospitalId,
      async (tx) => {
        const admission = await lockAdmissionInTx(tx, args.admissionId);
        if (admission.status !== 'admitted' && admission.status !== 'discharge_ready') {
          throw new AdmissionError('Only an admitted patient can be moved');
        }
        const [current] = await tx
          .select({ id: bedAssignments.id, bedId: bedAssignments.bedId })
          .from(bedAssignments)
          .where(and(eq(bedAssignments.admissionId, admission.id), isNull(bedAssignments.toAt)))
          .for('update');
        if (current?.bedId === args.bedId) throw new AdmissionError('The patient is already in this bed');
        const bed = await freeBedInTx(tx, { bedId: args.bedId, branchId: admission.branchId });

        const now = new Date();
        if (current) {
          await tx.update(bedAssignments).set({ toAt: now }).where(eq(bedAssignments.id, current.id));
        }
        await tx.insert(bedAssignments).values({
          hospitalId: admission.hospitalId,
          admissionId: admission.id,
          bedId: bed.id,
          fromAt: now,
          assignedByUserId: args.actorUserId,
        });
        await audit(tx, admission, args.actorUserId, 'ipd.bed_transferred', {
          fromBedId: current?.bedId ?? null,
          toBedId: bed.id,
          toBedLabel: bed.label,
        });
        return { previousBedId: current?.bedId ?? null };
      },
      { clinical: true },
    ),
  );
}

/**
 * An emergency admission: no OPD token, so a new encounter (origin
 * 'emergency', stage 'ipd') is opened for the patient. The patient is found
 * or registered by resolvePatientInTx exactly as a walk-in is, so a returning
 * patient keeps one record. With a bed, the patient is admitted at once; without, they join
 * Awaiting bed.
 */
export async function createDirectAdmission(args: {
  hospitalId: string;
  branchId: string;
  doctorId: string;
  patient: {
    phoneE164: string;
    name: string;
    age?: number | null;
    gender?: string | null;
    address?: string | null;
  };
  /** A record picked at the desk or a verified QID; defaults to the typed details. */
  patientInput?: PatientInput;
  bedId?: string | null;
  extras?: AdmissionExtras;
  actorUserId: string;
}): Promise<{ admissionId: string; patientName: string; depositId: string | null }> {
  const work = () =>
    withTenant(
      args.hospitalId,
      async (tx) => {
        const [branch] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, args.branchId));
        if (!branch) throw new AdmissionError('Branch not found');
        const [doctor] = await tx
          .select({ id: doctors.id, active: doctors.active })
          .from(doctors)
          .where(eq(doctors.id, args.doctorId));
        if (!doctor || !doctor.active) throw new AdmissionError('Choose a doctor');

        const name = args.patient.name.trim().replace(/\s+/g, ' ');
        if (!name) throw new AdmissionError('Enter the patient’s name');
        const patient = await resolvePatientInTx(tx, {
          hospitalId: args.hospitalId,
          input: args.patientInput ?? { kind: 'details', details: { ...args.patient, name } },
          actorUserId: args.actorUserId,
        });

        const [encounter] = await tx
          .insert(encounters)
          .values({
            hospitalId: args.hospitalId,
            branchId: branch.id,
            patientId: patient.id,
            attendingDoctorId: doctor.id,
            origin: 'emergency',
            stage: 'ipd',
            openedByUserId: args.actorUserId,
          })
          .returning();

        const now = new Date();
        const bed = args.bedId ? await freeBedInTx(tx, { bedId: args.bedId, branchId: branch.id }) : null;
        const [admission] = await tx
          .insert(admissions)
          .values({
            hospitalId: args.hospitalId,
            encounterId: encounter.id,
            patientId: patient.id,
            branchId: branch.id,
            admittingDoctorId: doctor.id,
            status: bed ? 'admitted' : 'awaiting_bed',
            reason: tidyReason(args.extras?.reason),
            requestedByUserId: args.actorUserId,
            requestedAt: now,
            admittedAt: bed ? now : null,
            admittedByUserId: bed ? args.actorUserId : null,
          })
          .returning();
        if (bed) {
          await tx.insert(bedAssignments).values({
            hospitalId: args.hospitalId,
            admissionId: admission.id,
            bedId: bed.id,
            fromAt: now,
            assignedByUserId: args.actorUserId,
          });
        }
        const depositId = await writeExtrasInTx(tx, { encounter, extras: args.extras ?? {}, actorUserId: args.actorUserId });
        await audit(tx, admission, args.actorUserId, 'ipd.admitted_direct', {
          encounterId: encounter.id,
          bedId: bed?.id ?? null,
        });
        return { admissionId: admission.id, patientName: patient.name, depositId };
      },
      { clinical: true },
    );
  return args.bedId ? withBedRace(labelOf(args.hospitalId, args.bedId), work) : work();
}

/**
 * The desk cancels a request that will not go ahead (the family took the
 * patient elsewhere). Only before a bed: once admitted, a stay ends with a
 * discharge. A queue visit returns to OPD; an emergency encounter, which
 * exists only for this admission, is cancelled with it.
 */
export async function cancelAdmission(args: {
  hospitalId: string;
  admissionId: string;
  reason: string;
  actorUserId: string;
}): Promise<void> {
  const reason = tidyReason(args.reason);
  if (!reason) throw new AdmissionError('Say why the admission is cancelled');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await lockAdmissionInTx(tx, args.admissionId);
      if (!canMoveAdmission(admission.status, 'cancelled')) {
        throw new AdmissionError('Only a patient still waiting for a bed can be cancelled');
      }
      const now = new Date();
      await tx
        .update(admissions)
        .set({ status: 'cancelled', cancelledAt: now, cancelledByUserId: args.actorUserId, cancelReason: reason, updatedAt: now })
        .where(eq(admissions.id, admission.id));

      const encounter = await getEncounterInTx(tx, admission.encounterId, { lock: true });
      if (encounter.origin === 'queue') {
        await tx.update(encounters).set({ stage: 'opd', updatedAt: now }).where(eq(encounters.id, encounter.id));
      } else if (encounter.status === 'open') {
        await tx
          .update(encounters)
          .set({ status: 'cancelled', closedAt: now, updatedAt: now })
          .where(eq(encounters.id, encounter.id));
      }
      await audit(tx, admission, args.actorUserId, 'ipd.admission_cancelled', { reason });
    },
    { clinical: true },
  );
}

/**
 * The doctor's Discharge ready, and taking it back. Billing starts from the
 * first; nothing else about the stay changes.
 */
export async function setDischargeReady(args: {
  hospitalId: string;
  admissionId: string;
  ready: boolean;
  actorUserId: string;
}): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await lockAdmissionInTx(tx, args.admissionId);
      const to: AdmissionStatus = args.ready ? 'discharge_ready' : 'admitted';
      if (admission.status === to) return;
      if (!canMoveAdmission(admission.status, to)) {
        throw new AdmissionError(
          args.ready ? 'Only an admitted patient can be marked ready to go home' : 'This patient is not marked ready',
        );
      }
      const now = new Date();
      await tx
        .update(admissions)
        .set({
          status: to,
          dischargeReadyAt: args.ready ? now : null,
          dischargeReadyByUserId: args.ready ? args.actorUserId : null,
          updatedAt: now,
        })
        .where(eq(admissions.id, admission.id));
      await audit(tx, admission, args.actorUserId, args.ready ? 'ipd.discharge_ready' : 'ipd.discharge_ready_undone');
    },
    { clinical: true },
  );
}
