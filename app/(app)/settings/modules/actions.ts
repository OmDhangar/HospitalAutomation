'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { ModuleConfigError, setModuleState } from '@/lib/services/modules';

/** Settings → Modules: the owner switches a module on, read-only or off, and picks its wards (ADR-021). */

const PAGE = '/settings/modules';

export async function setModuleStateAction(form: FormData) {
  const session = await requireWritableSession();
  if (!can(session.role, 'hospital.configure')) throw new Error('Only the hospital owner can change modules');

  const moduleId = String(form.get('moduleId') ?? '');
  const wardIds = form.getAll('wardIds').map(String).filter(Boolean);
  const allWards = form.get('scope') !== 'wards';
  try {
    await setModuleState({
      hospitalId: session.hospitalId,
      moduleId,
      state: String(form.get('state') ?? ''),
      stage: form.get('stage') ? String(form.get('stage')) : undefined,
      rolloutScope: allWards ? { all: true } : { all: false, wardIds },
      actorUserId: session.userId,
    });
  } catch (err) {
    if (err instanceof ModuleConfigError) {
      revalidatePath(PAGE);
      redirect(`${PAGE}?${new URLSearchParams({ error: err.message })}`);
    }
    throw err;
  }
  revalidatePath(PAGE);
  revalidatePath('/ipd', 'layout');
  redirect(`${PAGE}?${new URLSearchParams({ saved: 'Module saved', id: moduleId })}`);
}
