'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  DEMO_REQUEST_STATUSES,
  setDemoRequestStatus,
  type DemoRequestStatus,
} from '@/lib/services/demo-requests';

export async function updateLeadAction(formData: FormData) {
  await requirePlatformAdmin();

  const id = String(formData.get('id') ?? '').trim();
  const raw = String(formData.get('status') ?? '').trim();
  const status = DEMO_REQUEST_STATUSES.find((value) => value === raw) as
    | DemoRequestStatus
    | undefined;

  if (!id || !status) redirect('/admin/leads?error=INVALID_INPUT');

  await setDemoRequestStatus({
    id,
    status,
    // Only written when the field was submitted, so moving a lead along does
    // not silently blank a note somebody left on it.
    notes: formData.has('notes') ? String(formData.get('notes') ?? '') : undefined,
  });

  revalidatePath('/admin/leads');
  redirect('/admin/leads?done=1');
}
