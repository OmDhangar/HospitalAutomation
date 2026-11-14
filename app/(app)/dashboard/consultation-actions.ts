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
import {
  listRxGroups,
  createRxGroup,
  seedDefaultRxGroups,
  RxGroupValidationError,
  type RxGroupView,
  type CreateRxGroupItemInput,
} from '@/lib/services/rx-groups';
import { withTenant } from '@/lib/db';
import { doctors } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

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
  if (
    err instanceof ConsultationError ||
    err instanceof EncounterError ||
    err instanceof MedicineError ||
    err instanceof RxGroupValidationError
  ) {
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

/**
 * Lists institutional and personal Rx-Groups for the current doctor.
 * Seeds defaults automatically if none exist for the hospital.
 */
export async function listRxGroupsDynamic(): Promise<Result<{ groups: RxGroupView[] }>> {
  try {
    const session = await requireSession();
    if (!can(session.role, 'clinical.read')) {
      return { ok: false, error: 'You do not have permission to read clinical templates.' };
    }

    const doctorId = await withTenant(session.hospitalId, async (tx) => {
      const [doc] = await tx
        .select({ id: doctors.id })
        .from(doctors)
        .where(and(eq(doctors.hospitalId, session.hospitalId), eq(doctors.userId, session.userId)));
      return doc?.id ?? null;
    });

    let groups = await listRxGroups({
      hospitalId: session.hospitalId,
      doctorId,
    });

    if (groups.length === 0) {
      await seedDefaultRxGroups({ hospitalId: session.hospitalId });
      groups = await listRxGroups({
        hospitalId: session.hospitalId,
        doctorId,
      });
    }

    return { ok: true, groups };
  } catch (err) {
    return fail(err, 'Could not load Rx-Groups.');
  }
}

/**
 * Saves current prescription lines as a reusable Rx-Group template.
 */
export async function saveAsRxGroupDynamic(args: {
  name: string;
  description?: string;
  category?: string;
  defaultDiagnosis?: string;
  defaultAdvice?: string;
  defaultFollowUpDays?: number;
  items: CreateRxGroupItemInput[];
  isPersonal?: boolean;
}): Promise<Result<{ group: RxGroupView }>> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'clinical.write')) {
      return { ok: false, error: 'Only doctors or owners can create prescription templates.' };
    }

    let doctorId: string | null = null;
    if (args.isPersonal !== false) {
      doctorId = await withTenant(session.hospitalId, async (tx) => {
        const [doc] = await tx
          .select({ id: doctors.id })
          .from(doctors)
          .where(and(eq(doctors.hospitalId, session.hospitalId), eq(doctors.userId, session.userId)));
        return doc?.id ?? null;
      });
    }

    const group = await createRxGroup({
      hospitalId: session.hospitalId,
      doctorId,
      name: args.name,
      description: args.description,
      category: args.category,
      defaultDiagnosis: args.defaultDiagnosis,
      defaultAdvice: args.defaultAdvice,
      defaultFollowUpDays: args.defaultFollowUpDays,
      items: args.items,
    });

    return { ok: true, group };
  } catch (err) {
    return fail(err, 'Could not save Rx-Group.');
  }
}
