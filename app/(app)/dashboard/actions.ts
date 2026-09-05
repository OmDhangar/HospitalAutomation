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

/**
 * Every action re-reads the session server-side and re-checks the role. The
 * form fields say which doctor and appointment, but never which hospital —
 * that comes from the session, so a crafted request cannot reach another
 * tenant's queue.
 */
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

  const phoneE164 = normalizeIndianPhone(rawPhone);
  if (!name || !phoneE164) {
    redirect(`/dashboard?doctor=${doctorId}&error=phone`);
  }

  await createWalkIn({
    hospitalId: session.hospitalId,
    branchId,
    doctorId,
    timezone: session.timezone,
    patient: { phoneE164, name },
    actorUserId: session.userId,
    source: 'walk_in',
  });

  backToDoctor(doctorId);
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
