'use server';

import { requireSession, requireWritableSession } from '@/lib/auth/session';
import type { ConsultationDraft, DraftLine } from '@/lib/domain/consultation';
import { can } from '@/lib/domain/permissions';
import {
  ConsultationError,
  DraftConflictError,
  getPatientHistory,
  lastPrescriptionForRepeat,
  openConsultation,
  saveConsultation,
  saveDraft,
  type ConsultationView,
  type HistoryVisit,
} from '@/lib/services/consultations';
import { EncounterError } from '@/lib/services/encounters';
import { MedicineError, quickAddMedicine, type MedicineOption } from '@/lib/services/medicines';

/**
 * The consultation panel's server actions.
 *
 * Thin by design: authenticate, hand the session's identity to the service,
 * translate known errors into a message the doctor can act on. Who may do what
 * is decided in lib/domain/permissions.ts and enforced in the service; the
 * clinical tables themselves refuse anything without clinical access.
 *
 * None of these revalidate the dashboard. The panel holds its own state, and a
 * re-render on every autosave would fight the doctor's typing.
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: string; conflict?: boolean };

const fail = (err: unknown, fallback: string): { ok: false; error: string; conflict?: boolean } => {
  if (err instanceof DraftConflictError) return { ok: false, error: err.message, conflict: true };
  if (err instanceof ConsultationError || err instanceof EncounterError || err instanceof MedicineError) {
    return { ok: false, error: err.message };
  }
  console.error(`[consultation] ${fallback}`, err);
  return { ok: false, error: fallback };
};

export async function openConsultationDynamic(args: {
  appointmentId: string;
}): Promise<Result<{ view: ConsultationView }>> {
  try {
    // Writable: opening a visit for the first time creates its encounter.
    const session = await requireWritableSession();
    const view = await openConsultation({
      hospitalId: session.hospitalId,
      appointmentId: args.appointmentId,
      actor: { userId: session.userId, role: session.role },
    });
    return { ok: true, view };
  } catch (err) {
    return fail(err, 'Could not open the consultation. Try again.');
  }
}

export async function saveConsultationDraftDynamic(args: {
  encounterId: string;
  content: ConsultationDraft;
  expectedVersion: number | null;
}): Promise<Result<{ version: number }>> {
  try {
    const session = await requireWritableSession();
    const { version } = await saveDraft({
      hospitalId: session.hospitalId,
      encounterId: args.encounterId,
      content: args.content,
      expectedVersion: args.expectedVersion,
      actor: { userId: session.userId, role: session.role },
    });
    return { ok: true, version };
  } catch (err) {
    return fail(err, 'Draft not saved.');
  }
}

export async function saveConsultationDynamic(args: {
  encounterId: string;
  input: {
    diagnosis: string;
    notes: string;
    items: Omit<DraftLine, 'medicineLabel'>[];
    advice: string;
    followUpOn: string | null;
  };
}): Promise<Result<{ prescriptionId: string | null }>> {
  try {
    const session = await requireWritableSession();
    const { prescriptionId } = await saveConsultation({
      hospitalId: session.hospitalId,
      encounterId: args.encounterId,
      input: args.input,
      actor: { userId: session.userId, role: session.role },
    });
    return { ok: true, prescriptionId };
  } catch (err) {
    return fail(err, 'Consultation not saved. Try again.');
  }
}

export async function repeatLastPrescriptionDynamic(args: {
  encounterId: string;
}): Promise<
  Result<{ last: { items: DraftLine[]; skipped: string[]; fromDate: string; doctorName: string } | null }>
> {
  try {
    const session = await requireSession();
    const last = await lastPrescriptionForRepeat({
      hospitalId: session.hospitalId,
      encounterId: args.encounterId,
      actor: { userId: session.userId, role: session.role },
    });
    return { ok: true, last };
  } catch (err) {
    return fail(err, 'Could not load the last prescription.');
  }
}

export async function patientHistoryDynamic(args: {
  encounterId: string;
}): Promise<Result<{ visits: HistoryVisit[] }>> {
  try {
    const session = await requireSession();
    const visits = await getPatientHistory({
      hospitalId: session.hospitalId,
      encounterId: args.encounterId,
      actor: { userId: session.userId, role: session.role },
    });
    return { ok: true, visits };
  } catch (err) {
    return fail(err, 'Could not load earlier visits.');
  }
}

/** "Not in the list? Add it" — unpriced, for the owner to price later. */
export async function quickAddMedicineDynamic(args: {
  name: string;
  strength: string;
  form: string;
}): Promise<Result<{ medicine: MedicineOption }>> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'medicines.quickAdd')) {
      return { ok: false, error: 'Only a doctor or the owner can add a medicine' };
    }
    const medicine = await quickAddMedicine({
      hospitalId: session.hospitalId,
      name: args.name,
      strength: args.strength || null,
      form: args.form || null,
      actorUserId: session.userId,
    });
    return { ok: true, medicine };
  } catch (err) {
    return fail(err, 'Could not add the medicine.');
  }
}
