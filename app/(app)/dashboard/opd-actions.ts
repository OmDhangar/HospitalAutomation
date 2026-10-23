'use server';

import { revalidatePath } from 'next/cache';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { serviceDateIn } from '@/lib/domain/time';
import {
  reopenOpdForDoctor,
  stopOpdForBranch,
  stopOpdForDoctor,
} from '@/lib/services/opd-hours';

export async function stopOpdTodayDynamic(args: {
  doctorId: string;
  scheduledAt?: string | null; // ISO; null = now
  reason?: string;
}): Promise<{ ok: true; stoppedAt: string } | { ok: false; error: string }> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'queue.mutate')) {
      return { ok: false, error: 'You do not have permission to stop OPD' };
    }

    const now = new Date();
    const serviceDate = serviceDateIn(session.timezone, now);
    const stopAt = args.scheduledAt ? new Date(args.scheduledAt) : now;

    if (isNaN(stopAt.getTime())) {
      return { ok: false, error: 'Invalid scheduled stop time' };
    }

    const res = await stopOpdForDoctor({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
      stopAt,
      actorUserId: session.userId,
      reason: args.reason?.trim() || undefined,
      now,
    });

    revalidatePath('/dashboard');
    revalidatePath('/book');
    revalidatePath(`/book?doctor=${args.doctorId}`);
    revalidatePath('/reports');

    return { ok: true, stoppedAt: res.stoppedAt.toISOString() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to stop OPD',
    };
  }
}

export async function stopAllOpdInBranchDynamic(args: {
  branchId: string;
  scheduledAt?: string | null;
  reason?: string;
}): Promise<{ ok: true; doctorCount: number } | { ok: false; error: string }> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'queue.mutate')) {
      return { ok: false, error: 'You do not have permission to stop OPD' };
    }

    const now = new Date();
    const serviceDate = serviceDateIn(session.timezone, now);
    const stopAt = args.scheduledAt ? new Date(args.scheduledAt) : now;

    if (isNaN(stopAt.getTime())) {
      return { ok: false, error: 'Invalid scheduled stop time' };
    }

    const res = await stopOpdForBranch({
      hospitalId: session.hospitalId,
      branchId: args.branchId,
      serviceDate,
      stopAt,
      actorUserId: session.userId,
      reason: args.reason?.trim() || undefined,
      now,
    });

    revalidatePath('/dashboard');
    revalidatePath('/book');
    revalidatePath('/reports');

    return { ok: true, doctorCount: res.doctorCount };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to stop branch OPD',
    };
  }
}

export async function reopenOpdDynamic(args: {
  doctorId: string;
  reason?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'opd.reopen')) {
      return { ok: false, error: 'Only owners and doctors can reopen OPD' };
    }

    const now = new Date();
    const serviceDate = serviceDateIn(session.timezone, now);

    await reopenOpdForDoctor({
      hospitalId: session.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
      actorUserId: session.userId,
      reason: args.reason?.trim() || undefined,
      now,
    });

    revalidatePath('/dashboard');
    revalidatePath('/book');
    revalidatePath(`/book?doctor=${args.doctorId}`);
    revalidatePath('/reports');

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to reopen OPD',
    };
  }
}
