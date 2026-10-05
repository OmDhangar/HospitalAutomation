'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import {
  canConfigureHospital,
  createStaffUser,
  setStaffActive,
  StaffAccountError,
  type StaffRole,
} from '@/lib/services/auth';
import { parseRupeesToPaise } from '@/lib/domain/patient-billing';
import { can, isStaffRole } from '@/lib/domain/permissions';
import { checkCanAdd } from '@/lib/services/entitlements';
import { saveDoctorCapacity } from '@/lib/services/capacity';
import {
  clearDoctorCache,
  createBranch,
  createDoctor,
  setDoctorActive,
  setDoctorUser,
} from '@/lib/services/hospital';
import { setDoctorConsultationFee } from '@/lib/services/patient-billing';

async function authorize() {
  const session = await requireWritableSession();
  if (!canConfigureHospital(session.role)) {
    throw new Error('Only a hospital owner can change configuration');
  }
  return session;
}

export async function addBranchAction(formData: FormData) {
  const session = await authorize();
  const name = String(formData.get('name') ?? '').trim();
  if (!name) redirect('/settings?error=name');

  const check = await checkCanAdd({ hospitalId: session.hospitalId, kind: 'branches' });
  if (!check.allowed) redirect('/settings?limit=branches');

  await createBranch({
    hospitalId: session.hospitalId,
    name,
    address: String(formData.get('address') ?? '').trim() || undefined,
  });

  revalidatePath('/settings');
  redirect('/settings');
}

export async function addDoctorAction(formData: FormData) {
  const session = await authorize();
  const name = String(formData.get('name') ?? '').trim();
  const branchId = String(formData.get('branchId') ?? '');
  if (!name || !branchId) redirect('/settings?error=name');

  const minutes = Number(formData.get('defaultConsultMinutes') ?? 10);
  const rawMode = String(formData.get('mode') ?? 'both');
  const mode = rawMode === 'slot' ? 'slot' : rawMode === 'queue' ? 'queue' : 'both';

  /**
   * Checked before the write, and surfaced as a redirect rather than a thrown
   * error, because the page already reports validation this way and a limit is
   * a normal answer rather than a fault. The service enforces it as well — this
   * is only what turns it into a sentence somebody can act on.
   */
  const check = await checkCanAdd({ hospitalId: session.hospitalId, kind: 'doctors' });
  if (!check.allowed) redirect('/settings?limit=doctors');

  await createDoctor({
    hospitalId: session.hospitalId,
    branchId,
    name,
    specialty: String(formData.get('specialty') ?? '').trim() || undefined,
    // Seeds the ETA until real consultations accumulate.
    defaultConsultMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 10,
    mode,
  });

  revalidatePath('/settings');
  redirect('/settings');
}

/**
 * A doctor's consultation fee. Changing it never touches a bill already
 * issued: every bill line carries the price it was charged at.
 */
export async function setConsultationFeeAction(formData: FormData) {
  const session = await authorize();
  if (!can(session.role, 'billing.price')) redirect('/settings?error=fee');

  const pricePaise = parseRupeesToPaise(String(formData.get('fee') ?? ''));
  if (pricePaise === null) redirect('/settings?error=fee');

  const doctorId = String(formData.get('doctorId') ?? '');
  await setDoctorConsultationFee({
    hospitalId: session.hospitalId,
    doctorId,
    pricePaise,
    actorUserId: session.userId,
  });

  revalidatePath('/settings');
  revalidatePath('/dashboard');
  // The id tells the page which doctor's form to mark saved.
  redirect(`/settings?saved=fee&id=${encodeURIComponent(doctorId)}`);
}

/**
 * Links a doctor to the login they use. Only then can they write their own
 * patients' consultations — see lib/services/consultations.ts.
 */
export async function linkDoctorAccountAction(formData: FormData) {
  const session = await authorize();
  const userId = String(formData.get('userId') ?? '') || null;
  const doctorId = String(formData.get('doctorId') ?? '');
  try {
    await setDoctorUser({
      hospitalId: session.hospitalId,
      doctorId,
      userId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not link that login';
    redirect(`/settings?error=link&message=${encodeURIComponent(message)}`);
  }
  clearDoctorCache();
  revalidatePath('/settings');
  revalidatePath('/dashboard');
  redirect(`/settings?saved=link&id=${encodeURIComponent(doctorId)}`);
}

export async function toggleDoctorAction(formData: FormData) {
  const session = await authorize();

  await setDoctorActive({
    hospitalId: session.hospitalId,
    doctorId: String(formData.get('doctorId') ?? ''),
    active: String(formData.get('active') ?? '') === 'true',
  });

  revalidatePath('/settings');
  redirect('/settings');
}

export async function addStaffAction(formData: FormData) {
  const session = await authorize();
  const name = String(formData.get('name') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim();
  // Required: the account is otherwise unusable, since there is no default.
  const password = String(formData.get('password') ?? '').trim();
  const rawRole = String(formData.get('role') ?? 'receptionist');
  if (!isStaffRole(rawRole)) redirect('/settings?error=role');
  const role: StaffRole = rawRole;
  const branchId = String(formData.get('branchId') ?? '').trim() || undefined;

  if (!name || !email) redirect('/settings?error=name');
  if (!password) redirect('/settings?error=weak_password');

  const check = await checkCanAdd({ hospitalId: session.hospitalId, kind: 'staff' });
  if (!check.allowed) redirect('/settings?limit=staff');

  try {
    await createStaffUser({
      hospitalId: session.hospitalId,
      name,
      email,
      password,
      role,
      branchId,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'PlanLimitError') {
      redirect('/settings?limit=staff');
    }
    if (err instanceof StaffAccountError) {
      redirect(`/settings?error=${err.code === 'EMAIL_IN_USE' ? 'email_in_use' : 'weak_password'}`);
    }
    throw err;
  }

  revalidatePath('/settings');
  redirect('/settings');
}

export async function toggleStaffAction(formData: FormData) {
  const session = await authorize();
  const membershipId = String(formData.get('membershipId') ?? '');
  const active = String(formData.get('active') ?? '') === 'true';

  await setStaffActive({
    hospitalId: session.hospitalId,
    membershipId,
    active,
  });

  revalidatePath('/settings');
  redirect('/settings');
}

/** A blank field means "not set"; anything else must be a whole number. */
const optionalInt = (value: FormDataEntryValue | null): number | null | 'invalid' => {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isInteger(n) ? n : 'invalid';
};

/**
 * A doctor's daily token quota and walk-in reservation. Takes effect from the
 * next day that has not issued a token; today's queue keeps its numbers.
 * A quota above the plan is allowed while hospitals are on trial — it is
 * flagged, not refused.
 */
export async function setDoctorCapacityAction(formData: FormData) {
  const session = await authorize();
  const doctorId = String(formData.get('doctorId') ?? '');

  const quota = optionalInt(formData.get('dailyQuota'));
  const reserved = optionalInt(formData.get('walkInReserved'));
  const opens = optionalInt(formData.get('onlineOpensMinutesBefore'));
  const release = optionalInt(formData.get('walkInReleaseMinutes'));
  if ([quota, reserved, opens, release].includes('invalid')) {
    redirect(`/settings?error=capacity&message=${encodeURIComponent('Use whole numbers only.')}`);
  }

  const result = await saveDoctorCapacity({
    hospitalId: session.hospitalId,
    doctorId,
    actorUserId: session.userId,
    config: {
      dailyQuota: quota as number | null,
      walkInReserved: (reserved as number | null) ?? 0,
      onlineOpensMinutesBefore: (opens as number | null) ?? 120,
      walkInReleaseMinutes: release as number | null,
    },
  });

  if (!result.ok) {
    redirect(`/settings?error=capacity&message=${encodeURIComponent(result.errors.join(' '))}`);
  }

  clearDoctorCache();
  revalidatePath('/settings');
  revalidatePath('/dashboard');
  redirect(
    result.abovePlan
      ? `/settings?saved=capacity_above_plan&plan=${result.planDailyCapacity ?? ''}&id=${encodeURIComponent(doctorId)}`
      : `/settings?saved=capacity&id=${encodeURIComponent(doctorId)}`,
  );
}
