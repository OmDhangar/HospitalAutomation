import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { auditLogs, doctorDayStates } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { serviceDateIn } from '@/lib/domain/time';
import {
  getOpdStopStatus,
  getBatchOpdStopStatus,
  reopenOpdForDoctor,
  resolveOpdClosure,
  stopOpdForBranch,
  stopOpdForDoctor,
} from '@/lib/services/opd-hours';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const TZ = 'Asia/Kolkata';
const uuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('opd-hours service integration', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 4 }) : (null as never);
  let hospitalId: string;
  let branchId: string;
  let doctorId1: string;
  let doctorId2: string;
  let userId: string;

  beforeEach(async () => {
    hospitalId = uuid();
    branchId = uuid();
    doctorId1 = uuid();
    doctorId2 = uuid();
    userId = uuid();

    await admin`
      insert into hospitals (id, name, slug, timezone)
      values (${hospitalId}, 'Test OPD Hospital', ${'t-' + hospitalId.slice(0, 12)}, ${TZ})
    `;
    await admin`
      insert into branches (id, hospital_id, name)
      values (${branchId}, ${hospitalId}, 'Main Branch')
    `;
    await admin`
      insert into users (id, email, password_hash, name)
      values (${userId}, ${'doc-' + userId.slice(0, 8) + '@test.com'}, 'hash', 'Dr Test User')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, user_id, name, active)
      values
        (${doctorId1}, ${hospitalId}, ${branchId}, ${userId}, 'Dr One', true),
        (${doctorId2}, ${hospitalId}, ${branchId}, null, 'Dr Two', true)
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = 'Test OPD Hospital'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('1. stopOpdForDoctor idempotent upsert', async () => {
    const now = new Date('2026-10-23T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);

    const res1 = await stopOpdForDoctor({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      stopAt: now,
      actorUserId: userId,
      reason: 'Staff meeting',
      now,
    });
    expect(res1.stoppedAt).toBeDefined();

    // Second call is idempotent
    const res2 = await stopOpdForDoctor({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      stopAt: now,
      actorUserId: userId,
      reason: 'Updated reason',
      now,
    });
    expect(res2.stoppedAt).toBeDefined();

    const status = await getOpdStopStatus({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      now,
    });
    expect(status.isStopped).toBe(true);
    expect(status.stoppedAt).not.toBeNull();
  });

  it('2. rejects serviceDate != today', async () => {
    const now = new Date('2026-10-23T10:00:00+05:30');
    const tomorrow = '2026-10-24';

    await expect(
      stopOpdForDoctor({
        hospitalId,
        doctorId: doctorId1,
        serviceDate: tomorrow,
        stopAt: now,
        actorUserId: userId,
        now,
      }),
    ).rejects.toThrow(/today/i);
  });

  it('3. rejects stopAt > 5 min in the past', async () => {
    const now = new Date('2026-10-23T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);

    await expect(
      stopOpdForDoctor({
        hospitalId,
        doctorId: doctorId1,
        serviceDate: today,
        stopAt: tenMinAgo,
        actorUserId: userId,
        now,
      }),
    ).rejects.toThrow(/5 minutes/i);
  });

  it('4. accepts future stopAt within today', async () => {
    const now = new Date('2026-10-23T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);
    const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const res = await stopOpdForDoctor({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      stopAt: inTwoHours,
      actorUserId: userId,
      now,
    });
    expect(res.stoppedAt).toBeDefined();

    const status = await getOpdStopStatus({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      now,
    });
    expect(status.isStopped).toBe(false);
    expect(status.scheduled).toBe(true);
    expect(status.stoppedAt?.getTime()).toBe(inTwoHours.getTime());
  });

  it('5. reopenOpdForDoctor on non-existent row succeeds as a clean no-op', async () => {
    const now = new Date('2026-10-23T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);

    await expect(
      reopenOpdForDoctor({
        hospitalId,
        doctorId: doctorId2,
        serviceDate: today,
        actorUserId: userId,
        now,
      }),
    ).resolves.toBeUndefined();
  });

  it('6. reopenOpdForDoctor clears opd_stopped_at and opd_stopped_by_user_id', async () => {
    const now = new Date('2026-10-23T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);

    await stopOpdForDoctor({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      stopAt: now,
      actorUserId: userId,
      now,
    });

    await reopenOpdForDoctor({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      actorUserId: userId,
      now,
    });

    const status = await getOpdStopStatus({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      now,
    });
    expect(status.isStopped).toBe(false);
    expect(status.scheduled).toBe(false);
    expect(status.stoppedAt).toBeNull();
  });

  it('7. stopOpdForBranch upserts all active doctors in branch with 1 audit log row', async () => {
    const now = new Date('2026-10-23T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);

    const res = await stopOpdForBranch({
      hospitalId,
      branchId,
      serviceDate: today,
      stopAt: now,
      actorUserId: userId,
      reason: 'Clinic emergency drill',
      now,
    });

    expect(res.doctorCount).toBe(2);

    const batch = await getBatchOpdStopStatus({
      hospitalId,
      doctorIds: [doctorId1, doctorId2],
      serviceDate: today,
      now,
    });
    expect(batch[doctorId1].isStopped).toBe(true);
    expect(batch[doctorId2].isStopped).toBe(true);

    // Verify exactly 1 audit log row was written with doctorCount in metadata
    const logs = await withTenant(hospitalId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.hospitalId, hospitalId),
            eq(auditLogs.action, 'opd.stop'),
            eq(auditLogs.objectType, 'branch'),
          ),
        ),
    );
    expect(logs.length).toBe(1);
    expect((logs[0].metadata as any)?.doctorCount).toBe(2);
    expect((logs[0].metadata as any)?.reason).toBe('Clinic emergency drill');
  });

  it('8. resolveOpdClosure unifies blackout and stop_today with proper precedence', async () => {
    const now = new Date('2026-10-24T11:00:00+05:30');
    const today = serviceDateIn(TZ, now);

    // Initial state: open
    const openRes = await resolveOpdClosure({
      hospitalId,
      doctorId: doctorId1,
      branchId,
      serviceDate: today,
      now,
      timezone: TZ,
    });
    expect(openRes.isClosed).toBe(false);
    expect(openRes.closureType).toBe('none');

    // Case A: same-day Stop OPD
    await stopOpdForDoctor({
      hospitalId,
      doctorId: doctorId1,
      serviceDate: today,
      stopAt: now,
      actorUserId: userId,
      reason: 'Doctor left clinic',
      now,
    });

    const stopRes = await resolveOpdClosure({
      hospitalId,
      doctorId: doctorId1,
      branchId,
      serviceDate: today,
      now,
      timezone: TZ,
    });
    expect(stopRes.isClosed).toBe(true);
    expect(stopRes.closureType).toBe('stop_today');
    expect(stopRes.stoppedAt).toEqual(now);

    // Case B: blackout period covering future date
    await admin`
      insert into blackout_periods (hospital_id, branch_id, doctor_id, start_date, end_date, reopen_date, reason, public_reason)
      values (${hospitalId}, ${branchId}, null, '2026-10-26', '2026-10-28', '2026-10-29', 'Hospital Renovation', 'Clinic Closed for Renovation')
    `;

    const blackoutRes = await resolveOpdClosure({
      hospitalId,
      doctorId: doctorId1,
      branchId,
      serviceDate: '2026-10-27',
      now,
      timezone: TZ,
    });
    expect(blackoutRes.isClosed).toBe(true);
    expect(blackoutRes.closureType).toBe('blackout');
    expect(blackoutRes.startDate).toBe('2026-10-26');
    expect(blackoutRes.endDate).toBe('2026-10-28');
    expect(blackoutRes.reopenDate).toBe('2026-10-29');
    expect(blackoutRes.publicReason).toBe('Clinic Closed for Renovation');
    expect(blackoutRes.isMultiDay).toBe(true);

    // Case C: Overlapping blackouts pick the latest end_date (NB2)
    await admin`
      insert into blackout_periods (hospital_id, branch_id, doctor_id, start_date, end_date, reopen_date, reason, public_reason)
      values (${hospitalId}, ${branchId}, null, '2026-10-27', '2026-10-30', '2026-10-31', 'Extended Renovation', 'Extended Renovation Notice')
    `;

    const overlapRes = await resolveOpdClosure({
      hospitalId,
      doctorId: doctorId1,
      branchId,
      serviceDate: '2026-10-27',
      now,
      timezone: TZ,
    });
    expect(overlapRes.closureType).toBe('blackout');
    expect(overlapRes.endDate).toBe('2026-10-30');
    expect(overlapRes.reopenDate).toBe('2026-10-31');
  });
});

