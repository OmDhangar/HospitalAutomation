'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { IpdNumberError } from '@/lib/domain/ipd-number';
import { LetterheadError } from '@/lib/domain/letterhead';
import { can, type Permission } from '@/lib/domain/permissions';
import { setNextIpdNumber } from '@/lib/services/ipd-number';
import { updateDoctorLetterhead, updateHospitalLetterhead } from '@/lib/services/letterhead';

/**
 * Settings → Letterhead and IPD numbers. Form posts that redirect back with a
 * message, like the rest of Settings. The letterhead is `hospital.configure`;
 * where IPD numbering continues from is `ipd.configure`. Both are the owner.
 */

const PAGE = '/settings/letterhead';

async function authorize(permission: Permission) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) throw new Error('Only the hospital owner can change the letterhead');
  await assertModule(session, 'letterhead');
  return session;
}

const back = (params: Record<string, string>): never => {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams(params).toString()}`);
};

const text = (form: FormData, key: string) => String(form.get(key) ?? '');

async function attempt(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof LetterheadError || err instanceof IpdNumberError) back({ error: err.message });
    throw err;
  }
}

export async function saveHospitalLetterheadAction(form: FormData) {
  const session = await authorize('hospital.configure');
  await attempt(() =>
    updateHospitalLetterhead({
      hospitalId: session.hospitalId,
      registrationNo: text(form, 'registrationNo'),
      phones: text(form, 'phones'),
      actorUserId: session.userId,
    }),
  );
  back({ saved: 'Letterhead saved', id: 'hospital' });
}

export async function saveDoctorLetterheadAction(form: FormData) {
  const session = await authorize('hospital.configure');
  const doctorId = text(form, 'doctorId');
  await attempt(() =>
    updateDoctorLetterhead({
      hospitalId: session.hospitalId,
      doctorId,
      qualification: text(form, 'qualification'),
      registrationNo: text(form, 'registrationNo'),
      onLetterhead: form.get('onLetterhead') === 'on',
      actorUserId: session.userId,
    }),
  );
  back({ saved: 'Doctor saved', id: doctorId });
}

export async function setNextIpdNumberAction(form: FormData) {
  const session = await authorize('ipd.configure');
  let result: { next: number; numbered: number } | undefined;
  await attempt(async () => {
    result = await setNextIpdNumber({ hospitalId: session.hospitalId, next: text(form, 'next'), actorUserId: session.userId });
  });
  // `next` is the number typed; patients already in a bed without one take the first of them.
  const { next, numbered } = result!;
  back({
    saved:
      numbered > 0
        ? `${numbered} patient${numbered === 1 ? '' : 's'} in a bed got IPD No. ${next}${numbered > 1 ? `–${next + numbered - 1}` : ''}; the next admission gets ${next + numbered}`
        : `The next IPD No. is ${next}`,
    id: 'ipd-number',
  });
}
