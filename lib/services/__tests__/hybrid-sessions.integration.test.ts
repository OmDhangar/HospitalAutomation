import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { doctorDayStates } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  advanceQueue,
  createWalkIn,
  estimateForNewJoiner,
  getPublicQueueView,
  getQueueSnapshot,
  setDoctorPaused,
  startSession,
} from '@/lib/services/queue';
import { enqueueSlotSessionBookings } from '@/lib/services/sweeps';
import { BookingError, bookScheduledSlot, bookSlotForWalkIn } from '@/lib/services/web-booking';
import { serviceDateIn, zonedTimeToUtc } from '@/lib/domain/time';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const TZ = 'Asia/Kolkata';
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Hybrid Session Test Hospital';

describe.skipIf(!enabled)('pace and the hybrid queue + slot day', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 4 }) : (null as never);
  let hospitalId: string;
  let branchId: string;
  let doctorId: string;
  let phoneSeq = 0;

  // A fixed day (tomorrow, in the hospital's timezone) and explicit clocks, so
  // the tests do not depend on what time of day they run.
  const DAY = serviceDateIn(TZ, new Date(Date.now() + 24 * 60 * 60 * 1000));
  const at = (hhmm: string) => zonedTimeToUtc(DAY, hhmm, TZ);
  const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

  const join = (source: 'walk_in' | 'whatsapp', now: Date) => {
    phoneSeq += 1;
    return createWalkIn({
      hospitalId,
      branchId,
      doctorId,
      timezone: TZ,
      source,
      now,
      patient: { phoneE164: `+9197${String(phoneSeq).padStart(8, '0')}`, name: `Patient ${phoneSeq}` },
    });
  };

  const dayRow = async () => {
    const [row] = await withTenant(hospitalId, (tx) =>
      tx
        .select()
        .from(doctorDayStates)
        .where(and(eq(doctorDayStates.doctorId, doctorId), eq(doctorDayStates.serviceDate, DAY))),
    );
    return row;
  };

  /** Live queue 12:00-19:00, then booked slots only 20:00-22:00, every weekday. */
  const splitDay = async () => {
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      await admin`
        insert into doctor_schedules (hospital_id, doctor_id, weekday, mode, start_time, end_time, slot_minutes, effective_from)
        values
          (${hospitalId}, ${doctorId}, ${weekday}, 'queue', '12:00', '19:00', 10, '2020-01-01'),
          (${hospitalId}, ${doctorId}, ${weekday}, 'slot', '20:00', '22:00', 10, '2020-01-01')
      `;
    }
  };

  beforeEach(async () => {
    hospitalId = uuid();
    branchId = uuid();
    doctorId = uuid();
    await admin`
      insert into hospitals (id, name, slug)
      values (${hospitalId}, ${HOSPITAL_NAME}, ${'h-' + hospitalId.slice(0, 12)})
    `;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Deshmukh', 10)
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await Promise.all([admin.end(), closeDb()]);
  });

  describe('pace', () => {
    it('is measured call to call on the day row, by the update Next already makes', async () => {
      const t0 = at('10:00');
      for (let i = 0; i < 4; i += 1) await join('walk_in', t0);

      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: plus(t0, 1) });
      // First call of the day: nothing to measure yet.
      expect((await dayRow()).paceSamples).toBe(0);

      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: plus(t0, 13) });
      const row = await dayRow();
      expect(row.paceSamples).toBe(1);
      expect(row.paceMinutes).toBeCloseTo(12, 5);

      // Blended with the configured 10 minutes until there is more evidence.
      const snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ, now: plus(t0, 13) }))!;
      expect(snapshot.paceMinutes).toBeCloseTo((5 * 10 + 12) / 6, 5);
      expect(snapshot.paceSamples).toBe(1);
    });

    it('a break is never a sample, and neither is a gap over an hour', async () => {
      const t0 = at('10:00');
      for (let i = 0; i < 4; i += 1) await join('walk_in', t0);
      await startSession({ hospitalId, doctorId, timezone: TZ, now: t0 });

      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: plus(t0, 1) });
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: true, now: plus(t0, 2) });
      await setDoctorPaused({ hospitalId, doctorId, timezone: TZ, paused: false, now: plus(t0, 30) });
      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: plus(t0, 35) });
      expect((await dayRow()).paceSamples).toBe(0);

      await advanceQueue({ hospitalId, doctorId, timezone: TZ, now: plus(t0, 35 + 61) });
      expect((await dayRow()).paceSamples).toBe(0);
    });
  });

  describe('estimates for a patient asking on WhatsApp', () => {
    it('count from the scheduled start before OPD, not "~5 min"', async () => {
      await splitDay();
      for (let i = 0; i < 3; i += 1) await join('walk_in', at('09:30'));
      const now = at('10:00');
      const snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ, now }))!;
      const eta = estimateForNewJoiner(snapshot, now);
      expect(eta.state).toBe('planned');
      if (eta.state === 'not_started') throw new Error('unexpected');
      // Two hours to the 12:00 start, then three patients at 10 minutes.
      expect(eta.waitMinutes).toBe(150);
    });
  });

  describe('split day', () => {
    it('closes the live queue at the end of its session, for online and the desk alike', async () => {
      await splitDay();
      expect((await join('whatsapp', at('13:00'))).tokenNumber).toBe(1);
      await expect(join('whatsapp', at('19:30'))).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
      await expect(join('walk_in', at('19:30'))).rejects.toMatchObject({ code: 'QUEUE_CLOSED' });
    });

    it('books an evening slot as S-numbered and CONFIRMED, without touching the queue tokens', async () => {
      await splitDay();
      const booked = await bookScheduledSlot({
        hospitalId,
        doctorId,
        patientName: 'Evening Patient',
        phoneE164: '+919700000901',
        slotDatetimeIso: at('20:10').toISOString(),
      });
      expect(booked.tokenNumber).toBe(2);
      expect(booked.tokenLabel).toBe('S2');
      expect(booked.appointment).toMatchObject({ status: 'CONFIRMED', sessionKind: 'slot', quotaPool: null });
      expect(booked.appointment.enqueuedAt).toBeNull();

      // The day's live-queue numbering is untouched: the first walk-in is still token 1.
      expect((await join('walk_in', at('13:00'))).tokenNumber).toBe(1);
      expect((await dayRow()).lastCallNumber).toBe(0);

      // The slot can be held once.
      await expect(
        bookScheduledSlot({
          hospitalId,
          doctorId,
          patientName: 'Second Patient',
          phoneE164: '+919700000902',
          slotDatetimeIso: at('20:10').toISOString(),
        }),
      ).rejects.toBeInstanceOf(BookingError);

      const view = (await getPublicQueueView(booked.publicToken, at('15:00')))!;
      expect(view).toMatchObject({ tokenLabel: 'S2', sessionKind: 'slot', patientsAhead: null, eta: null });
    });

    it('slot patients join at session start and are seen after the afternoon line, in slot order', async () => {
      await splitDay();
      const late = await join('walk_in', at('18:50'));
      const s3 = await bookScheduledSlot({
        hospitalId,
        doctorId,
        patientName: 'Third Slot',
        phoneE164: '+919700000903',
        slotDatetimeIso: at('20:20').toISOString(),
      });
      const s1 = await bookScheduledSlot({
        hospitalId,
        doctorId,
        patientName: 'First Slot',
        phoneE164: '+919700000904',
        slotDatetimeIso: at('20:00').toISOString(),
      });

      expect(await enqueueSlotSessionBookings(at('19:59'))).toBe(0);
      expect(await enqueueSlotSessionBookings(at('20:00'))).toBe(2);
      // Idempotent: the sweep runs every minute.
      expect(await enqueueSlotSessionBookings(at('20:01'))).toBe(0);

      const snapshot = (await getQueueSnapshot({ hospitalId, doctorId, timezone: TZ, now: at('20:01') }))!;
      expect(snapshot.rows.map((r) => r.tokenLabel)).toEqual([String(late.tokenNumber), 'S1', 'S3']);
      expect(snapshot.rows.map((r) => r.appointmentId)).toEqual([
        late.appointment.id,
        s1.appointment.id,
        s3.appointment.id,
      ]);
    });

    it('reception books a walk-in into a free evening slot and checks them in', async () => {
      await splitDay();
      const booked = await bookSlotForWalkIn({
        hospitalId,
        doctorId,
        timezone: TZ,
        slotDatetimeIso: at('20:30').toISOString(),
        patient: { name: 'Desk Patient', phoneE164: '+919700000905' },
        now: at('20:25'),
      });
      expect(booked.tokenLabel).toBe('S4');
      expect(booked.appointment).toMatchObject({ status: 'WAITING', source: 'reception', sessionKind: 'slot' });

      // A slot that has already ended is not offered to the desk.
      await expect(
        bookSlotForWalkIn({
          hospitalId,
          doctorId,
          timezone: TZ,
          slotDatetimeIso: at('20:00').toISOString(),
          patient: { name: 'Too Late', phoneE164: '+919700000906' },
          now: at('20:25'),
        }),
      ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    });
  });
});
