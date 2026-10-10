import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { staffPins, wardDevices } from '@/lib/db/schema';
import { hashPassword } from '@/lib/security/password';
import { invalidateSessionCache, login, resolveSession, setStaffActive } from '@/lib/services/auth';
import {
  StaffAccessError,
  acceptMonitoringNotice,
  createWardDevice,
  enrolWardDevice,
  lockSession,
  resolveWardDevice,
  revokeWardDevice,
  setOwnPin,
  signOutEverywhere,
  unlockSession,
  unlockWardDevice,
  updateAccessSettings,
  type WardDevice,
} from '@/lib/services/staff-access';

/**
 * Phase A5-min against a real database (ADR-022, migration 0042): tablet
 * enrolment, PIN sessions that are the person's and capped to ward work, both
 * lock-outs, the server-held lock on personal phones, the per-role access
 * rules, revocation and the monitoring notice.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Staff Access Test Hospital';
const PASSWORD = 'correct horse battery';

describe.skipIf(!enabled)('staff access (0042)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const otherHospitalId = uuid();
  const branchId = uuid();
  const otherBranchId = uuid();
  const ownerId = uuid();
  const nurseId = uuid();
  const doctorId = uuid();
  const deskId = uuid();
  const emails: Record<string, string> = {};

  const addStaff = async (userId: string, role: string, name: string) => {
    emails[userId] = `${role}-${userId.slice(0, 8)}@staffaccess.test`;
    await admin`insert into users (id, email, password_hash, name, last_login_at)
      values (${userId}, ${emails[userId]}, ${await hashPassword(PASSWORD)}, ${name}, now())`;
    await admin`insert into staff_memberships (user_id, hospital_id, branch_id, role, active)
      values (${userId}, ${hospitalId}, null, ${role}::staff_role, true)`;
  };

  let device: WardDevice;
  let deviceCookie: string;

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values
      (${hospitalId}, ${HOSPITAL_NAME}, ${'sa-' + hospitalId.slice(0, 12)}),
      (${otherHospitalId}, ${HOSPITAL_NAME}, ${'sa-' + otherHospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values
      (${branchId}, ${hospitalId}, 'Main'), (${otherBranchId}, ${otherHospitalId}, 'Other')`;
    await addStaff(ownerId, 'owner', 'Owner Pawara');
    await addStaff(nurseId, 'nurse', 'Nurse Sunita');
    await addStaff(doctorId, 'doctor', 'Doctor Patil');
    await addStaff(deskId, 'receptionist', 'Desk Mane');
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@staffaccess.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  const setLastSeen = async (token: string, minutesAgo: number) => {
    await admin`update sessions set last_seen_at = now() - make_interval(mins => ${minutesAgo}),
                created_at = least(created_at, now() - make_interval(mins => ${minutesAgo}))
                where token_hash = encode(sha256(convert_to(${token}, 'UTF8')), 'hex')`;
    invalidateSessionCache();
  };

  it('enrols a tablet with a one-time code, and refuses it a second time', async () => {
    const created = await createWardDevice({ hospitalId, branchId, name: 'Ward A tablet', wardIds: [], actorUserId: ownerId });
    expect(created.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(await enrolWardDevice('WRONG123')).toBeNull();

    const enrolled = await enrolWardDevice(`${created.code.slice(0, 4)}-${created.code.slice(4).toLowerCase()}`);
    expect(enrolled?.deviceName).toBe('Ward A tablet');
    expect(await enrolWardDevice(created.code)).toBeNull();

    deviceCookie = enrolled!.cookieValue;
    device = (await resolveWardDevice(deviceCookie))!;
    expect(device).toMatchObject({ hospitalId, branchId, name: 'Ward A tablet' });
    expect(await resolveWardDevice(`${hospitalId}.${'x'.repeat(43)}`)).toBeNull();
  });

  it('refuses an expired code', async () => {
    const created = await createWardDevice({ hospitalId, branchId, name: 'Old tablet', wardIds: [], actorUserId: ownerId });
    await admin`update ward_devices set enrol_expires_at = now() - interval '1 minute' where id = ${created.deviceId}`;
    expect(await enrolWardDevice(created.code)).toBeNull();
  });

  it('sets a PIN only with the password, and refuses obvious PINs', async () => {
    await expect(setOwnPin({ hospitalId, userId: nurseId, pin: '7391', password: 'wrong' })).rejects.toThrow(/password/);
    await expect(setOwnPin({ hospitalId, userId: nurseId, pin: '1234', password: PASSWORD })).rejects.toThrow(StaffAccessError);
    await setOwnPin({ hospitalId, userId: nurseId, pin: '7391', password: PASSWORD });
    await setOwnPin({ hospitalId, userId: ownerId, pin: '5820', password: PASSWORD });
    await setOwnPin({ hospitalId, userId: doctorId, pin: '6047', password: PASSWORD });
  });

  it('opens a ward session that is the person’s, capped to ward work', async () => {
    const nurse = await unlockWardDevice({ device, userId: nurseId, pin: '7391' });
    expect(nurse.ok).toBe(true);
    const token = (nurse as { sessionToken: string }).sessionToken;
    expect(token.startsWith('w_')).toBe(true);
    expect(await resolveSession(token)).toMatchObject({ userId: nurseId, channel: 'ward_device', role: 'nurse', wardDeviceId: device.id, deviceId: device.id });

    const owner = await unlockWardDevice({ device, userId: ownerId, pin: '5820' });
    const ownerSession = await resolveSession((owner as { sessionToken: string }).sessionToken);
    // The owner works as a doctor on a shared tablet: no settings, prices or money.
    expect(ownerSession).toMatchObject({ role: 'doctor', personRole: 'owner' });
  });

  it('refuses reception on a tablet by default, and someone who has not used their password for 30 days', async () => {
    const desk = await unlockWardDevice({ device, userId: deskId, pin: '0000' });
    expect(desk.ok).toBe(false);
    await admin`update users set last_login_at = now() - interval '31 days' where id = ${doctorId}`;
    const stale = await unlockWardDevice({ device, userId: doctorId, pin: '6047' });
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/30 days/) });
    await admin`update users set last_login_at = now() where id = ${doctorId}`;
  });

  it('locks a person after five wrong PINs, on every device', async () => {
    for (let i = 0; i < 4; i++) {
      expect(await unlockWardDevice({ device, userId: doctorId, pin: '1111' })).toMatchObject({ ok: false, error: 'Wrong PIN' });
    }
    expect(await unlockWardDevice({ device, userId: doctorId, pin: '1111' })).toMatchObject({ ok: false, error: expect.stringMatching(/15 minutes/) });
    // Even the right PIN is refused while locked.
    expect(await unlockWardDevice({ device, userId: doctorId, pin: '6047' })).toMatchObject({ ok: false });
    await admin`update staff_pins set locked_until = null, failed_count = 0 where user_id = ${doctorId}`;
  });

  it('locks the tablet after twenty wrong PINs in an hour', async () => {
    const created = await createWardDevice({ hospitalId, branchId, name: 'Guessed tablet', wardIds: [], actorUserId: ownerId });
    const enrolled = await enrolWardDevice(created.code);
    const guessed = (await resolveWardDevice(enrolled!.cookieValue))!;
    let last;
    for (let i = 0; i < 20; i++) last = await unlockWardDevice({ device: guessed, userId: uuid(), pin: '2468' });
    expect(last).toMatchObject({ ok: false, error: expect.stringMatching(/tablet is now locked/) });
    expect(await unlockWardDevice({ device: guessed, userId: nurseId, pin: '7391' })).toMatchObject({ ok: false, error: expect.stringMatching(/tablet is locked/) });
  });

  it('ends a ward session after 10 idle minutes', async () => {
    const result = await unlockWardDevice({ device, userId: nurseId, pin: '7391' });
    const token = (result as { sessionToken: string }).sessionToken;
    await setLastSeen(token, 11);
    expect(await resolveSession(token)).toBeNull();
  });

  it('locks a nurse’s own phone after 15 idle minutes, and unlocks it with the PIN or password', async () => {
    const token = (await login(emails[nurseId], PASSWORD, { deviceId: 'phone-device-0001' }))!;
    expect(await resolveSession(token)).toMatchObject({ channel: 'personal', locked: false, deviceId: 'phone-device-0001' });
    await setLastSeen(token, 16);
    expect(await resolveSession(token)).toMatchObject({ locked: true });

    expect(await unlockSession({ token, method: 'pin', secret: '0000' })).toMatchObject({ ok: false });
    expect(await unlockSession({ token, method: 'pin', secret: '7391' })).toEqual({ ok: true });
    invalidateSessionCache();
    expect(await resolveSession(token)).toMatchObject({ locked: false });

    expect(await lockSession(token, 'background')).toBe('locked');
    expect(await resolveSession(token)).toMatchObject({ locked: true });
    expect(await unlockSession({ token, method: 'password', secret: PASSWORD })).toEqual({ ok: true });
  });

  it('signs an owner out after 8 idle hours instead of locking', async () => {
    const token = (await login(emails[ownerId], PASSWORD))!;
    await setLastSeen(token, 8 * 60 + 1);
    expect(await resolveSession(token)).toBeNull();
  });

  it('ends sessions of a channel the hospital switches off for that role', async () => {
    const token = (await login(emails[doctorId], PASSWORD))!;
    expect(await resolveSession(token)).not.toBeNull();
    await updateAccessSettings({
      hospitalId,
      wardDeviceRoles: ['owner', 'doctor', 'nurse'],
      personalRoles: ['owner', 'receptionist', 'nurse'],
      clinicalLockMinutes: 15,
      monitoringNotice: 'off',
      actorUserId: ownerId,
    });
    expect(await resolveSession(token)).toBeNull();
    await expect(
      updateAccessSettings({ hospitalId, wardDeviceRoles: [], personalRoles: ['owner'], clinicalLockMinutes: 15, monitoringNotice: 'off', actorUserId: ownerId }),
    ).rejects.toThrow(/at least one way/);
    await updateAccessSettings({
      hospitalId,
      wardDeviceRoles: ['owner', 'doctor', 'nurse'],
      personalRoles: ['owner', 'receptionist', 'doctor', 'nurse'],
      clinicalLockMinutes: 15,
      monitoringNotice: 'off',
      actorUserId: ownerId,
    });
  });

  it('asks for the monitoring notice once, when the hospital requires it', async () => {
    await updateAccessSettings({
      hospitalId,
      wardDeviceRoles: ['owner', 'doctor', 'nurse'],
      personalRoles: ['owner', 'receptionist', 'doctor', 'nurse'],
      clinicalLockMinutes: 15,
      monitoringNotice: 'required',
      actorUserId: ownerId,
    });
    const token = (await login(emails[deskId], PASSWORD))!;
    expect(await resolveSession(token)).toMatchObject({ noticePending: true });
    await acceptMonitoringNotice({ hospitalId, userId: deskId, locale: 'mr', channel: 'personal', deviceId: null, token });
    expect(await resolveSession(token)).toMatchObject({ noticePending: false });
  });

  it('signs a removed staff member out at once, and "sign out everywhere" ends every session', async () => {
    const one = (await login(emails[deskId], PASSWORD))!;
    const two = (await login(emails[deskId], PASSWORD))!;
    expect(await signOutEverywhere({ hospitalId, userId: deskId, actorUserId: ownerId })).toBeGreaterThanOrEqual(2);
    expect(await resolveSession(one)).toBeNull();
    expect(await resolveSession(two)).toBeNull();

    const three = (await login(emails[deskId], PASSWORD))!;
    const [membership] = await admin`select id from staff_memberships where user_id = ${deskId}`;
    await setStaffActive({ hospitalId, membershipId: membership.id, active: false });
    const [{ count }] = await admin`select count(*)::int as count from sessions where user_id = ${deskId}`;
    expect(count).toBe(0);
    expect(await resolveSession(three)).toBeNull();
  });

  it('ends every session on a tablet when it is removed', async () => {
    const result = await unlockWardDevice({ device, userId: nurseId, pin: '7391' });
    const token = (result as { sessionToken: string }).sessionToken;
    await revokeWardDevice({ hospitalId, deviceId: device.id, actorUserId: ownerId });
    expect(await resolveSession(token)).toBeNull();
    expect(await resolveWardDevice(deviceCookie)).toBeNull();
  });

  it('keeps one hospital’s tablets and PINs from another (RLS)', async () => {
    const [devices, pins] = await withTenant(otherHospitalId, (tx) =>
      Promise.all([tx.select().from(wardDevices), tx.select().from(staffPins)]),
    );
    expect(devices).toEqual([]);
    expect(pins).toEqual([]);
  });
});
