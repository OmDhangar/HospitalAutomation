'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { LOCATION_KINDS, RISK_KINDS, StockError, type LocationKind, type RiskKind } from '@/lib/domain/stock';
import { createLocation, createRiskClass, setLocationActive, setMedicineRiskClass, setRiskClassWitness } from '@/lib/services/stock';

/**
 * Settings → Stock (IPD sheets plan B4a): stores, risk classes and which
 * medicines are in them. Owner only (`stock.configure`), module `stock`.
 */

const PAGE = '/settings/stock';

async function authorize() {
  const session = await requireWritableSession();
  if (!can(session.role, 'stock.configure')) throw new Error('Only the hospital owner can set up stock');
  await assertModule(session, 'stock', 'write');
  return session;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

const back = (params: Record<string, string>): never => {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams(params).toString()}`);
};

async function attempt(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof StockError) back({ error: err.message });
    throw err;
  }
}

export async function createLocationAction(form: FormData) {
  const session = await authorize();
  const kind = text(form, 'kind');
  if (!(kind in LOCATION_KINDS)) back({ error: 'Choose what kind of store it is' });
  await attempt(() =>
    createLocation({
      hospitalId: session.hospitalId,
      branchId: text(form, 'branchId'),
      name: text(form, 'name'),
      kind: kind as LocationKind,
      wardId: text(form, 'wardId') || null,
      actorUserId: session.userId,
    }),
  );
  back({ saved: `Store ${text(form, 'name')} added` });
}

export async function setLocationActiveAction(form: FormData) {
  const session = await authorize();
  const active = text(form, 'active') === 'true';
  await attempt(() => setLocationActive({ hospitalId: session.hospitalId, locationId: text(form, 'locationId'), active, actorUserId: session.userId }));
  back({ saved: active ? 'Store reopened' : 'Store closed' });
}

export async function createRiskClassAction(form: FormData) {
  const session = await authorize();
  const kind = text(form, 'kind');
  if (!(kind in RISK_KINDS)) back({ error: 'Choose a kind' });
  await attempt(() =>
    createRiskClass({
      hospitalId: session.hospitalId,
      name: text(form, 'name'),
      kind: kind as RiskKind,
      countEvery: text(form, 'countEvery') === 'weekly' ? 'weekly' : 'daily',
      actorUserId: session.userId,
    }),
  );
  back({ saved: `Risk class ${text(form, 'name')} added` });
}

export async function setMedicineRiskClassAction(form: FormData) {
  const session = await authorize();
  await attempt(() =>
    setMedicineRiskClass({
      hospitalId: session.hospitalId,
      medicineId: text(form, 'medicineId'),
      riskClassId: text(form, 'riskClassId') || null,
      actorUserId: session.userId,
    }),
  );
  back({ saved: 'Saved', q: text(form, 'q') });
}

/** Whether every give of this class needs a witness on the MAR (B3-min). NDPS always do. */
export async function setRiskClassWitnessAction(form: FormData) {
  const session = await authorize();
  const witnessAtGive = text(form, 'witnessAtGive') === 'true';
  await attempt(() => setRiskClassWitness({ hospitalId: session.hospitalId, riskClassId: text(form, 'riskClassId'), witnessAtGive, actorUserId: session.userId }));
  back({ saved: witnessAtGive ? 'Every give of this class now needs a witness' : 'This class no longer needs a witness at give' });
}
