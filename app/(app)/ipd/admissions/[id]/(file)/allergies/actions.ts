'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { AllergyError, parseAllergy } from '@/lib/domain/allergy';
import { can } from '@/lib/domain/permissions';
import { AllergyError as ServiceAllergyError, recordAllergy, reviewAllergies, strikeOutAllergy } from '@/lib/services/allergy';
import { getAdmissionSummary } from '@/lib/services/ipd-census';

/**
 * Allergies (IPD sheets plan B2): record, strike out, and "asked: none known"
 * or "could not ask". Clinical staff; the module must be on.
 */

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

async function begin(form: FormData) {
  const session = await requireWritableSession();
  const admissionId = text(form, 'admissionId');
  const path = `/ipd/admissions/${admissionId}/allergies`;
  if (!can(session.role, 'ipd.allergy')) redirect(`${path}?error=${encodeURIComponent('Your login cannot record allergies')}`);
  await assertModule(session, 'allergy', 'write');
  const admission = await getAdmissionSummary(session.hospitalId, admissionId);
  if (!admission) redirect('/ipd');
  return { session, admission, path };
}

async function attempt(path: string, work: () => Promise<unknown>, saved: string): Promise<never> {
  try {
    await work();
  } catch (err) {
    if (err instanceof AllergyError || err instanceof ServiceAllergyError) redirect(`${path}?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  revalidatePath(path);
  redirect(`${path}?saved=${encodeURIComponent(saved)}`);
}

export async function recordAllergyAction(form: FormData) {
  const { session, admission, path } = await begin(form);
  await attempt(
    path,
    () =>
      recordAllergy({
        hospitalId: session.hospitalId,
        patientId: admission.patientId,
        admissionId: admission.admissionId,
        input: parseAllergy({
          substance: form.get('substance'),
          category: form.get('category'),
          reaction: form.get('reaction'),
          severity: form.get('severity'),
          source: form.get('source'),
        }),
        clientId: /^[0-9a-f-]{36}$/i.test(text(form, 'clientId')) ? text(form, 'clientId') : crypto.randomUUID(),
        actorUserId: session.userId,
      }),
    'Allergy recorded',
  );
}

export async function strikeOutAllergyAction(form: FormData) {
  const { session, path } = await begin(form);
  await attempt(path, () => strikeOutAllergy({ hospitalId: session.hospitalId, allergyId: text(form, 'allergyId'), reason: text(form, 'reason'), actorUserId: session.userId }), 'Struck out');
}

export async function reviewAllergiesAction(form: FormData) {
  const { session, admission, path } = await begin(form);
  const outcome = text(form, 'outcome') === 'unable' ? 'unable' : 'nkda';
  await attempt(
    path,
    () => reviewAllergies({ hospitalId: session.hospitalId, patientId: admission.patientId, admissionId: admission.admissionId, outcome, note: text(form, 'note') || null, actorUserId: session.userId }),
    outcome === 'nkda' ? 'Noted: no known drug allergies' : 'Noted: could not ask',
  );
}
