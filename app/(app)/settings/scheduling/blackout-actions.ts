'use server';

import { revalidatePath } from 'next/cache';
import { requireSession, requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import {
  previewBlackoutDisruption,
  createBlackoutPeriodAndNotify,
  cancelBlackoutPeriod,
  listBlackoutPeriods,
  type BlackoutDisruptionPreview,
  type BlackoutPeriodItem,
} from '@/lib/services/blackout';

async function authorize() {
  const session = await requireWritableSession();
  if (!can(session.role, 'hospital.configure')) {
    throw new Error('Only hospital administrators can configure blackout periods');
  }
  return session;
}

export async function previewBlackoutAction(payload: {
  branchId?: string | null;
  doctorId?: string | null;
  startDate: string;
  endDate: string;
}): Promise<{ ok: boolean; data?: BlackoutDisruptionPreview; error?: string }> {
  try {
    const session = await authorize();
    const data = await previewBlackoutDisruption({
      hospitalId: session.hospitalId,
      branchId: payload.branchId,
      doctorId: payload.doctorId,
      startDate: payload.startDate,
      endDate: payload.endDate,
      timezone: session.timezone,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function createBlackoutAction(payload: {
  branchId?: string | null;
  doctorId?: string | null;
  startDate: string;
  endDate: string;
  reopenDate: string;
  reason: string;
  publicReason?: string | null;
}): Promise<{
  ok: boolean;
  result?: { blackoutId: string; cancelledCount: number; notifiedCount: number };
  error?: string;
}> {
  try {
    const session = await authorize();
    const result = await createBlackoutPeriodAndNotify({
      hospitalId: session.hospitalId,
      branchId: payload.branchId,
      doctorId: payload.doctorId,
      startDate: payload.startDate,
      endDate: payload.endDate,
      reopenDate: payload.reopenDate,
      reason: payload.reason,
      publicReason: payload.publicReason,
      actorUserId: session.userId,
      timezone: session.timezone,
    });
    revalidatePath('/settings');
    revalidatePath('/dashboard');
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function revokeBlackoutAction(payload: {
  blackoutId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const session = await authorize();
    await cancelBlackoutPeriod({
      hospitalId: session.hospitalId,
      blackoutId: payload.blackoutId,
      actorUserId: session.userId,
    });
    revalidatePath('/settings');
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listBlackoutPeriodsAction(payload?: {
  branchId?: string | null;
  doctorId?: string | null;
}): Promise<{ ok: boolean; data?: BlackoutPeriodItem[]; error?: string }> {
  try {
    const session = await requireSession();
    if (!can(session.role, 'hospital.configure')) {
      throw new Error('Unauthorized');
    }
    const data = await listBlackoutPeriods({
      hospitalId: session.hospitalId,
      branchId: payload?.branchId,
      doctorId: payload?.doctorId,
    });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
