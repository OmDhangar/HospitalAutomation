'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { canConfigureHospital, createStaffUser, setStaffActive, type StaffRole } from '@/lib/services/auth';
import { parseRupeesToPaise } from '@/lib/domain/patient-billing';
import { can, isStaffRole } from '@/lib/domain/permissions';
import { checkCanAdd } from '@/lib/services/entitlements';
import { createBranch, createDoctor, setDoctorActive, setDoctorUser } from '@/lib/services/hospital';
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

  await setDoctorConsultationFee({
    hospitalId: session.hospitalId,
    doctorId: String(formData.get('doctorId') ?? ''),
    pricePaise,
    actorUserId: session.userId,
  });

  revalidatePath('/settings');
  revalidatePath('/dashboard');
  redirect('/settings?saved=fee');
}

/**
 * Links a doctor to the login they use. Only then can they write their own
 * patients' consultations — see lib/services/consultations.ts.
 */
export async function linkDoctorAccountAction(formData: FormData) {
  const session = await authorize();
  const userId = String(formData.get('userId') ?? '') || null;
  try {
    await setDoctorUser({
      hospitalId: session.hospitalId,
      doctorId: String(formData.get('doctorId') ?? ''),
      userId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not link that login';
    redirect(`/settings?error=link&message=${encodeURIComponent(message)}`);
  }
  revalidatePath('/settings');
  revalidatePath('/dashboard');
  redirect('/settings?saved=link');
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
  const password = String(formData.get('password') ?? '').trim() || undefined;
  const rawRole = String(formData.get('role') ?? 'receptionist');
  if (!isStaffRole(rawRole)) redirect('/settings?error=role');
  const role: StaffRole = rawRole;
  const branchId = String(formData.get('branchId') ?? '').trim() || undefined;

  if (!name || !email) redirect('/settings?error=name');

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
