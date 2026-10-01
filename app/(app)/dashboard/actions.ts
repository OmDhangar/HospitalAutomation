'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  clearSessionCookie,
  readSessionCookie,
  requireSession,
  requireWritableSession,
} from '@/lib/auth/session';
import { parseRupeesToPaise, type PaymentStatus } from '@/lib/domain/patient-billing';
import { can } from '@/lib/domain/permissions';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import type { QueueAction } from '@/lib/domain/types';
import { canMutateQueue, logout } from '@/lib/services/auth';
import { EncounterError } from '@/lib/services/encounters';
import {
  ConsultationFeeMissingError,
  PatientBillingError,
  setConsultationPaid,
} from '@/lib/services/patient-billing';
import {
  advanceQueue,
  applyQueueAction,
  createWalkIn,
  pauseAppointment,
  resumeAppointment,
  setDoctorPaused,
  setPriority,
} from '@/lib/services/queue';

async function authorize() {
  // Writable, not merely signed in: a read-only support session must not move
  // another hospital's queue.
  const session = await requireWritableSession();
  if (!canMutateQueue(session.role)) throw new Error('Not allowed to change the queue');
  return session;
}

const backToDoctor = (doctorId: string) => {
  revalidatePath('/dashboard');
  redirect(`/dashboard?doctor=${doctorId}`);
};

export async function addWalkInAction(formData: FormData) {
  const session = await authorize();

  const doctorId = String(formData.get('doctorId') ?? '');
  const branchId = String(formData.get('branchId') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const rawPhone = String(formData.get('phone') ?? '');
  const rawAge = formData.get('age');
  const age = rawAge ? parseInt(String(rawAge), 10) : undefined;

  const phoneE164 = normalizeIndianPhone(rawPhone);
  if (!name || !phoneE164) {
    redirect(`/dashboard?doctor=${doctorId}&error=phone`);
  }

  await createWalkIn({
    hospitalId: session.hospitalId,
    branchId,
    doctorId,
    timezone: session.timezone,
    patient: {
      phoneE164,
      name,
      age: !isNaN(age as number) ? age : null,
    },
    actorUserId: session.userId,
    source: 'walk_in',
    whatsappOptIn: formData.get('whatsappOptIn') === 'yes',
  });

  backToDoctor(doctorId);
}

const ADDRESS_MAX = 500;

export async function addWalkInDynamic(args: {
  doctorId: string;
  branchId: string;
  name: string;
  age?: number | null;
  phone: string;
  address?: string;
  whatsappOptIn: boolean;
  /** Paid at the desk on arrival. Charges the doctor's consultation fee. */
  paid?: boolean;
}): Promise<{ ok: boolean; tokenNumber?: number; error?: string; warning?: string }> {
  const tStart = performance.now();
  try {
    const t0 = performance.now();
    const session = await authorize();
    const tAuth = performance.now();
    const name = args.name.trim();
    const phoneE164 = normalizeIndianPhone(args.phone);

    if (!name) {
      return { ok: false, error: 'Patient name is required' };
    }
    if (!phoneE164) {
      return { ok: false, error: 'Enter a valid 10-digit mobile number' };
    }
    const address = args.address?.trim() || null;
    if (address && address.length > ADDRESS_MAX) {
      return { ok: false, error: `Address is too long (max ${ADDRESS_MAX} characters)` };
    }
    if (args.paid && !can(session.role, 'billing.collect')) {
      return { ok: false, error: 'Only reception can take payment' };
    }

    const appt = await createWalkIn({
      hospitalId: session.hospitalId,
      branchId: args.branchId,
      doctorId: args.doctorId,
      timezone: session.timezone,
      patient: {
        phoneE164,
        name,
        age: args.age,
        address,
      },
      actorUserId: session.userId,
      source: 'walk_in',
      whatsappOptIn: args.whatsappOptIn,
    });
    const tWalkIn = performance.now();

    /**
     * A separate transaction, after the token exists. If charging fails the
     * patient must still be in the queue — a missing fee is a desk problem,
     * not a reason to turn someone away — so the failure becomes a warning.
     */
    let warning: string | undefined;
    if (args.paid) {
      try {
        await setConsultationPaid({
          hospitalId: session.hospitalId,
          appointmentId: appt.appointment.id,
          paid: true,
          actorUserId: session.userId,
        });
      } catch (err) {
        warning =
          err instanceof ConsultationFeeMissingError
            ? `Token issued, but not marked paid: ${err.message}.`
            : 'Token issued, but it could not be marked paid. Use the Paid button on the queue.';
      }
    }

    revalidatePath('/dashboard');
    const tRevalidate = performance.now();

    console.log(
      `[PERF:action:addWalkInDynamic] authorize: ${(tAuth - t0).toFixed(1)}ms | ` +
      `createWalkIn: ${(tWalkIn - tAuth).toFixed(1)}ms | ` +
      `revalidatePath: ${(tRevalidate - tWalkIn).toFixed(1)}ms | ` +
      `totalAction: ${(tRevalidate - tStart).toFixed(1)}ms`
    );

    return { ok: true, tokenNumber: appt.tokenNumber, warning };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to add walk-in' };
  }
}

export type TogglePaidResult =
  | { ok: true; status: PaymentStatus }
  | { ok: false; error: string; code?: 'fee_missing' };

/**
 * The one-tap Paid / Unpaid pill.
 *
 * `feeRupees` is only for the first tap on a doctor with no fee set, and only
 * an owner may send it: whoever takes the money should not also set the price.
 * The amount charged is always read from the hospital's fee on the server.
 */
export async function togglePaidDynamic(args: {
  appointmentId: string;
  paid: boolean;
  feeRupees?: string;
}): Promise<TogglePaidResult> {
  try {
    const session = await authorize();
    if (!can(session.role, 'billing.collect')) {
      return { ok: false, error: 'Only reception can take payment' };
    }

    let setFeePaise: number | undefined;
    if (args.feeRupees !== undefined) {
      if (!can(session.role, 'billing.price')) {
        return { ok: false, error: 'Only the hospital owner can set a fee' };
      }
      const parsed = parseRupeesToPaise(args.feeRupees);
      if (parsed === null) return { ok: false, error: 'Enter the fee in rupees, like 300' };
      setFeePaise = parsed;
    }

    const settlement = await setConsultationPaid({
      hospitalId: session.hospitalId,
      appointmentId: args.appointmentId,
      paid: args.paid,
      setFeePaise,
      actorUserId: session.userId,
    });

    revalidatePath('/dashboard');
    return { ok: true, status: settlement.status };
  } catch (err: unknown) {
    if (err instanceof ConsultationFeeMissingError) {
      return { ok: false, error: err.message, code: 'fee_missing' };
    }
    if (err instanceof PatientBillingError || err instanceof EncounterError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'Could not update payment. Try again.' };
  }
}

export async function advanceQueueDynamic(args: {
  doctorId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await authorize();
    await advanceQueue({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      timezone: session.timezone,
      actorUserId: session.userId,
    });

    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to advance queue' };
  }
}

export async function queueActionDynamic(args: {
  doctorId: string;
  appointmentId: string;
  action: QueueAction;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await authorize();
    await applyQueueAction({
      hospitalId: session.hospitalId,
      appointmentId: args.appointmentId,
      action: args.action,
      timezone: session.timezone,
      actorUserId: session.userId,
    });

    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to perform queue action' };
  }
}

export async function setPriorityDynamic(args: {
  doctorId: string;
  appointmentId: string;
  priority: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await authorize();
    await setPriority({
      hospitalId: session.hospitalId,
      appointmentId: args.appointmentId,
      priority: args.priority,
      actorUserId: session.userId,
    });

    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to set priority' };
  }
}

export async function togglePauseDynamic(args: {
  doctorId: string;
  paused: boolean;
  reason?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await authorize();
    await setDoctorPaused({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      timezone: session.timezone,
      paused: args.paused,
      reason: args.reason || null,
    });

    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to toggle pause status' };
  }
}

export async function pauseAppointmentDynamic(args: {
  doctorId: string;
  appointmentId: string;
  resumeAfterMinutes?: number | null;
  reason?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await authorize();
    const result = await pauseAppointment({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      appointmentId: args.appointmentId,
      timezone: session.timezone,
      resumeAfterMinutes: args.resumeAfterMinutes,
      reason: args.reason,
      actorUserId: session.userId,
    });

    if (result.outcome !== 'paused') {
      return { ok: false, error: `Cannot pause appointment in status: ${result.currentStatus}` };
    }

    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to pause patient' };
  }
}

export async function resumeAppointmentDynamic(args: {
  doctorId: string;
  appointmentId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await authorize();
    const result = await resumeAppointment({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      appointmentId: args.appointmentId,
      timezone: session.timezone,
      actorUserId: session.userId,
    });

    if (result.outcome !== 'resumed') {
      return {
        ok: false,
        error:
          result.outcome === 'not_found'
            ? 'Appointment not found'
            : `Cannot resume appointment in status: ${result.currentStatus}`,
      };
    }

    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to resume patient' };
  }
}

export async function advanceQueueAction(formData: FormData) {
  const session = await authorize();
  const doctorId = String(formData.get('doctorId') ?? '');

  await advanceQueue({
    hospitalId: session.hospitalId,
    doctorId,
    timezone: session.timezone,
    actorUserId: session.userId,
  });

  backToDoctor(doctorId);
}

export async function queueActionForm(formData: FormData) {
  const session = await authorize();

  const doctorId = String(formData.get('doctorId') ?? '');
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const action = String(formData.get('action') ?? '') as QueueAction;

  await applyQueueAction({
    hospitalId: session.hospitalId,
    appointmentId,
    action,
    timezone: session.timezone,
    actorUserId: session.userId,
  });

  backToDoctor(doctorId);
}

export async function prioritiseAction(formData: FormData) {
  const session = await authorize();

  const doctorId = String(formData.get('doctorId') ?? '');
  const appointmentId = String(formData.get('appointmentId') ?? '');
  const priority = Number(formData.get('priority') ?? 0);

  await setPriority({
    hospitalId: session.hospitalId,
    appointmentId,
    priority,
    actorUserId: session.userId,
  });

  backToDoctor(doctorId);
}

export async function togglePauseAction(formData: FormData) {
  const session = await authorize();

  const doctorId = String(formData.get('doctorId') ?? '');
  const paused = String(formData.get('paused') ?? '') === 'true';
  const reason = String(formData.get('reason') ?? '').trim();

  await setDoctorPaused({
    hospitalId: session.hospitalId,
    doctorId,
    timezone: session.timezone,
    paused,
    reason: reason || null,
  });

  backToDoctor(doctorId);
}

export async function signOutAction() {
  await logout(await readSessionCookie());
  await clearSessionCookie();
  redirect('/login');
}
