'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { clearSessionCookie, readSessionCookie, requireSession } from '@/lib/auth/session';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import type { QueueAction } from '@/lib/domain/types';
import { canMutateQueue, logout } from '@/lib/services/auth';
import {
  advanceQueue,
  applyQueueAction,
  createWalkIn,
  setDoctorPaused,
  setPriority,
} from '@/lib/services/queue';

async function authorize() {
  const session = await requireSession();
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

export async function addWalkInDynamic(args: {
  doctorId: string;
  branchId: string;
  name: string;
  age?: number | null;
  phone: string;
  whatsappOptIn: boolean;
}): Promise<{ ok: boolean; tokenNumber?: number; error?: string }> {
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

    const appt = await createWalkIn({
      hospitalId: session.hospitalId,
      branchId: args.branchId,
      doctorId: args.doctorId,
      timezone: session.timezone,
      patient: {
        phoneE164,
        name,
        age: args.age,
      },
      actorUserId: session.userId,
      source: 'walk_in',
      whatsappOptIn: args.whatsappOptIn,
    });
    const tWalkIn = performance.now();

    revalidatePath('/dashboard');
    const tRevalidate = performance.now();

    console.log(
      `[PERF:action:addWalkInDynamic] authorize: ${(tAuth - t0).toFixed(1)}ms | ` +
      `createWalkIn: ${(tWalkIn - tAuth).toFixed(1)}ms | ` +
      `revalidatePath: ${(tRevalidate - tWalkIn).toFixed(1)}ms | ` +
      `totalAction: ${(tRevalidate - tStart).toFixed(1)}ms`
    );

    return { ok: true, tokenNumber: appt.tokenNumber };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to add walk-in' };
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
