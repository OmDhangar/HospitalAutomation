'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { canConfigureHospital } from '@/lib/services/auth';
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
