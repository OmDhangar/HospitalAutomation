'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { parseDepositRupees, parsePayerInput } from '@/lib/domain/payer';
import { can, type Permission } from '@/lib/domain/permissions';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import {
  AdmissionError,
  assignBed,
  cancelAdmission,
  createDirectAdmission,
  setDischargeReady,
  transferBed,
  type AdmissionExtras,
} from '@/lib/services/admissions';
import { CareEntryError, voidCareEntry } from '@/lib/services/care-entries';
import { PatientBillingError } from '@/lib/services/patient-billing';
import { WardDeviceError, setOwnPin } from '@/lib/services/ward-devices';
import { DoctorIpdError, orderTests } from '@/lib/services/doctor-ipd';

/**
 * The desk's IPD actions (IPD plan §5.3–5.5, task T1.6). Form posts that
 * redirect with a message, like Settings, so the admission sheet works on a
 * slow connection before any script has loaded.
 */

async function authorize(permission: Permission) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) throw new Error('You cannot do this from your login');
  return session;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '');

const go = (path: string, params: Record<string, string> = {}): never => {
  revalidatePath('/ipd');
  revalidatePath('/dashboard');
  const query = new URLSearchParams(params).toString();
  redirect(`${path}${query ? `?${query}` : ''}`);
};

const isActionError = (err: unknown) => err instanceof AdmissionError || err instanceof PatientBillingError;

/**
 * Reads the optional "Add details" block. The deposit is taken only from a
 * role that may take money; anyone else's deposit field is ignored, not
 * trusted (and the sheet never shows it to them).
 */
function readExtras(form: FormData, canCollect: boolean): AdmissionExtras | { error: string } {
  const payer = parsePayerInput({
    kind: text(form, 'payerKind'),
    payerName: text(form, 'payerName'),
    policyNumber: text(form, 'policyNumber'),
    preauthRupees: text(form, 'preauthRupees'),
  });
  if (!payer.ok) return { error: payer.error };
  const deposit = canCollect ? parseDepositRupees(text(form, 'depositRupees')) : { ok: true as const, value: null };
  if (!deposit.ok) return { error: deposit.error };
  const method = text(form, 'depositMethod');
  return {
    reason: text(form, 'reason'),
    payer: payer.value,
    depositPaise: deposit.value,
    depositMethod: method === 'upi' || method === 'card' || method === 'bank' ? method : 'cash',
  };
}

export async function assignBedAction(form: FormData) {
  const session = await authorize('ipd.admit');
  const admissionId = text(form, 'admissionId');
  const sheet = `/ipd/admissions/${admissionId}/assign`;
  const bedId = text(form, 'bedId');
  if (!bedId) go(sheet, { error: 'Tap a bed first' });

  const extras = readExtras(form, can(session.role, 'billing.collect'));
  if ('error' in extras) go(sheet, { error: extras.error, bed: bedId });
  try {
    await assignBed({
      hospitalId: session.hospitalId,
      admissionId,
      bedId,
      extras: extras as AdmissionExtras,
      actorUserId: session.userId,
    });
  } catch (err) {
    if (isActionError(err)) go(sheet, { error: (err as Error).message });
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, { saved: 'Admitted. The bed is on the ward grid.' });
}

export async function transferBedAction(form: FormData) {
  const session = await authorize('ipd.admit');
  const admissionId = text(form, 'admissionId');
  const page = `/ipd/admissions/${admissionId}/transfer`;
  const bedId = text(form, 'bedId');
  if (!bedId) go(page, { error: 'Tap the new bed first' });
  try {
    await transferBed({ hospitalId: session.hospitalId, admissionId, bedId, actorUserId: session.userId });
  } catch (err) {
    if (isActionError(err)) go(page, { error: (err as Error).message });
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, { saved: 'Moved to the new bed. Everything recorded stays with the stay.' });
}

export async function cancelAdmissionAction(form: FormData) {
  const session = await authorize('ipd.admit');
  const admissionId = text(form, 'admissionId');
  try {
    await cancelAdmission({
      hospitalId: session.hospitalId,
      admissionId,
      reason: text(form, 'reason'),
      actorUserId: session.userId,
    });
  } catch (err) {
    if (isActionError(err)) go(`/ipd/admissions/${admissionId}`, { error: (err as Error).message });
    throw err;
  }
  go('/ipd', { tab: 'awaiting' });
}

/** Emergency admission: no OPD token (IPD plan §5.4). */
export async function createDirectAdmissionAction(form: FormData) {
  const session = await authorize('ipd.admit');
  const keep = { phone: text(form, 'phone'), name: text(form, 'name') };
  const back = (error: string): never => go('/ipd/new', { error, ...keep });

  const phoneE164 = normalizeIndianPhone(text(form, 'phone'));
  if (!phoneE164) back('Enter a valid 10-digit mobile number');
  const name = text(form, 'name').trim();
  if (!name) back('Enter the patient’s name');
  const rawAge = text(form, 'age').trim();
  const age = rawAge === '' ? null : Number(rawAge);
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) back('Enter the age in years');
  const gender = text(form, 'gender');
  const doctorId = text(form, 'doctorId');
  if (!doctorId) back('Choose the doctor');

  const extras = readExtras(form, can(session.role, 'billing.collect'));
  if ('error' in extras) back(extras.error);

  let admissionId = '';
  try {
    const result = await createDirectAdmission({
      hospitalId: session.hospitalId,
      branchId: text(form, 'branchId'),
      doctorId,
      patient: {
        phoneE164: phoneE164!,
        name,
        age,
        gender: gender === 'male' || gender === 'female' || gender === 'other' ? gender : null,
        address: text(form, 'address').trim() || null,
      },
      bedId: text(form, 'bedId') || null,
      extras: extras as AdmissionExtras,
      actorUserId: session.userId,
    });
    admissionId = result.admissionId;
  } catch (err) {
    if (isActionError(err)) back((err as Error).message);
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, {
    saved: text(form, 'bedId') ? 'Admitted.' : 'Admitted. Assign a bed when one is free.',
  });
}

/** The doctor's Discharge ready, and taking it back (also the phone view's button). */
export async function setDischargeReadyAction(form: FormData) {
  const session = await authorize('ipd.dischargeReady');
  const admissionId = text(form, 'admissionId');
  const ready = text(form, 'ready') === 'true';
  const back = text(form, 'back') || `/ipd/admissions/${admissionId}`;
  const safeBack = back.startsWith('/ipd') ? back : `/ipd/admissions/${admissionId}`;
  try {
    await setDischargeReady({ hospitalId: session.hospitalId, admissionId, ready, actorUserId: session.userId });
  } catch (err) {
    if (isActionError(err)) go(safeBack, { error: (err as Error).message });
    throw err;
  }
  go(safeBack, { saved: ready ? 'Marked ready to go home. The desk will prepare the bill.' : 'No longer marked ready.' });
}

/** The desk's correction of a bedside entry after the undo window, with a reason (D-UN). */
export async function voidCareEntryAction(form: FormData) {
  const session = await authorize('ipd.correct');
  const admissionId = text(form, 'admissionId');
  try {
    await voidCareEntry({
      hospitalId: session.hospitalId,
      entryId: text(form, 'entryId'),
      reason: text(form, 'reason'),
      actorUserId: session.userId,
    });
  } catch (err) {
    if (err instanceof CareEntryError) go(`/ipd/admissions/${admissionId}`, { error: err.message });
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, { saved: 'Entry removed. Its bill line is voided with your reason.' });
}

/** A nurse sets her own ward-tablet PIN, signed in with her own login (T1.9). */
export async function setOwnPinAction(form: FormData) {
  const session = await authorize('ipd.record');
  if (session.wardDeviceId) go('/ipd/ward', { error: 'Set your PIN after signing in with your own login' });
  const pin = text(form, 'pin').trim();
  if (pin !== text(form, 'confirm').trim()) go('/ipd/ward', { error: 'The two PINs do not match' });
  try {
    await setOwnPin({ hospitalId: session.hospitalId, userId: session.userId, pin });
  } catch (err) {
    if (err instanceof WardDeviceError) go('/ipd/ward', { error: err.message });
    throw err;
  }
  go('/ipd/ward', { saved: 'Your ward PIN is set. Use it on the shared ward tablet.' });
}

/** The doctor's Tests button (T3.1): each tapped test becomes an entry, billed like any other. */
export async function orderTestsAction(form: FormData) {
  const session = await authorize('ipd.orderTests');
  const admissionId = text(form, 'admissionId');
  const ids = form.getAll('test').map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  let ordered = 0;
  let firstError = '';
  try {
    const results = await orderTests({
      hospitalId: session.hospitalId,
      admissionId,
      chargeItemIds: ids,
      formKey: text(form, 'formKey'),
      actorUserId: session.userId,
      // The person running the hospital may order for any patient.
      seeAll: can(session.role, 'hospital.configure'),
    });
    ordered = results.filter((result) => result.ok).length;
    const refused = results.find((result) => !result.ok);
    firstError = refused && !refused.ok ? refused.error : '';
  } catch (err) {
    if (err instanceof DoctorIpdError) go('/ipd/my-patients', { error: err.message });
    throw err;
  }
  go('/ipd/my-patients', firstError ? { error: firstError } : { saved: `${ordered} test${ordered === 1 ? '' : 's'} sent.` });
}
