'use server';

import { revalidatePath } from 'next/cache';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { AdmissionError, shiftToIpd, undoShiftToIpd } from '@/lib/services/admissions';
import { notifyQueueMovement } from '@/lib/services/display-events';
import { EncounterError } from '@/lib/services/encounters';
import { applyQueueAction } from '@/lib/services/queue';

/**
 * Shift to IPD from the OPD dashboard (IPD plan §5.1, task T1.4).
 *
 * One click, no form. The admission is created first, in its own clinical
 * transaction; then, if the token is still being served, the OPD visit is
 * completed through the queue's own applyQueueAction, so the queue state
 * machine and its events are never bypassed. If that second step fails the
 * admission still stands — the patient is on Awaiting bed either way, and the
 * token can be completed by hand.
 */

export type ShiftToIpdResult =
  | { ok: true; admissionId: string; patientName: string; created: boolean }
  | { ok: false; error: string };

export async function shiftToIpdDynamic(args: { appointmentId: string }): Promise<ShiftToIpdResult> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'ipd.shift')) return { ok: false, error: 'Only a doctor can shift a patient to IPD' };

    const result = await shiftToIpd({
      hospitalId: session.hospitalId,
      appointmentId: args.appointmentId,
      actorUserId: session.userId,
    });

    if (result.appointmentStatus === 'CALLED' || result.appointmentStatus === 'IN_CONSULTATION') {
      try {
        await applyQueueAction({
          hospitalId: session.hospitalId,
          appointmentId: args.appointmentId,
          action: 'complete',
          timezone: session.timezone,
          actorUserId: session.userId,
        });
      } catch (err) {
        console.warn('[ipd:shift] admission created but the OPD token was not completed', err);
      }
    }

    notifyQueueMovement(session.hospitalId);
    revalidatePath('/dashboard');
    revalidatePath('/ipd');
    return { ok: true, admissionId: result.admissionId, patientName: result.patientName, created: result.created };
  } catch (err) {
    if (err instanceof AdmissionError || err instanceof EncounterError) return { ok: false, error: err.message };
    return { ok: false, error: 'Could not shift the patient to IPD. Try again.' };
  }
}

export async function undoShiftToIpdDynamic(args: {
  admissionId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'ipd.shift')) return { ok: false, error: 'Only a doctor can undo this' };
    await undoShiftToIpd({
      hospitalId: session.hospitalId,
      admissionId: args.admissionId,
      actorUserId: session.userId,
    });
    revalidatePath('/dashboard');
    revalidatePath('/ipd');
    return { ok: true };
  } catch (err) {
    if (err instanceof AdmissionError) return { ok: false, error: err.message };
    return { ok: false, error: 'Could not undo. Try again.' };
  }
}
