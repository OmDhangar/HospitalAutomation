import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { notificationOutbox, queueEvents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  advanceQueue,
  applyQueueAction,
  createWalkIn,
  getPublicQueueView,
  getQueueSnapshot,
  setDoctorPaused,
  setPriority,
} from '@/lib/services/queue';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const TZ = 'Asia/Kolkata';
const uuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('queue engine', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 4 }) : (null as never);
  let hospitalId: string;
  let branchId: string;
  let doctorId: string;

  const walkIn = (n: number) =>
    createWalkIn({
      hospitalId,
      branchId,
      doctorId,
      timezone: TZ,
      patient: { phoneE164: `+9199000000${String(n).padStart(2, '0')}`, name: `Patient ${n}` },
    });

  beforeEach(async () => {
    hospitalId = uuid();
    branchId = uuid();
    doctorId = uuid();
    await admin`
      insert into hospitals (id, name, slug)
      values (${hospitalId}, 'Test Hospital', ${'t-' + hospitalId.slice(0, 12)})
    `;
    await admin`
      insert into branches (id, hospital_id, name)
      values (${branchId}, ${hospitalId}, 'Main')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Kulkarni', 10)
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = 'Test Hospital'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('allocates unique sequential tokens when five patients register at once', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(walkIn));
    const tokens = results.map((r) => r.tokenNumber).sort((a, b) => a - b);

    expect(tokens).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(tokens).size).toBe(5);
  });

  it('advances exactly N positions for N concurrent Next clicks', async () => {
    for (const n of [1, 2, 3, 4, 5]) await walkIn(n);

    // Three receptionists press Next at the same instant.
    await Promise.all([
      advanceQueue({ hospitalId, doctorId, timezone: TZ }),
      advanceQueue({ hospitalId, doctorId, timezone: TZ }),
      advanceQueue({ hospitalId, doctorId, timezone: TZ }),
    ]);

    const snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;

    // Advance 1 calls token 1. Advances 2 and 3 each complete the current
    // patient and call the next, so exactly two consultations have finished.
    expect(snapshot.completedCount).toBe(2);
    expect(snapshot.currentToken).toBe(3);
    expect(snapshot.waitingCount).toBe(2);
  });

  it('records one queue event per transition, with no phantom advances', async () => {
    for (const n of [1, 2, 3]) await walkIn(n);
    await Promise.all([
      advanceQueue({ hospitalId, doctorId, timezone: TZ }),
      advanceQueue({ hospitalId, doctorId, timezone: TZ }),
    ]);

    const events = await withTenant(hospitalId, (tx) =>
      tx.select().from(queueEvents).where(eq(queueEvents.doctorId, doctorId)),
    );

    const calls = events.filter((e) => e.action === 'call');
    const completes = events.filter((e) => e.action === 'complete');
    expect(calls).toHaveLength(2);
    expect(completes).toHaveLength(1);
  });

  it('queues a milestone at most once however many times the queue moves', async () => {
    for (const n of [1, 2, 3] as const) await walkIn(n);
    for (let i = 0; i < 3; i += 1) {
      await advanceQueue({ hospitalId, doctorId, timezone: TZ });
    }

    const rows = await withTenant(hospitalId, (tx) =>
      tx
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.hospitalId, hospitalId)),
    );

    const milestones = rows.filter(
      (r) => r.milestone.startsWith('queue_ahead_') && r.appointmentId !== null,
    );
    const perAppointment = new Map<string, number>();
    for (const row of milestones) {
      const key = row.appointmentId!;
      perAppointment.set(key, (perAppointment.get(key) ?? 0) + 1);
    }
    expect([...perAppointment.values()].every((count) => count === 1)).toBe(true);
  });

  it('queues exactly one booking link per appointment', async () => {
    const { appointment } = await walkIn(1);
    const rows = await withTenant(hospitalId, (tx) =>
      tx
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.appointmentId, appointment.id)),
    );
    expect(rows.filter((r) => r.milestone === 'queue_link')).toHaveLength(1);
  });

  describe('consent', () => {
    const outboxFor = (appointmentId: string) =>
      withTenant(hospitalId, (tx) =>
        tx
          .select()
          .from(notificationOutbox)
          .where(eq(notificationOutbox.appointmentId, appointmentId)),
      );

    it('sends nothing to a patient who did not agree to WhatsApp', async () => {
      const { appointment } = await createWalkIn({
        hospitalId,
        branchId,
        doctorId,
        timezone: TZ,
        patient: { phoneE164: '+919900001111', name: 'No Consent' },
        whatsappOptIn: false,
      });

      // The token still exists and the printed QR still works; we simply do
      // not message them.
      expect(await outboxFor(appointment.id)).toHaveLength(0);
    });

    it('skips milestones too, not just the first message', async () => {
      const declined = await createWalkIn({
        hospitalId,
        branchId,
        doctorId,
        timezone: TZ,
        patient: { phoneE164: '+919900002222', name: 'Also No' },
        whatsappOptIn: false,
      });
      await advanceQueue({ hospitalId, doctorId, timezone: TZ });

      expect(await outboxFor(declined.appointment.id)).toHaveLength(0);
    });

    it('does not re-date consent given on an earlier visit', async () => {
      const first = await createWalkIn({
        hospitalId,
        branchId,
        doctorId,
        timezone: TZ,
        patient: { phoneE164: '+919900003333', name: 'Repeat Patient' },
        whatsappOptIn: true,
      });

      const [before] = await admin`
        select whatsapp_opt_in_at from patients where phone_e164 = '+919900003333'
      `;

      await applyQueueAction({
        hospitalId,
        appointmentId: first.appointment.id,
        action: 'cancel',
        timezone: TZ,
      });
      await createWalkIn({
        hospitalId,
        branchId,
        doctorId,
        timezone: TZ,
        patient: { phoneE164: '+919900003333', name: 'Repeat Patient' },
        whatsappOptIn: true,
      });

      const [after] = await admin`
        select whatsapp_opt_in_at from patients where phone_e164 = '+919900003333'
      `;
      expect(after.whatsapp_opt_in_at).toEqual(before.whatsapp_opt_in_at);
    });
  });

  it('keeps token numbers stable when someone cancels', async () => {
    const created = [];
    for (const n of [1, 2, 3]) created.push(await walkIn(n));

    await applyQueueAction({
      hospitalId,
      appointmentId: created[0].appointment.id,
      action: 'cancel',
      timezone: TZ,
    });

    const snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
    expect(snapshot.rows.map((r) => r.tokenNumber)).toEqual([2, 3]);
    expect(snapshot.waitingCount).toBe(2);
  });

  it('recalls a skipped patient without losing their token', async () => {
    const created = [];
    for (const n of [1, 2]) created.push(await walkIn(n));

    await applyQueueAction({
      hospitalId,
      appointmentId: created[0].appointment.id,
      action: 'skip',
      timezone: TZ,
    });
    let snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
    expect(snapshot.waitingCount).toBe(1);

    await applyQueueAction({
      hospitalId,
      appointmentId: created[0].appointment.id,
      action: 'recall',
      timezone: TZ,
    });
    snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
    expect(snapshot.waitingCount).toBe(2);
    expect(snapshot.rows.find((r) => r.tokenNumber === 1)?.status).toBe('WAITING');
  });

  it('lets a priority insert jump the waiting line', async () => {
    const created = [];
    for (const n of [1, 2, 3]) created.push(await walkIn(n));

    await setPriority({
      hospitalId,
      appointmentId: created[2].appointment.id,
      priority: 10,
    });

    const snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
    expect(snapshot.rows[0].tokenNumber).toBe(3);
  });

  describe("the doctor's break", () => {
    /**
     * Times are pinned relative to one instant rather than read off the clock,
     * so "a 30-minute break" is exactly that. Everything sits in the past hour
     * to stay on today's service date.
     */
    const minutesAgo = (base: Date, n: number) => new Date(base.getTime() - n * 60_000);

    /** Now, unless that is within an hour of IST midnight; then an hour past it. */
    const pinnedBase = () => {
      const now = new Date();
      const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
      return istMinutes < 60 ? new Date(now.getTime() + (60 - istMinutes) * 60_000) : now;
    };

    it('keeps the break out of the consultation it interrupted', async () => {
      const base = pinnedBase();
      await walkIn(1);
      await walkIn(2);

      // Token 1 is called, then the doctor steps out with them still CALLED.
      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: minutesAgo(base, 50) });
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: true, now: minutesAgo(base, 45) });
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: false, now: minutesAgo(base, 15) });
      // Back from the break, the doctor finishes token 1 and calls token 2.
      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: minutesAgo(base, 10) });

      const [row] = await admin<{ minutes: number }[]>`
        select extract(epoch from (completed_at - consult_started_at)) / 60 as minutes
        from appointments
        where hospital_id = ${hospitalId} and token_number = 1
      `;
      // 40 minutes elapsed between call and completion; 30 of them were the break.
      expect(Math.round(Number(row.minutes))).toBe(10);
    });

    it('shifts an open consultation by the break, and nothing else', async () => {
      const base = pinnedBase();
      const first = await walkIn(1);
      await walkIn(2);

      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: minutesAgo(base, 50) });
      await applyQueueAction({
        hospitalId,
        appointmentId: first.appointment.id,
        action: 'start_consultation',
        timezone: TZ,
        now: minutesAgo(base, 48),
      });
      // Pressing "Start break" twice must not move the start of the break.
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: true, now: minutesAgo(base, 45) });
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: true, now: minutesAgo(base, 30) });
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: false, now: minutesAgo(base, 25) });

      const rows = await admin<{ token_number: number; called_at: Date | null; consult_started_at: Date | null }[]>`
        select token_number, called_at, consult_started_at
        from appointments
        where hospital_id = ${hospitalId}
        order by token_number
      `;
      // A 20-minute break, from 45 to 25 minutes ago.
      expect(rows[0].consult_started_at?.getTime()).toBe(minutesAgo(base, 28).getTime());
      // calledAt is the end of the patient's wait, which the break did not change.
      expect(rows[0].called_at?.getTime()).toBe(minutesAgo(base, 50).getTime());
      // Token 2 was only waiting: untouched.
      expect(rows[1].called_at).toBeNull();
      expect(rows[1].consult_started_at).toBeNull();
    });

    it('tells waiting patients the doctor is on a break, and since when', async () => {
      const base = pinnedBase();
      await walkIn(1);
      const second = await walkIn(2);
      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: minutesAgo(base, 20) });
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: true, now: minutesAgo(base, 10) });

      const view = (await getPublicQueueView(second.publicToken))!;
      expect(view.paused).toBe(true);
      expect(view.breakStartedAt?.getTime()).toBe(minutesAgo(base, 10).getTime());
      expect(view.patientsAhead).toBe(0);
      expect(view.eta).toBeNull();

      const snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ }))!;
      expect(snapshot.breakStartedAt?.getTime()).toBe(minutesAgo(base, 10).getTime());

      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: false, now: base });
      const after = (await getPublicQueueView(second.publicToken))!;
      expect(after.paused).toBe(false);
      expect(after.breakStartedAt).toBeNull();
    });
  });

  describe('the patient view', () => {
    it('shows position and an ETA range, and never names other patients', async () => {
      const first = await walkIn(1);
      for (const n of [2, 3]) await walkIn(n);

      const third = await walkIn(4);
      const view = (await getPublicQueueView(third.publicToken))!;

      expect(view.tokenNumber).toBe(4);
      expect(view.patientsAhead).toBe(3);
      expect(view.doctorName).toBe('Dr Kulkarni');
      expect(view.patientFirstName).toBe('Patient');
      expect(view.eta).not.toBeNull();
      expect(view.eta!.windowEnd.getTime()).toBeGreaterThan(view.eta!.windowStart.getTime());

      // Nothing in the payload identifies anybody else.
      expect(JSON.stringify(view)).not.toContain(first.appointment.id);
    });

    it('returns null for an unknown token rather than leaking existence', async () => {
      expect(await getPublicQueueView('not-a-real-token')).toBeNull();
    });

    it('reports an expired link instead of stale live data', async () => {
      const { publicToken, appointment } = await walkIn(1);
      await admin`
        update appointments set public_token_expires_at = now() - interval '1 hour'
        where id = ${appointment.id}
      `;

      const view = (await getPublicQueueView(publicToken))!;
      expect(view.expired).toBe(true);
      expect(view.eta).toBeNull();
    });

    it('withholds an ETA while the doctor is paused', async () => {
      const { publicToken } = await walkIn(1);
      await admin`
        update doctor_day_states set paused = true where doctor_id = ${doctorId}
      `;

      const view = (await getPublicQueueView(publicToken))!;
      expect(view.paused).toBe(true);
      expect(view.eta).toBeNull();
      expect(view.patientsAhead).toBe(0);
    });
  });
});
