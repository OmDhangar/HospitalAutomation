'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { canConfigureHospital } from '@/lib/services/auth';
import { checkCanAdd } from '@/lib/services/entitlements';
import { createBranch, createDoctor, setDoctorActive } from '@/lib/services/hospital';

async function authorize() {
  const session = await requireSession();
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
