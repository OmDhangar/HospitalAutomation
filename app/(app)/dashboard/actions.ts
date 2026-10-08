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
import { normalizeStaffPhone } from '@/lib/domain/phone';
import type { QueueAction } from '@/lib/domain/types';
import { canMutateQueue, logout } from '@/lib/services/auth';
import { EncounterError } from '@/lib/services/encounters';
import {
  ConsultationFeeMissingError,
  PatientBillingError,
  setConsultationPaid,
} from '@/lib/services/patient-billing';
import { notifyQueueMovement } from '@/lib/services/display-events';
import { CapacityError, addDoctorDayCapacity, releaseReservedWalkIns } from '@/lib/services/capacity';
import {
  advanceQueue,
  applyQueueAction,
  createWalkIn,
  pauseAppointment,
  resumeAppointment,
  setDoctorPaused,
  setEmergency,
  setPriority,
  startSession,
} from '@/lib/services/queue';
import { BookingError, bookSlotForWalkIn, freeSlotsForWalkIn } from '@/lib/services/web-booking';

export type FreeSlot = { datetimeIso: string; timeStr: string; label: string | null };

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

  const phoneE164 = normalizeStaffPhone(rawPhone)?.phoneE164;
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

  notifyQueueMovement(session.hospitalId, branchId);
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
  /** Issue an EXTRA token past a full quota (owner only). */
  extraToken?: boolean;
  /** Admitted through emergency. Top queue priority and red alert display. */
  isEmergency?: boolean;
}): Promise<{
  ok: boolean;
  tokenNumber?: number;
  isEmergency?: boolean;
  error?: string;
  warning?: string;
  quotaReached?: boolean;
  /** The live queue has closed for today: offer these slots instead. */
  freeSlots?: FreeSlot[];
}> {
  const tStart = performance.now();
  let hospitalId: string | null = null;
  let timezone = 'Asia/Kolkata';
  try {
    const t0 = performance.now();
    const session = await authorize();
    hospitalId = session.hospitalId;
    timezone = session.timezone;
    const tAuth = performance.now();
    const name = args.name.trim();
    const phoneE164 = normalizeStaffPhone(args.phone)?.phoneE164;

    if (!name) {
      return { ok: false, error: 'Patient name is required' };
    }
    if (!phoneE164) {
      return { ok: false, error: 'Enter a valid 10-digit mobile number, or 0000000000 for no phone' };
    }
    const address = args.address?.trim() || null;
    if (address && address.length > ADDRESS_MAX) {
      return { ok: false, error: `Address is too long (max ${ADDRESS_MAX} characters)` };
    }
    if (args.paid && !can(session.role, 'billing.collect')) {
      return { ok: false, error: 'Only reception can take payment' };
    }
    if (args.extraToken && !can(session.role, 'capacity.manage')) {
      return { ok: false, error: 'Only the owner can issue an extra token' };
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
      extraToken: args.extraToken,
      isEmergency: args.isEmergency,
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

    notifyQueueMovement(session.hospitalId, args.branchId);
    revalidatePath('/dashboard');
    const tRevalidate = performance.now();

    console.log(
      `[PERF:action:addWalkInDynamic] authorize: ${(tAuth - t0).toFixed(1)}ms | ` +
      `createWalkIn: ${(tWalkIn - tAuth).toFixed(1)}ms | ` +
      `revalidatePath: ${(tRevalidate - tWalkIn).toFixed(1)}ms | ` +
      `totalAction: ${(tRevalidate - tStart).toFixed(1)}ms`
    );

    return { ok: true, tokenNumber: appt.tokenNumber, isEmergency: Boolean(args.isEmergency), warning };
  } catch (err: unknown) {
    // After a split day's live queue closes, a walk-in takes a free evening slot.
    const queueClosed = err instanceof CapacityError && err.code === 'QUEUE_CLOSED' && hospitalId !== null;
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to add walk-in',
      // Lets the form offer the owner an extra token, and only then.
      quotaReached: err instanceof CapacityError && err.code === 'QUOTA_REACHED',
      freeSlots: queueClosed
        ? await freeSlotsForWalkIn({ hospitalId: hospitalId!, doctorId: args.doctorId, timezone }).catch(() => [])
        : undefined,
    };
  }
}

/**
 * Books a patient at the desk into a free slot and checks them in: how
 * reception adds a walk-in once a split day's live queue has closed.
 */
export async function bookSlotWalkInDynamic(args: {
  doctorId: string;
  branchId: string;
  slotDatetimeIso: string;
  name: string;
  age?: number | null;
  phone: string;
}): Promise<{ ok: true; tokenLabel: string; slotTime: string } | { ok: false; error: string }> {
  try {
    const session = await authorize();
    const name = args.name.trim();
    const phoneE164 = normalizeStaffPhone(args.phone)?.phoneE164;
    if (!name) return { ok: false, error: 'Patient name is required' };
    if (!phoneE164) return { ok: false, error: 'Enter a valid 10-digit mobile number, or 0000000000 for no phone' };

    const booked = await bookSlotForWalkIn({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      timezone: session.timezone,
      slotDatetimeIso: args.slotDatetimeIso,
      patient: { name, age: args.age ?? null, phoneE164 },
      actorUserId: session.userId,
    });
    notifyQueueMovement(session.hospitalId, args.branchId);
    revalidatePath('/dashboard');
    return { ok: true, tokenLabel: booked.tokenLabel, slotTime: booked.slotTimeFormatted };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof BookingError || err instanceof Error ? err.message : 'Could not book the slot',
    };
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
  reason?: string;
  waiveCharges?: boolean;
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
      reason: args.reason,
      waiveCharges: args.waiveCharges,
      actorUserId: session.userId,
    });

    notifyQueueMovement(session.hospitalId);
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
}): Promise<{ ok: boolean; error?: string; called?: boolean }> {
  try {
    const session = await authorize();
    const result = await advanceQueue({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      timezone: session.timezone,
      actorUserId: session.userId,
    });

    notifyQueueMovement(session.hospitalId);
    revalidatePath('/dashboard');
    return { ok: true, called: result.transitions.some((t) => t.action === 'call') };
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

    notifyQueueMovement(session.hospitalId);
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

    notifyQueueMovement(session.hospitalId);
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to set priority' };
  }
}

export async function setEmergencyDynamic(args: {
  doctorId: string;
  appointmentId: string;
  isEmergency: boolean;
}): Promise<{ ok: boolean; isEmergency?: boolean; error?: string }> {
  try {
    const session = await authorize();
    const res = await setEmergency({
      hospitalId: session.hospitalId,
      appointmentId: args.appointmentId,
      isEmergency: args.isEmergency,
      actorUserId: session.userId,
    });

    notifyQueueMovement(session.hospitalId);
    revalidatePath('/dashboard');
    return { ok: true, isEmergency: res.isEmergency };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to update emergency status' };
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

    notifyQueueMovement(session.hospitalId);
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

    notifyQueueMovement(session.hospitalId);
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

    notifyQueueMovement(session.hospitalId);
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

/** Start OPD: records when the doctor actually began. The only thing that does. */
export async function startSessionDynamic(args: {
  doctorId: string;
}): Promise<{ ok: boolean; error?: string; delayMinutes?: number }> {
  try {
    const session = await authorize();
    const result = await startSession({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      timezone: session.timezone,
      actorUserId: session.userId,
    });
    notifyQueueMovement(session.hospitalId);
    revalidatePath('/dashboard');
    return { ok: true, delayMinutes: result.delayMinutes };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to start OPD' };
  }
}

/** Owner: let online bookings use today's unused reserved walk-in capacity. */
export async function releaseReservedDynamic(args: {
  doctorId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await authorize();
    if (!can(session.role, 'capacity.manage')) return { ok: false, error: 'Only the owner can release reserved tokens' };
    await releaseReservedWalkIns({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      timezone: session.timezone,
      actorUserId: session.userId,
    });
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to release reserved tokens' };
  }
}

/** Owner/Admin: add extra appointments to today's active quota. */
export async function addExtraCapacityAction(args: {
  doctorId: string;
  count: number;
}): Promise<{ ok: boolean; previousQuota?: number; newQuota?: number; error?: string }> {
  try {
    const session = await authorize();
    if (!can(session.role, 'capacity.manage')) {
      return { ok: false, error: 'Only the hospital admin can add extra appointments' };
    }
    const result = await addDoctorDayCapacity({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      count: args.count,
      timezone: session.timezone,
      actorUserId: session.userId,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    revalidatePath('/dashboard');
    return { ok: true, previousQuota: result.previousQuota, newQuota: result.newQuota };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to add extra appointments' };
  }
}

