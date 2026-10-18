'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { MarError } from '@/lib/domain/mar';
import { can, type Permission } from '@/lib/domain/permissions';
import { zonedTimeToUtc } from '@/lib/domain/time';
import { addOnCall, cancelOnCall, setTimeCritical, setWardInCharge, signOffTimeCritical, updateDueSettings } from '@/lib/services/due';

/**
 * Settings → Treatment and due times (IPD sheets plan B3b): the time-critical
 * list and its sign-off (doctors), the windows, escalation delays and chime,
 * the on-call roster and each ward's in-charge (owner). Module `mar`.
 */

const PAGE = '/settings/treatment';

async function authorize(permission: Permission) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) throw new Error('Not allowed');
  await assertModule(session, 'mar', 'write');
  return session;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const num = (form: FormData, key: string) => (text(form, key) === '' ? null : Number(text(form, key)));
const isId = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

const back = (params: Record<string, string>, anchor = ''): never => {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams(params)}${anchor}`);
};

async function attempt(fn: () => Promise<unknown>, anchor = '') {
  try {
    await fn();
  } catch (err) {
    if (err instanceof MarError) back({ error: err.message }, anchor);
    throw err;
  }
}

export async function setTimeCriticalAction(form: FormData) {
  const session = await authorize('ipd.tcList');
  const on = text(form, 'timeCritical') === 'true';
  await attempt(
    () =>
      setTimeCritical({
        hospitalId: session.hospitalId,
        medicineId: text(form, 'medicineId'),
        timeCritical: on,
        before: num(form, 'before'),
        after: num(form, 'after'),
        actorUserId: session.userId,
      }),
    '#list',
  );
  back({ saved: on ? 'Marked time-critical. Alerts wait for the sign-off.' : 'No longer time-critical', q: text(form, 'q') }, '#list');
}

export async function signOffAction(form: FormData) {
  const session = await authorize('ipd.tcList');
  await attempt(() => signOffTimeCritical({ hospitalId: session.hospitalId, actorUserId: session.userId, note: text(form, 'note') || null }), '#signoff');
  back({ saved: 'Signed off. Time-critical alerts are on.' }, '#signoff');
}

export async function updateSettingsAction(form: FormData) {
  const session = await authorize('ipd.dueConfigure');
  await attempt(
    () =>
      updateDueSettings({
        hospitalId: session.hospitalId,
        settings: {
          tcWindowMin: num(form, 'tcWindowMin') ?? undefined,
          otherWindowMin: num(form, 'otherWindowMin') ?? undefined,
          dueSoonLeadMin: num(form, 'dueSoonLeadMin') ?? undefined,
          l1AfterMin: num(form, 'l1AfterMin') ?? undefined,
          l2AfterMin: num(form, 'l2AfterMin') ?? undefined,
          chime: text(form, 'chime') === 'on',
          quietFrom: text(form, 'quietFrom') || null,
          quietTo: text(form, 'quietTo') || null,
        },
        actorUserId: session.userId,
      }),
    '#settings',
  );
  back({ saved: 'Saved', settings: '1' }, '#settings');
}

export async function addOnCallAction(form: FormData) {
  const session = await authorize('ipd.dueConfigure');
  const [fromDay, fromTime] = text(form, 'from').split('T');
  const [toDay, toTime] = text(form, 'to').split('T');
  if (!fromDay || !fromTime || !toDay || !toTime || !isId(text(form, 'doctorId')) || !isId(text(form, 'branchId'))) back({ error: 'Choose the doctor, branch and times' }, '#oncall');
  await attempt(
    () =>
      addOnCall({
        hospitalId: session.hospitalId,
        branchId: text(form, 'branchId'),
        doctorId: text(form, 'doctorId'),
        startsAt: zonedTimeToUtc(fromDay, fromTime, session.timezone),
        endsAt: zonedTimeToUtc(toDay, toTime, session.timezone),
        actorUserId: session.userId,
      }),
    '#oncall',
  );
  back({ saved: 'On-call added' }, '#oncall');
}

export async function cancelOnCallAction(form: FormData) {
  const session = await authorize('ipd.dueConfigure');
  await attempt(() => cancelOnCall({ hospitalId: session.hospitalId, id: text(form, 'id'), actorUserId: session.userId }), '#oncall');
  back({ saved: 'On-call removed' }, '#oncall');
}

export async function setInChargeAction(form: FormData) {
  const session = await authorize('ipd.dueConfigure');
  const userId = text(form, 'userId');
  await attempt(() => setWardInCharge({ hospitalId: session.hospitalId, wardId: text(form, 'wardId'), userId: isId(userId) ? userId : null, actorUserId: session.userId }), '#incharge');
  back({ saved: 'In-charge saved' }, '#incharge');
}
