'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { parseRupeesToPaise } from '@/lib/domain/patient-billing';
import { can, type Permission } from '@/lib/domain/permissions';
import {
  DischargeBillError,
  discountBillLine,
  finalizeDischarge,
  recordIpdPayment,
  revokeBillLink,
  setApprovedAmount,
  shareBillLink,
  voidBillLine,
} from '@/lib/services/discharge-billing';
import { PatientBillingError } from '@/lib/services/patient-billing';

/**
 * The discharge billing screen's actions (IPD plan §T2.2). Every correction
 * needs a reason; every one is a void and a re-post, never an edit.
 */

async function authorize(permission: Permission) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) throw new Error('You cannot do this from your login');
  return session;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '');

function go(admissionId: string, params: Record<string, string> = {}): never {
  const page = `/ipd/admissions/${admissionId}/bill`;
  revalidatePath(page);
  revalidatePath(`/ipd/admissions/${admissionId}`);
  revalidatePath('/ipd');
  const query = new URLSearchParams(params).toString();
  redirect(`${page}${query ? `?${query}` : ''}`);
}

async function attempt(admissionId: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (err) {
    if (err instanceof DischargeBillError || err instanceof PatientBillingError) go(admissionId, { error: err.message });
    throw err;
  }
}

export async function voidLineAction(form: FormData) {
  const session = await authorize('ipd.correct');
  const admissionId = text(form, 'admissionId');
  await attempt(admissionId, () =>
    voidBillLine({ hospitalId: session.hospitalId, lineId: text(form, 'lineId'), reason: text(form, 'reason'), actorUserId: session.userId }),
  );
  go(admissionId, { saved: 'Line removed, with your reason.' });
}

export async function discountLineAction(form: FormData) {
  const session = await authorize('ipd.correct');
  const admissionId = text(form, 'admissionId');
  const discount = parseRupeesToPaise(text(form, 'discount'));
  if (discount === null) go(admissionId, { error: 'Enter the discount in rupees, like 50' });
  await attempt(admissionId, () =>
    discountBillLine({
      hospitalId: session.hospitalId,
      lineId: text(form, 'lineId'),
      discountPaise: discount!,
      reason: text(form, 'reason'),
      actorUserId: session.userId,
    }),
  );
  go(admissionId, { saved: 'Discount applied.' });
}

export async function recordPaymentAction(form: FormData) {
  const session = await authorize('billing.collect');
  const admissionId = text(form, 'admissionId');
  const amount = parseRupeesToPaise(text(form, 'amount'));
  if (amount === null || amount <= 0) go(admissionId, { error: 'Enter the amount in rupees' });
  const kind = text(form, 'kind') === 'refund' ? 'refund' : 'payment';
  const method = text(form, 'method');
  await attempt(admissionId, () =>
    recordIpdPayment({
      hospitalId: session.hospitalId,
      admissionId,
      kind,
      amountPaise: amount!,
      method: method === 'upi' || method === 'card' || method === 'bank' || method === 'other' ? method : 'cash',
      reference: text(form, 'reference'),
      actorUserId: session.userId,
    }),
  );
  go(admissionId, { saved: kind === 'refund' ? 'Refund recorded.' : 'Payment recorded.' });
}

export async function setApprovedAmountAction(form: FormData) {
  const session = await authorize('ipd.discharge');
  const admissionId = text(form, 'admissionId');
  const raw = text(form, 'approved').trim();
  const approved = raw === '' ? null : parseRupeesToPaise(raw);
  if (raw !== '' && approved === null) go(admissionId, { error: 'Enter the approved amount in rupees' });
  await attempt(admissionId, () =>
    setApprovedAmount({ hospitalId: session.hospitalId, admissionId, approvedAmountPaise: approved, actorUserId: session.userId }),
  );
  go(admissionId, { saved: 'Approved amount saved.' });
}

export async function finalizeAction(form: FormData) {
  const session = await authorize('ipd.discharge');
  const admissionId = text(form, 'admissionId');
  let billNumber = '';
  await attempt(admissionId, async () => {
    ({ billNumber } = await finalizeDischarge({ hospitalId: session.hospitalId, admissionId, actorUserId: session.userId }));
  });
  go(admissionId, { saved: `Discharged. Bill ${billNumber} is final.` });
}

export async function shareBillLinkAction(form: FormData) {
  const session = await authorize('ipd.discharge');
  const admissionId = text(form, 'admissionId');
  let token = '';
  await attempt(admissionId, async () => {
    ({ token } = await shareBillLink({ hospitalId: session.hospitalId, admissionId, actorUserId: session.userId }));
  });
  // Shown once on the next screen, to send; only its hash is stored.
  go(admissionId, { link: token });
}

export async function revokeBillLinkAction(form: FormData) {
  const session = await authorize('ipd.discharge');
  const admissionId = text(form, 'admissionId');
  await revokeBillLink({ hospitalId: session.hospitalId, admissionId, actorUserId: session.userId });
  go(admissionId, { saved: 'The family’s link no longer works.' });
}
