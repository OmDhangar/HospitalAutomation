'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { parsePriceEdits } from '@/lib/domain/ipd-config';
import { parsePercentToBasisPoints, parseRupeesToPaise } from '@/lib/domain/patient-billing';
import { can } from '@/lib/domain/permissions';
import {
  MedicineError,
  addStarterMedicines,
  createMedicine,
  setMedicinePrices,
  setMedicineActive,
  updateMedicine,
} from '@/lib/services/medicines';

/**
 * The owner's catalogue actions. Plain form posts that redirect back with a
 * message, the same shape as the rest of Settings, so the screen works with
 * no client JavaScript at all.
 */

const PAGE = '/settings/medicines';

async function authorize() {
  const session = await requireWritableSession();
  if (!can(session.role, 'medicines.manage')) {
    throw new Error('Only the hospital owner can change the medicine list');
  }
  return session;
}

const back = (params: Record<string, string>, keep: FormData): never => {
  const query = new URLSearchParams(params);
  // Return to the same filter and search the owner was looking at.
  for (const key of ['q', 'filter', 'mode']) {
    const value = String(keep.get(`_${key}`) ?? '');
    if (value) query.set(key, value);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?${query.toString()}`);
};

/**
 * Reads the medicine fields from a form. A blank price means "not priced yet";
 * anything else that does not parse is an error, not a silent zero.
 */
function readMedicine(form: FormData): { input: Record<string, unknown> } | { error: string } {
  const rawPrice = String(form.get('price') ?? '').trim();
  const price = rawPrice === '' ? null : parseRupeesToPaise(rawPrice);
  if (rawPrice !== '' && price === null) return { error: 'Enter the price in rupees, like 2.50' };

  const rawTax = String(form.get('tax') ?? '').trim();
  const tax = rawTax === '' ? 0 : parsePercentToBasisPoints(rawTax);
  if (tax === null) return { error: 'Enter tax as a percentage, like 12' };

  return {
    input: {
      name: String(form.get('name') ?? ''),
      genericName: String(form.get('genericName') ?? ''),
      strength: String(form.get('strength') ?? ''),
      form: String(form.get('form') ?? ''),
      unit: String(form.get('unit') ?? ''),
      sellingPricePaise: price,
      taxRateBp: tax,
    },
  };
}

export async function createMedicineAction(form: FormData) {
  const session = await authorize();
  const read = readMedicine(form);
  if ('error' in read) back({ error: read.error }, form);
  try {
    await createMedicine({
      hospitalId: session.hospitalId,
      input: (read as { input: Record<string, unknown> }).input,
      actorUserId: session.userId,
    });
  } catch (err) {
    if (err instanceof MedicineError) back({ error: err.message }, form);
    throw err;
  }
  back({ saved: 'Medicine added' }, form);
}

export async function updateMedicineAction(form: FormData) {
  const session = await authorize();
  const read = readMedicine(form);
  if ('error' in read) back({ error: read.error }, form);
  try {
    await updateMedicine({
      hospitalId: session.hospitalId,
      medicineId: String(form.get('medicineId') ?? ''),
      input: (read as { input: Record<string, unknown> }).input,
      actorUserId: session.userId,
    });
  } catch (err) {
    if (err instanceof MedicineError) back({ error: err.message }, form);
    throw err;
  }
  back({ saved: 'Saved. Bills already issued keep their old price.' }, form);
}

export async function toggleMedicineAction(form: FormData) {
  const session = await authorize();
  const active = String(form.get('active') ?? '') === 'true';
  await setMedicineActive({
    hospitalId: session.hospitalId,
    medicineId: String(form.get('medicineId') ?? ''),
    active,
    actorUserId: session.userId,
  });
  back(
    {
      saved: active
        ? 'Medicine restored'
        : 'Medicine removed from the list. Old prescriptions still show it.',
    },
    form,
  );
}

export async function addStarterMedicinesAction(form: FormData) {
  const session = await authorize();
  const { added } = await addStarterMedicines({
    hospitalId: session.hospitalId,
    actorUserId: session.userId,
  });
  back(
    {
      saved:
        added > 0
          ? `Added ${added} common medicines. Set prices for the ones you stock.`
          : 'All the common medicines are already in your list.',
    },
    form,
  );
}

/**
 * The "Set prices" screen's single Save: one box per unpriced medicine. A
 * medicine priced for the first time also bills the bedside entries that were
 * waiting for it.
 */
export async function setMedicinePricesAction(form: FormData) {
  const session = await authorize();
  const edits = parsePriceEdits(
    [...form.entries()].map(([key, value]) => [key, String(value)] as [string, string]),
  );
  if (!edits.ok) back({ error: edits.error }, form);
  const { changed, billed } = await setMedicinePrices({
    hospitalId: session.hospitalId,
    edits: (edits as { ok: true; value: { id: string; sellingPricePaise: number }[] }).value,
    actorUserId: session.userId,
  });
  back(
    {
      saved:
        changed === 0
          ? 'No prices changed.'
          : `${changed} price${changed === 1 ? '' : 's'} saved${billed > 0 ? `, and ${billed} waiting entries billed` : ''}.`,
    },
    form,
  );
}
