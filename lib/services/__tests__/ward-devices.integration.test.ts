import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { MAX_PIN_FAILURES } from '@/lib/domain/ward-pin';
import { resolveSession } from '@/lib/services/auth';
import {
  WardDeviceError,
  listPinPeople,
  registerWardDevice,
  resolveWardDevice,
  revokeWardDevice,
  setOwnPin,
  unlockWithPin,
} from '@/lib/services/ward-devices';

/**
 * Shared ward devices (task T1.9) against a real database: a PIN unlocks a
 * nurse-only session tied to the device; five wrong PINs lock that person
 * there; revoking the device ends its sessions.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Ward Device Test Hospital';

describe.skipIf(!enabled)('ward devices', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const ownerId = uuid();
  const nurseId = uuid();
  const deskId = uuid();
  let cookieValue = '';
  let deviceId = '';

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'wd-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into users (id, email, password_hash, name) values
      (${ownerId}, ${'owner-' + ownerId + '@warddevice.test'}, 'x', 'Owner'),
      (${nurseId}, ${'nurse-' + nurseId + '@warddevice.test'}, 'x', 'Sister Anita'),
      (${deskId}, ${'desk-' + deskId + '@warddevice.test'}, 'x', 'Desk Ravi')`;
    await admin`insert into staff_memberships (user_id, hospital_id, branch_id, role) values
      (${ownerId}, ${hospitalId}, ${branchId}, 'owner'),
      (${nurseId}, ${hospitalId}, ${branchId}, 'nurse'),
      (${deskId}, ${hospitalId}, ${branchId}, 'receptionist')`;
    ({ cookieValue, deviceId } = await registerWardDevice({
      hospitalId,
      branchId,
      label: 'Ward A tablet',
      actorUserId: ownerId,
    }));
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@warddevice.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('recognises the device from its cookie, and nothing else', async () => {
    const device = await resolveWardDevice(cookieValue);
    expect(device).toMatchObject({ id: deviceId, label: 'Ward A tablet' });
    expect(await resolveWardDevice(`${hospitalId}.${'x'.repeat(43)}`)).toBeNull();
    const [row] = await admin`select token_hash from ward_devices where id = ${deviceId}`;
    expect(cookieValue.endsWith(row.token_hash)).toBe(false);
  });

  it('refuses an obvious PIN, and lists only people who have set one', async () => {
    await expect(setOwnPin({ hospitalId, userId: nurseId, pin: '1234' })).rejects.toBeInstanceOf(WardDeviceError);
    await setOwnPin({ hospitalId, userId: nurseId, pin: '4829' });
    await setOwnPin({ hospitalId, userId: deskId, pin: '7351' });
    const device = (await resolveWardDevice(cookieValue))!;
    const people = await listPinPeople(device);
    expect(people.map((p) => p.name).sort()).toEqual(['Desk Ravi', 'Sister Anita']);
  });

  it('unlocks a nurse-only session tied to the device — even for the desk', async () => {
    const device = (await resolveWardDevice(cookieValue))!;
    const result = await unlockWithPin({ device, userId: deskId, pin: '7351' });
    expect(result.ok).toBe(true);
    const token = (result as { sessionToken: string }).sessionToken;
    expect(token.startsWith('w_')).toBe(true);

    const session = await resolveSession(token);
    expect(session).toMatchObject({ userId: deskId, role: 'nurse', wardDeviceId: deviceId });
    const [row] = await admin`
      select expires_at from sessions where ward_device_id = ${deviceId} and user_id = ${deskId}`;
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5_000);
  });

  it('locks a person on the device after five wrong PINs, even for the right one', async () => {
    const device = (await resolveWardDevice(cookieValue))!;
    for (let i = 1; i < MAX_PIN_FAILURES; i += 1) {
      const wrong = await unlockWithPin({ device, userId: nurseId, pin: '0001' });
      expect(wrong).toMatchObject({ ok: false, error: 'Wrong PIN' });
    }
    const fifth = await unlockWithPin({ device, userId: nurseId, pin: '0001' });
    expect(fifth.ok).toBe(false);
    expect((fifth as { lockedUntil?: Date }).lockedUntil).toBeInstanceOf(Date);
    const right = await unlockWithPin({ device, userId: nurseId, pin: '4829' });
    expect(right.ok).toBe(false);

    const later = await unlockWithPin({ device, userId: nurseId, pin: '4829', now: new Date(Date.now() + 16 * 60_000) });
    expect(later.ok).toBe(true);
  });

  it('ends every session on the device when it is revoked', async () => {
    const device = (await resolveWardDevice(cookieValue))!;
    const result = await unlockWithPin({ device, userId: deskId, pin: '7351' });
    const token = (result as { sessionToken: string }).sessionToken;
    await revokeWardDevice({ hospitalId, deviceId, actorUserId: ownerId });
    expect(await resolveSession(token)).toBeNull();
    expect(await resolveWardDevice(cookieValue)).toBeNull();
  });
});
