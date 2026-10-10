'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule, getModuleStatesForRequest } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { can, type Permission } from '@/lib/domain/permissions';
import { StockError, isAdjustReason, parseQuantity } from '@/lib/domain/stock';
import { serviceDateIn } from '@/lib/domain/time';
import {
  approveCount,
  cancelCount,
  decideAdjustment,
  explainDifference,
  receiveStock,
  receiveTransfer,
  requestAdjustment,
  saveCount,
  sendTransfer,
  startCount,
  submitCount,
  type ReceiptLine,
} from '@/lib/services/stock';

/**
 * Risk-class stock (IPD sheets plan B4a). Form posts that come back with a
 * message. Every action checks the person, the permission and the module on
 * the server; the database then holds the rules (balances never below zero,
 * a second person for approvals) whatever reaches it.
 */

const BASE = '/ipd/stock';

async function authorize(permission: Permission) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) throw new Error('Your login cannot do this');
  await assertModule(session, 'stock', 'write');
  return session;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

const back = (path: string, params: Record<string, string>): never => {
  revalidatePath(BASE);
  redirect(`${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(params).toString()}`);
};

async function attempt<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StockError) back(path, { error: err.message });
    throw err;
  }
}

/* -------------------------------------------------------------- receive */

export async function receiveStockAction(form: FormData) {
  const session = await authorize('stock.move');
  const path = `${BASE}/receive`;
  let lines: ReceiptLine[] = [];
  try {
    lines = (JSON.parse(text(form, 'lines') || '[]') as { medicineId: string; batchNo: string; expiry: string; quantity: string }[]).map((line, i) => ({
      medicineId: String(line.medicineId),
      batchNo: String(line.batchNo),
      expiry: String(line.expiry),
      quantity: parseQuantity(String(line.quantity), `Line ${i + 1} quantity`),
    }));
  } catch (err) {
    back(path, { error: err instanceof StockError ? err.message : 'Check the lines' });
  }
  await attempt(path, () =>
    receiveStock({
      hospitalId: session.hospitalId,
      locationId: text(form, 'locationId'),
      supplierName: text(form, 'supplierName'),
      invoiceNo: text(form, 'invoiceNo'),
      invoiceDate: text(form, 'invoiceDate'),
      lines,
      actorUserId: session.userId,
      clientId: text(form, 'clientId'),
      today: serviceDateIn(session.timezone),
    }),
  );
  back(BASE, { saved: `Received ${lines.length} line${lines.length === 1 ? '' : 's'} against invoice ${text(form, 'invoiceNo')}` });
}

/* -------------------------------------------------------------- transfers */

export async function sendTransferAction(form: FormData) {
  const session = await authorize('stock.move');
  const from = text(form, 'fromLocationId');
  const path = `${BASE}/send`;
  const lines: { batchId: string; quantity: number }[] = [];
  await attempt(path, async () => {
    for (const [key, value] of form.entries()) {
      if (!key.startsWith('qty_') || String(value).trim() === '') continue;
      lines.push({ batchId: key.slice(4), quantity: parseQuantity(String(value), 'Quantity') });
    }
  });
  const { transferId } = await attempt(`${path}?from=${from}`, () =>
    sendTransfer({
      hospitalId: session.hospitalId,
      fromLocationId: from,
      toLocationId: text(form, 'toLocationId'),
      lines,
      actorUserId: session.userId,
      clientId: text(form, 'clientId'),
    }),
  );
  back(BASE, { saved: `Sent. The receiving store takes it in from its stock page.`, transfer: transferId });
}

export async function receiveTransferAction(form: FormData) {
  const session = await authorize('stock.move');
  const transferId = text(form, 'transferId');
  const path = `${BASE}/transfer/${transferId}`;
  const received: { lineId: string; quantity: number }[] = [];
  await attempt(path, async () => {
    for (const [key, value] of form.entries()) {
      if (!key.startsWith('got_')) continue;
      received.push({ lineId: key.slice(4), quantity: parseQuantity(String(value), 'Received', { min: 0 }) });
    }
  });
  const { shortfall } = await attempt(path, () => receiveTransfer({ hospitalId: session.hospitalId, transferId, received, actorUserId: session.userId }));
  back(BASE, { saved: shortfall > 0 ? `Taken in. ${shortfall} short — recorded as missing on the way.` : 'Taken in. Everything arrived.' });
}

/* -------------------------------------------------------------- counts */

export async function startCountAction(form: FormData) {
  const session = await authorize('stock.count');
  const states = await getModuleStatesForRequest(session.hospitalId);
  const { countId } = await attempt(BASE, () =>
    startCount({
      hospitalId: session.hospitalId,
      locationId: text(form, 'locationId'),
      actorUserId: session.userId,
      clientId: text(form, 'clientId'),
      stage: states.get('stock')?.stage ?? 'observe',
    }),
  );
  redirect(`${BASE}/count/${countId}`);
}

export async function saveCountAction(form: FormData) {
  const session = await authorize('stock.count');
  const countId = text(form, 'countId');
  const path = `${BASE}/count/${countId}`;
  const counted: { batchId: string; quantity: number | null }[] = [];
  const manualUse: { medicineId: string; used: number | null }[] = [];
  let found: { medicineId: string; batchNo: string; expiry: string; quantity: number } | null = null;
  await attempt(path, async () => {
    for (const [key, value] of form.entries()) {
      const raw = String(value).trim();
      if (key.startsWith('count_')) counted.push({ batchId: key.slice(6), quantity: raw === '' ? null : parseQuantity(raw, 'Count', { min: 0 }) });
      if (key.startsWith('used_')) manualUse.push({ medicineId: key.slice(5), used: raw === '' ? null : parseQuantity(raw, 'Used', { min: 0 }) });
    }
    if (text(form, 'foundMedicineId') && text(form, 'foundBatchNo')) {
      found = {
        medicineId: text(form, 'foundMedicineId'),
        batchNo: text(form, 'foundBatchNo'),
        expiry: text(form, 'foundExpiry'),
        quantity: parseQuantity(text(form, 'foundQuantity'), 'Found quantity', { min: 0 }),
      };
    }
  });
  await attempt(path, () => saveCount({ hospitalId: session.hospitalId, countId, actorUserId: session.userId, counted, manualUse, found }));

  const intent = text(form, 'intent');
  if (intent === 'submit') {
    const { differences } = await attempt(path, () => submitCount({ hospitalId: session.hospitalId, countId, actorUserId: session.userId }));
    back(path, { saved: differences === 0 ? 'Submitted. Everything matches the books.' : `Submitted. ${differences} line${differences === 1 ? ' differs' : 's differ'} — say why below.` });
  }
  if (intent === 'cancel') {
    await attempt(path, () => cancelCount({ hospitalId: session.hospitalId, countId, actorUserId: session.userId }));
    back(BASE, { saved: 'Count cancelled' });
  }
  back(path, { saved: 'Saved. Carry on counting.' });
}

export async function explainDifferenceAction(form: FormData) {
  const session = await authorize('stock.count');
  const countId = text(form, 'countId');
  const path = `${BASE}/count/${countId}`;
  await attempt(path, () =>
    explainDifference({
      hospitalId: session.hospitalId,
      countId,
      batchId: text(form, 'batchId'),
      reasonCode: text(form, 'reasonCode'),
      reasonText: text(form, 'reasonText'),
      actorUserId: session.userId,
    }),
  );
  back(path, { saved: 'Reason saved' });
}

export async function approveCountAction(form: FormData) {
  const session = await authorize('stock.approve');
  const countId = text(form, 'countId');
  await attempt(`${BASE}/count/${countId}`, () => approveCount({ hospitalId: session.hospitalId, countId, actorUserId: session.userId }));
  back(BASE, { saved: 'Count approved. The books now match the shelf.' });
}

/* -------------------------------------------------------------- adjustments */

export async function requestAdjustmentAction(form: FormData) {
  const session = await authorize('stock.move');
  const locationId = text(form, 'locationId');
  const path = `${BASE}/adjust`;
  const reason = text(form, 'reasonCode');
  if (!isAdjustReason(reason)) back(`${path}?location=${locationId}`, { error: 'Choose a reason' });
  const direction = text(form, 'direction') === 'in' ? 'in' : 'out';
  const quantity = await attempt(`${path}?location=${locationId}`, async () => parseQuantity(text(form, 'quantity')));
  await attempt(`${path}?location=${locationId}`, () =>
    requestAdjustment({
      hospitalId: session.hospitalId,
      locationId,
      batchId: text(form, 'batchId'),
      direction,
      quantity,
      reasonCode: reason as Parameters<typeof requestAdjustment>[0]['reasonCode'],
      reasonText: text(form, 'reasonText'),
      actorUserId: session.userId,
      clientId: text(form, 'clientId'),
    }),
  );
  back(BASE, { saved: 'Asked. A second person approves it on the stock page.' });
}

export async function decideAdjustmentAction(form: FormData) {
  const session = await authorize('stock.approve');
  const approve = text(form, 'decision') === 'approve';
  await attempt(BASE, () => decideAdjustment({ hospitalId: session.hospitalId, adjustmentId: text(form, 'adjustmentId'), approve, actorUserId: session.userId }));
  back(BASE, { saved: approve ? 'Adjustment approved and posted' : 'Adjustment rejected' });
}
