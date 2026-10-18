'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { TestOrderError, parseServicePoint } from '@/lib/domain/test-orders';
import {
  assignStaff,
  createServicePoint,
  removeStaff,
  setServicePointActive,
  setTestServicePoint,
  updateServicePoint,
} from '@/lib/services/test-orders';

/**
 * Settings → Tests (IPD sheets plan C4a): the labs and rooms tests are done
 * in, the way to each in three languages, when each one's clock starts, who
 * works there, and which test is done where. Owner only (`tests.configure`),
 * module `test_follow_up`.
 */

const PAGE = '/settings/tests';

async function authorize() {
  const session = await requireWritableSession();
  if (!can(session.role, 'tests.configure')) throw new Error('Only the hospital owner can set up tests');
  await assertModule(session, 'test_follow_up', 'write');
  return session;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const isId = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

const back = (params: Record<string, string>, anchor = ''): never => {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams(params).toString()}${anchor}`);
};

async function attempt(fn: () => Promise<unknown>, anchor = '') {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TestOrderError) back({ error: err.message }, anchor);
    throw err;
  }
}

const pointInput = (form: FormData) =>
  parseServicePoint({
    kind: text(form, 'kind'),
    name: text(form, 'name'),
    nameMr: text(form, 'nameMr'),
    nameHi: text(form, 'nameHi'),
    floor: text(form, 'floor'),
    floorMr: text(form, 'floorMr'),
    floorHi: text(form, 'floorHi'),
    section: text(form, 'section'),
    sectionMr: text(form, 'sectionMr'),
    sectionHi: text(form, 'sectionHi'),
    clockFrom: text(form, 'clockFrom'),
    clockMinutes: text(form, 'clockMinutes'),
  });

export async function createServicePointAction(form: FormData) {
  const session = await authorize();
  let id = '';
  await attempt(async () => {
    id = await createServicePoint({ hospitalId: session.hospitalId, branchId: text(form, 'branchId'), input: pointInput(form), actorUserId: session.userId });
  });
  back({ saved: `${text(form, 'name')} added. Now add its staff and its tests.`, point: id }, `#point-${id}`);
}

export async function updateServicePointAction(form: FormData) {
  const session = await authorize();
  const id = text(form, 'servicePointId');
  await attempt(
    () => updateServicePoint({ hospitalId: session.hospitalId, servicePointId: id, input: pointInput(form), actorUserId: session.userId }),
    `#point-${id}`,
  );
  back({ saved: `${text(form, 'name')} saved`, point: id }, `#point-${id}`);
}

export async function setServicePointActiveAction(form: FormData) {
  const session = await authorize();
  const active = text(form, 'active') === 'true';
  await attempt(() =>
    setServicePointActive({ hospitalId: session.hospitalId, servicePointId: text(form, 'servicePointId'), active, actorUserId: session.userId }),
  );
  back({ saved: active ? 'Reopened' : 'Closed. Its tests can no longer be ordered until it reopens.' });
}

export async function assignStaffAction(form: FormData) {
  const session = await authorize();
  const id = text(form, 'servicePointId');
  const userId = text(form, 'userId');
  if (!isId(userId)) back({ error: 'Choose a person' }, `#point-${id}`);
  await attempt(() => assignStaff({ hospitalId: session.hospitalId, servicePointId: id, userId, actorUserId: session.userId }), `#point-${id}`);
  back({ saved: 'Staff added', point: id }, `#point-${id}`);
}

export async function removeStaffAction(form: FormData) {
  const session = await authorize();
  const id = text(form, 'servicePointId');
  await attempt(
    () => removeStaff({ hospitalId: session.hospitalId, servicePointId: id, userId: text(form, 'userId'), actorUserId: session.userId }),
    `#point-${id}`,
  );
  back({ saved: 'Staff removed', point: id }, `#point-${id}`);
}

/** One form for the whole test list: each select says where that test is done. Only changed rows are written. */
export async function placeTestsAction(form: FormData) {
  const session = await authorize();
  let changed = 0;
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('place:')) continue;
    const chargeItemId = key.slice('place:'.length);
    const next = String(value);
    if (next === text(form, `was:${chargeItemId}`) || !isId(chargeItemId)) continue;
    await attempt(
      () =>
        setTestServicePoint({
          hospitalId: session.hospitalId,
          chargeItemId,
          servicePointId: isId(next) ? next : null,
          actorUserId: session.userId,
        }),
      '#tests',
    );
    changed += 1;
  }
  back({ saved: changed === 0 ? 'Nothing changed' : `${changed} test${changed === 1 ? '' : 's'} placed`, placed: '1' }, '#tests');
}
