'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { MedRecError, parseMedRecItem, type MedRecSource } from '@/lib/domain/medrec';
import { can, type Permission } from '@/lib/domain/permissions';
import { addMedRecItem, decideMedRecItem, prepareDischargeList, signMedRec, strikeOutMedRecItem } from '@/lib/services/medrec';

/**
 * Medication reconciliation (IPD sheets plan B2). Anyone clinical lists the
 * medicines; a doctor decides each and completes the list.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const isId = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

async function begin(form: FormData, permission: Permission) {
  const session = await requireWritableSession();
  const admissionId = text(form, 'admissionId');
  const path = `/ipd/admissions/${admissionId}/medicines`;
  if (!isId(admissionId)) redirect('/ipd');
  if (!can(session.role, permission)) redirect(`${path}?error=${encodeURIComponent('Your login cannot do this')}`);
  await assertModule(session, 'med_reconciliation', 'write');
  return { session, admissionId, path };
}

async function attempt(path: string, work: () => Promise<unknown>, saved: string, anchor = ''): Promise<never> {
  try {
    await work();
  } catch (err) {
    if (err instanceof MedRecError) redirect(`${path}?error=${encodeURIComponent(err.message)}${anchor}`);
    throw err;
  }
  revalidatePath(path);
  redirect(`${path}?saved=${encodeURIComponent(saved)}${anchor}`);
}

export async function addMedRecItemAction(form: FormData) {
  const { session, admissionId, path } = await begin(form, 'ipd.medrecRecord');
  const phase = text(form, 'phase') === 'discharge' ? 'discharge' : 'admission';
  await attempt(
    path,
    () =>
      addMedRecItem({
        hospitalId: session.hospitalId,
        admissionId,
        phase,
        input: parseMedRecItem({ name: form.get('name'), dose: form.get('dose'), frequency: form.get('frequency'), route: form.get('route'), duration: form.get('duration') }),
        source: (text(form, 'source') || 'patient') as MedRecSource,
        clientId: isId(text(form, 'clientId')) ? text(form, 'clientId') : crypto.randomUUID(),
        actorUserId: session.userId,
      }),
    'Medicine added',
    `#${phase}`,
  );
}

export async function decideMedRecItemAction(form: FormData) {
  const { session, path } = await begin(form, 'ipd.medrecDecide');
  await attempt(
    path,
    () => decideMedRecItem({ hospitalId: session.hospitalId, itemId: text(form, 'itemId'), decision: text(form, 'decision'), note: text(form, 'note') || null, actorUserId: session.userId }),
    'Decision saved',
    `#${text(form, 'phase') || 'admission'}`,
  );
}

export async function strikeOutMedRecItemAction(form: FormData) {
  const { session, path } = await begin(form, 'ipd.medrecRecord');
  await attempt(path, () => strikeOutMedRecItem({ hospitalId: session.hospitalId, itemId: text(form, 'itemId'), reason: text(form, 'reason'), actorUserId: session.userId }), 'Struck out');
}

export async function prepareDischargeAction(form: FormData) {
  const { session, admissionId, path } = await begin(form, 'ipd.medrecRecord');
  await attempt(
    path,
    () => prepareDischargeList({ hospitalId: session.hospitalId, admissionId, actorUserId: session.userId }),
    'Discharge list started from the card and home medicines',
    '#discharge',
  );
}

export async function signMedRecAction(form: FormData) {
  const { session, admissionId, path } = await begin(form, 'ipd.medrecDecide');
  const phase = text(form, 'phase') === 'discharge' ? 'discharge' : 'admission';
  await attempt(
    path,
    () => signMedRec({ hospitalId: session.hospitalId, admissionId, phase, noneAtHome: form.get('noneAtHome') === 'on', actorUserId: session.userId }),
    phase === 'admission' ? 'Admission reconciliation completed' : 'Discharge medicines completed',
    `#${phase}`,
  );
}
