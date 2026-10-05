import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { appointments, auditLogs, doctorDayStates } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  CapacityError,
  getDayCapacity,
  releaseReservedWalkIns,
  saveDoctorCapacity,
} from '@/lib/services/capacity';
import {
  advanceQueue,
  applyQueueAction,
  createWalkIn,
  getPublicQueueView,
  getQueueSnapshot,
  resumeByPublicToken,
  setDoctorPaused,
  setPriority,
  startSession,
  SessionNotStartedError,
} from '@/lib/services/queue';
import { serviceDateIn } from '@/lib/domain/time';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const TZ = 'Asia/Kolkata';
const uuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('arrival, priority and capacity', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 4 }) : (null as never);
  let hospitalId: string;
  let branchId: string;
  let doctorId: string;
  let phoneSeq = 0;

  const book = (source: 'walk_in' | 'whatsapp', opts: { extra?: boolean; now?: Date } = {}) => {
    phoneSeq += 1;
    return createWalkIn({
      hospitalId,
      branchId,
      doctorId,
      timezone: TZ,
      source,
      extraToken: opts.extra,
      now: opts.now,
      patient: { phoneE164: `+9198${String(phoneSeq).padStart(8, '0')}`, name: `Patient ${phoneSeq}` },
    });
  };

  const tokensOf = async () =>
    withTenant(hospitalId, (tx) =>
      tx
        .select({ id: appointments.id, token: appointments.tokenNumber, status: appointments.status })
        .from(appointments)
        .where(eq(appointments.doctorId, doctorId)),
    );

  /** Gives the doctor a schedule so start-time rules have something to anchor to. */
  const scheduleStartingAt = async (hhmm: string) => {
    await admin`delete from doctor_schedules where doctor_id = ${doctorId}`;
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      await admin`
        insert into doctor_schedules (hospital_id, doctor_id, weekday, mode, start_time, end_time, effective_from)
        values (${hospitalId}, ${doctorId}, ${weekday}, 'queue', ${hhmm}, '23:59', '2020-01-01')
      `;
    }
  };

  beforeEach(async () => {
    hospitalId = uuid();
    branchId = uuid();
    doctorId = uuid();
    await admin`
      insert into hospitals (id, name, slug)
      values (${hospitalId}, 'Arrival Test Hospital', ${'a-' + hospitalId.slice(0, 12)})
    `;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Patil', 10)
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = 'Arrival Test Hospital'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  describe('one waiting queue', () => {
    it('every booking enters WAITING and Next calls them in order, no check-in needed', async () => {
      await book('whatsapp'); // token 1
      await book('walk_in'); // token 2
      const result = await advanceQueue({ hospitalId, doctorId, timezone: TZ });
      const called = result.transitions.find((t) => t.action === 'call')!;
      expect((await tokensOf()).find((r) => r.id === called.appointmentId)?.token).toBe(1);
    });

    it('a patient who is not there is put on hold, leaves the line, and is resumed with their token', async () => {
      const a = await book('walk_in'); // 1
      await book('walk_in'); // 2
      await advanceQueue({ hospitalId, doctorId, timezone: TZ }); // calls 1
      await applyQueueAction({ hospitalId, appointmentId: a.appointment.id, action: 'hold', timezone: TZ });

      let snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
      expect(snapshot.parked.map((r) => r.tokenNumber)).toEqual([1]);
      expect(snapshot.completed).toHaveLength(0); // not moved to history

      expect(await resumeByPublicToken({ publicToken: a.publicToken })).toMatchObject({ outcome: 'resumed' });
      const view = (await getPublicQueueView(a.publicToken))!;
      expect(view).toMatchObject({ status: 'WAITING', tokenNumber: 1 });
      snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
      expect(snapshot.parked).toHaveLength(0);
    });

    it('a concurrent resume and Next never leave the queue inconsistent', async () => {
      const a = await book('walk_in');
      await book('walk_in');
      await applyQueueAction({ hospitalId, appointmentId: a.appointment.id, action: 'hold', timezone: TZ });
      await Promise.all([
        resumeByPublicToken({ publicToken: a.publicToken }),
        advanceQueue({ hospitalId, doctorId, timezone: TZ }),
      ]);
      const rows = await tokensOf();
      expect(rows.filter((r) => r.status === 'CALLED')).toHaveLength(1);
      expect(rows.map((r) => r.token).sort()).toEqual([1, 2]);
    });
  });

  describe('late return', () => {
    it('a held patient who comes back after their turn goes behind the next two waiting, tokens unchanged', async () => {
      const first = await book('walk_in'); // 1
      await book('walk_in'); // 2
      await book('walk_in'); // 3
      await book('walk_in'); // 4
      await book('walk_in'); // 5

      await advanceQueue({ hospitalId, doctorId, timezone: TZ }); // calls 1 — not there
      await applyQueueAction({ hospitalId, appointmentId: first.appointment.id, action: 'hold', timezone: TZ });
      await advanceQueue({ hospitalId, doctorId, timezone: TZ }); // calls 2

      // Token 1 returns while 2 is with the doctor: frontier 2 > 1, so late.
      await applyQueueAction({ hospitalId, appointmentId: first.appointment.id, action: 'resume', timezone: TZ });

      const called: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await advanceQueue({ hospitalId, doctorId, timezone: TZ });
        const call = r.transitions.find((t) => t.action === 'call');
        if (call) called.push((await tokensOf()).find((x) => x.id === call.appointmentId)!.token);
      }
      expect(called).toEqual([3, 4, 1, 5]);
      expect((await tokensOf()).map((r) => r.token).sort()).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('FIFO priority', () => {
    it('concurrent priority clicks get distinct places, and a repeat click keeps its place', async () => {
      const a = await book('walk_in');
      const b = await book('walk_in');
      const c = await book('walk_in');

      await Promise.all([
        setPriority({ hospitalId, appointmentId: c.appointment.id, priority: 10 }),
        setPriority({ hospitalId, appointmentId: b.appointment.id, priority: 10 }),
      ]);
      const seqs = await withTenant(hospitalId, (tx) =>
        tx.select({ id: appointments.id, seq: appointments.prioritySeq }).from(appointments).where(eq(appointments.doctorId, doctorId)),
      );
      const bSeq = seqs.find((r) => r.id === b.appointment.id)!.seq!;
      const cSeq = seqs.find((r) => r.id === c.appointment.id)!.seq!;
      expect(new Set([bSeq, cSeq]).size).toBe(2);

      const again = await setPriority({ hospitalId, appointmentId: b.appointment.id, priority: 10 });
      expect(again.changed).toBe(false);
      expect(again.prioritySeq).toBe(bSeq);

      // Later priority (a) does not overtake earlier ones.
      await setPriority({ hospitalId, appointmentId: a.appointment.id, priority: 10 });
      const snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
      const firstTwo = snapshot.rows.slice(0, 2).map((r) => r.appointmentId);
      expect(firstTwo).toEqual(bSeq < cSeq ? [b.appointment.id, c.appointment.id] : [c.appointment.id, b.appointment.id]);
      expect(snapshot.rows[2].appointmentId).toBe(a.appointment.id);
      expect(snapshot.rows[2].priorityRank).toBe(3);
    });
  });

  describe('quota', () => {
    const configure = (quota: number, reserved: number, extra: Partial<{ opens: number; release: number | null }> = {}) =>
      saveDoctorCapacity({
        hospitalId,
        doctorId,
        config: {
          dailyQuota: quota,
          walkInReserved: reserved,
          onlineOpensMinutesBefore: extra.opens ?? 120,
          walkInReleaseMinutes: extra.release ?? null,
        },
      });

    it('reserved walk-ins take 1..W; online starts at W+1; extra walk-ins share the pool', async () => {
      expect(await configure(6, 2)).toMatchObject({ ok: true });
      const w1 = await book('walk_in');
      const o1 = await book('whatsapp');
      const w2 = await book('walk_in');
      const w3 = await book('walk_in');
      expect([w1.tokenNumber, o1.tokenNumber, w2.tokenNumber, w3.tokenNumber]).toEqual([1, 3, 2, 4]);
      expect(w3.appointment.quotaPool).toBe('shared');
    });

    it('the last shared place goes to exactly one of two concurrent bookings', async () => {
      await configure(3, 1);
      await book('walk_in'); // reserved 1
      await book('whatsapp'); // shared 2
      const results = await Promise.allSettled([book('whatsapp'), book('whatsapp')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(CapacityError);
    });

    it('online is blocked by unreleased reserve; release opens it without handing out reserved numbers', async () => {
      await configure(3, 2);
      await book('walk_in'); // 1 (reserved)
      await book('whatsapp'); // 3 (shared)
      await expect(book('whatsapp')).rejects.toMatchObject({ code: 'FULLY_BOOKED' });
      // An extra is not allowed while total active < Q.
      await expect(book('walk_in', { extra: true })).rejects.toMatchObject({ code: 'EXTRA_NOT_NEEDED' });

      const before = (await getDayCapacity({ hospitalId, doctorId, timezone: TZ }))!;
      expect(before.onlineBlockedByReserve).toBe(true);

      await releaseReservedWalkIns({ hospitalId, doctorId, timezone: TZ });
      await releaseReservedWalkIns({ hospitalId, doctorId, timezone: TZ }); // idempotent
      const next = await book('whatsapp');
      expect(next.tokenNumber).toBe(4);
    });

    it('scheduled start passing does not release the reserve; walk-ins keep 1..W until Start OPD', async () => {
      await scheduleStartingAt('00:01'); // long past, as in a late or forgotten Start OPD
      await saveDoctorCapacity({
        hospitalId,
        doctorId,
        config: { dailyQuota: 70, walkInReserved: 20, onlineOpensMinutesBefore: 120, walkInReleaseMinutes: 0 },
      });
      const first = await book('walk_in');
      expect(first.tokenNumber).toBe(1);
      expect(first.appointment.quotaPool).toBe('reserved');
      expect((await getDayCapacity({ hospitalId, doctorId, timezone: TZ }))!.released).toBe(false);

      await startSession({ hospitalId, doctorId, timezone: TZ });
      expect((await getDayCapacity({ hospitalId, doctorId, timezone: TZ }))!.released).toBe(true);
      expect((await book('walk_in')).tokenNumber).toBe(21);
    });

    it('Start OPD releases unused reserved walk-in places to online, without handing out reserved numbers', async () => {
      await configure(3, 2);
      await book('walk_in'); // 1 (reserved)
      await book('whatsapp'); // 3 (shared)
      await expect(book('whatsapp')).rejects.toMatchObject({ code: 'FULLY_BOOKED' });

      await startSession({ hospitalId, doctorId, timezone: TZ });
      const next = await book('whatsapp');
      expect(next.tokenNumber).toBe(4);
      expect(next.appointment.quotaPool).toBe('shared');

      const [audit] = await withTenant(hospitalId, (tx) =>
        tx.select({ metadata: auditLogs.metadata }).from(auditLogs).where(eq(auditLogs.action, 'opd.session.started')),
      );
      expect(audit.metadata).toMatchObject({ reserved_unused_released: 1 });
    });

    it('extra tokens only once the quota is reached, continuing the sequence and audited', async () => {
      await configure(2, 1);
      await book('walk_in'); // 1
      await book('walk_in'); // 2 (shared)
      await expect(book('walk_in')).rejects.toMatchObject({ code: 'QUOTA_REACHED' });
      const extra = await book('walk_in', { extra: true });
      expect(extra.tokenNumber).toBe(3);
      expect(extra.appointment.quotaPool).toBe('extra');

      const audits = await withTenant(hospitalId, (tx) =>
        tx.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.objectId, extra.appointment.id)),
      );
      expect(audits.map((a) => a.action)).toContain('capacity.extra_token.issued');
    });

    it('a quota above the plan is saved while trial mode is on, flagged not refused', async () => {
      const [tier] = await admin<{ code: string }[]>`select code from plan_tiers limit 1`;
      await admin`
        insert into subscriptions (hospital_id, plan_tier_code, price_paise, daily_appointment_capacity,
                                   included_appointments, included_messages, starts_at, ends_at)
        values (${hospitalId}, ${tier.code}, 0, 50, 1000, 1000, now(), now() + interval '30 days')
      `;
      const result = await configure(120, 20);
      expect(result).toMatchObject({ ok: true, abovePlan: true, planDailyCapacity: 50 });
    });

    it('rejects reserved walk-ins above the quota', async () => {
      expect(await configure(5, 6)).toMatchObject({ ok: false });
    });

    it('changing the quota mid-day leaves the day in progress alone', async () => {
      await configure(3, 1);
      await book('walk_in'); // 1 reserved, snapshot taken
      await configure(10, 5);
      const next = await book('whatsapp');
      expect(next.tokenNumber).toBe(2); // still W=1 for today
      const [day] = await withTenant(hospitalId, (tx) =>
        tx.select().from(doctorDayStates).where(eq(doctorDayStates.doctorId, doctorId)),
      );
      expect(day.tokenQuota).toBe(3);
    });

    it('a doctor without a quota keeps the old unlimited behaviour', async () => {
      const tokens = [];
      for (let i = 0; i < 4; i += 1) tokens.push((await book(i % 2 ? 'whatsapp' : 'walk_in')).tokenNumber);
      expect(tokens).toEqual([1, 2, 3, 4]);
      expect(await getDayCapacity({ hospitalId, doctorId, timezone: TZ })).toBeNull();
    });

    it('same-day online queue booking waits for the opening window', async () => {
      // Start the doctor three hours from now; online opens two hours before.
      const now = new Date();
      const startAt = new Date(now.getTime() + 3 * 60 * 60_000);
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(startAt);
      // Skip near midnight, where "three hours from now" is tomorrow.
      if (serviceDateIn(TZ, startAt) !== serviceDateIn(TZ, now)) return;
      await scheduleStartingAt(hhmm);
      await configure(10, 2);
      await expect(book('whatsapp')).rejects.toMatchObject({ code: 'ONLINE_NOT_OPEN' });
      expect((await book('walk_in')).tokenNumber).toBe(1);
    });
  });

  describe('call numbers', () => {
    it('are issued 1, 2, 3 in serving order while tokens stay untouched', async () => {
      const t1 = await book('whatsapp'); // token 1
      const t2 = await book('walk_in'); // token 2
      const t3 = await book('walk_in'); // token 3
      await setPriority({ hospitalId, appointmentId: t3.appointment.id, priority: 10 });

      await advanceQueue({ hospitalId, doctorId, timezone: TZ }); // priority token 3 → call 1
      let snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
      expect(snapshot.currentToken).toBe(3);
      expect(snapshot.currentCallNumber).toBe(1);
      // Tokens 1 and 2 will be calls 2 and 3.
      expect(snapshot.rows.find((r) => r.tokenNumber === 1)?.callNumber).toBe(2);
      expect(snapshot.rows.find((r) => r.tokenNumber === 2)?.callNumber).toBe(3);

      let view = (await getPublicQueueView(t1.publicToken))!;
      expect(view).toMatchObject({ tokenNumber: 1, callNumber: 2, currentCallNumber: 1 });

      // Token 1 is on hold: no call number while away; token 2 moves up to call 2.
      await applyQueueAction({ hospitalId, appointmentId: t1.appointment.id, action: 'hold', timezone: TZ });
      view = (await getPublicQueueView(t1.publicToken))!;
      expect(view.callNumber).toBeNull();
      view = (await getPublicQueueView(t2.publicToken))!;
      expect(view).toMatchObject({ tokenNumber: 2, callNumber: 2 });

      await advanceQueue({ hospitalId, doctorId, timezone: TZ });
      snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
      expect(snapshot.currentToken).toBe(2);
      expect(snapshot.currentCallNumber).toBe(2);
    });

    it('concurrent Next presses never share a call number', async () => {
      for (let i = 0; i < 4; i += 1) await book('walk_in');
      await Promise.all([1, 2, 3].map(() => advanceQueue({ hospitalId, doctorId, timezone: TZ })));
      const rows = await withTenant(hospitalId, (tx) =>
        tx.select({ n: appointments.callNumber }).from(appointments).where(eq(appointments.doctorId, doctorId)),
      );
      const issued = rows.map((r) => r.n).filter((n): n is number => n !== null).sort();
      expect(issued).toEqual([1, 2, 3]);
    });
  });

  describe('Start OPD', () => {
    it('is the only thing that starts the session; Next and breaks never do', async () => {
      await book('walk_in');
      await advanceQueue({ hospitalId, doctorId, timezone: TZ });
      await expect(setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: true })).rejects.toBeInstanceOf(
        SessionNotStartedError,
      );
      let snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
      expect(snapshot.sessionStartedAt).toBeNull();

      const first = await startSession({ hospitalId, doctorId, timezone: TZ });
      const second = await startSession({ hospitalId, doctorId, timezone: TZ });
      expect(second.alreadyStarted).toBe(true);
      expect(second.sessionStartedAt.getTime()).toBe(first.sessionStartedAt.getTime());

      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: true });
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: false });
      snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
      expect(snapshot.sessionStartedAt?.getTime()).toBe(first.sessionStartedAt.getTime());
      expect(snapshot.etaState).toBe('live');
    });
  });
});
