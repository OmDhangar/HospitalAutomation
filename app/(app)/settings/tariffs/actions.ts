'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { parseRupeesToPaise, parsePercentToBasisPoints } from '@/lib/domain/patient-billing';
import {
  saveRatePlan,
  setChargeItemTariff,
  type RatePlanInput,
} from '@/lib/services/tariffs';

const PAGE = '/settings/tariffs';

async function authorize() {
  const session = await requireWritableSession();
  if (!can(session.role, 'tariffs.manage')) {
    throw new Error('Only the hospital administrator can manage tariff rate plans');
  }
  return session;
}

const back = (params: Record<string, string>): never => {
  const query = new URLSearchParams(params);
  revalidatePath(PAGE);
  redirect(`${PAGE}?${query.toString()}`);
};

export async function saveRatePlanAction(form: FormData) {
  const session = await authorize();

  const id = String(form.get('id') ?? '').trim() || undefined;
  const name = String(form.get('name') ?? '').trim();
  const code = String(form.get('code') ?? '').trim();
  const payerKindRaw = String(form.get('payerKind') ?? 'self').trim();
  const payerName = String(form.get('payerName') ?? '').trim() || null;
  const rawModifier = String(form.get('modifierPercent') ?? '0').trim();
  const isDefault = form.get('isDefault') === 'on' || form.get('isDefault') === 'true';
  const active = form.get('active') !== 'false';

  if (!name) back({ error: 'Rate plan name is required' });
  if (!code) back({ error: 'Rate plan code is required' });

  let modifierBp = 0;
  if (rawModifier) {
    const parsed = parsePercentToBasisPoints(rawModifier.replace(/^[+]/, ''));
    if (parsed === null) back({ error: 'Enter modifier as a valid percentage, e.g. 10 or -15' });
    modifierBp = rawModifier.startsWith('-') ? -Math.abs(parsed!) : parsed!;
  }

  const payerKind = ['self', 'insurer', 'tpa', 'corporate'].includes(payerKindRaw)
    ? (payerKindRaw as RatePlanInput['payerKind'])
    : 'self';

  try {
    await saveRatePlan(
      session.hospitalId,
      {
        id,
        name,
        code,
        payerKind,
        payerName,
        modifierBp,
        isDefault,
        active,
      },
      session.userId,
    );
  } catch (err: any) {
    back({ error: err.message || 'Failed to save rate plan' });
  }

  back({ saved: `Rate plan "${name}" saved successfully` });
}

export async function setChargeItemTariffAction(form: FormData) {
  const session = await authorize();

  const ratePlanId = String(form.get('ratePlanId') ?? '').trim();
  const chargeItemId = String(form.get('chargeItemId') ?? '').trim();
  const rawPrice = String(form.get('tariffPrice') ?? '').trim();

  if (!ratePlanId || !chargeItemId) {
    back({ error: 'Missing rate plan or charge item reference' });
  }

  const pricePaise = parseRupeesToPaise(rawPrice);
  if (pricePaise === null || pricePaise < 0) {
    back({ error: 'Enter a valid tariff price in rupees (e.g. 450.00)' });
  }

  try {
    await setChargeItemTariff(
      session.hospitalId,
      {
        ratePlanId,
        chargeItemId,
        tariffPricePaise: pricePaise!,
      },
      session.userId,
    );
  } catch (err: any) {
    back({ error: err.message || 'Failed to save item tariff' });
  }

  back({ planId: ratePlanId, saved: 'Tariff override saved' });
}
