import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import {
  appointments,
  billItems,
  bills,
  blackoutPeriods,
  encounters,
  notificationOutbox,
  patients,
  queueEvents,
} from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { serviceDateIn } from '@/lib/domain/time';
import {
  previewBlackoutDisruption,
  createBlackoutPeriodAndNotify,
  cancelBlackoutPeriod,
  listBlackoutPeriods,
} from '@/lib/services/blackout';
import { resolveOpdClosure } from '@/lib/services/opd-hours';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const TZ = 'Asia/Kolkata';
const uuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('blackout service integration', () => {
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
      values (${hospitalId}, 'Test Blackout Hospital', ${'tb-' + hospitalId.slice(0, 12)}, ${TZ})
    `;
    await admin`
      insert into branches (id, hospital_id, name)
      values (${branchId}, ${hospitalId}, 'Main Branch')
    `;
    await admin`
      insert into users (id, email, password_hash, name)
      values (${userId}, ${'doc-' + userId.slice(0, 8) + '@test.com'}, 'hash', 'Dr Admin User')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, user_id, name, active)
      values
        (${doctorId1}, ${hospitalId}, ${branchId}, ${userId}, 'Dr Alpha', true),
        (${doctorId2}, ${hospitalId}, ${branchId}, null, 'Dr Beta', true)
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = 'Test Blackout Hospital'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  const createPatient = async (phone: string, optIn = true) => {
    const id = uuid();
    await admin`
      insert into patients (id, hospital_id, name, phone_e164, whatsapp_opt_in_at, locale)
      values (${id}, ${hospitalId}, 'Patient Test', ${phone}, ${optIn ? new Date() : null}, 'en')
    `;
    return id;
  };

  const createAppointment = async (args: {
    doctorId: string;
    patientId: string;
    serviceDate: string;
    status: string;
    tokenNumber: number;
  }) => {
    const id = uuid();
    await admin`
      insert into appointments
        (id, hospital_id, branch_id, doctor_id, patient_id, service_date,
         token_number, status, source, public_token, public_token_expires_at)
      values
        (${id}, ${hospitalId}, ${branchId}, ${args.doctorId}, ${args.patientId},
         ${args.serviceDate}, ${args.tokenNumber}, ${args.status}, 'walk_in', ${'tok-' + id},
         now() + interval '1 day')
    `;
    return id;
  };

  it('1. previewBlackoutDisruption correctly partitions cancellable vs non-cancellable appointments', async () => {
    const now = new Date('2026-10-24T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);

    const p1 = await createPatient('+919876543211', true);
    const p2 = await createPatient('+919876543212', true);
    const p3 = await createPatient('+919876543213', false);
    const p4 = await createPatient('+919876543214', true);
    const p5 = await createPatient('+919876543215', true);
    const p6 = await createPatient('+919876543216', true);

    // Today appointments
    const aWaiting = await createAppointment({ doctorId: doctorId1, patientId: p1, serviceDate: today, status: 'WAITING', tokenNumber: 1 });
    const aSkipped = await createAppointment({ doctorId: doctorId1, patientId: p2, serviceDate: today, status: 'SKIPPED', tokenNumber: 2 });
    const aHeld = await createAppointment({ doctorId: doctorId1, patientId: p3, serviceDate: today, status: 'HELD', tokenNumber: 3 });
    const aCalled = await createAppointment({ doctorId: doctorId1, patientId: p4, serviceDate: today, status: 'CALLED', tokenNumber: 4 });
    const aInConsult = await createAppointment({ doctorId: doctorId1, patientId: p5, serviceDate: today, status: 'IN_CONSULTATION', tokenNumber: 5 });
    const aCompleted = await createAppointment({ doctorId: doctorId1, patientId: p6, serviceDate: today, status: 'COMPLETED', tokenNumber: 6 });

    // Future date appointments
    const tomorrow = '2026-10-25';
    const p7 = await createPatient('+919876543217', true);
    const p8 = await createPatient('+919876543218', true);
    const aFutureWaiting = await createAppointment({ doctorId: doctorId1, patientId: p7, serviceDate: tomorrow, status: 'WAITING', tokenNumber: 1 });
    const aFutureConfirmed = await createAppointment({ doctorId: doctorId1, patientId: p8, serviceDate: tomorrow, status: 'CONFIRMED', tokenNumber: 2 });

    const preview = await previewBlackoutDisruption({
      hospitalId,
      branchId,
      startDate: today,
      endDate: tomorrow,
      now,
      timezone: TZ,
    });

    expect(preview.totalAppointments).toBe(8);
    // Cancellable: today (WAITING, SKIPPED, HELD = 3) + tomorrow (WAITING, CONFIRMED = 2) = 5
    expect(preview.willCancel).toBe(5);
    // In-consultation or done: today CALLED, IN_CONSULTATION, COMPLETED = 3
    expect(preview.inConsultationOrDone).toBe(3);
    // Message count: only opted-in patients among willCancel (aWaiting, aSkipped, aFutureWaiting, aFutureConfirmed = 4)
    expect(preview.messageCount).toBe(4);
  });

  it('2. createBlackoutPeriodAndNotify cancels appointments via state machine, records queue_events, and creates outbox rows', async () => {
    const now = new Date('2026-10-24T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);

    const pOptIn = await createPatient('+919876543220', true);
    const pCalled = await createPatient('+919876543221', true);
    const pNoOpt = await createPatient('+919876543222', false);

    const apptWaiting = await createAppointment({ doctorId: doctorId1, patientId: pOptIn, serviceDate: today, status: 'WAITING', tokenNumber: 1 });
    const apptCalled = await createAppointment({ doctorId: doctorId1, patientId: pCalled, serviceDate: today, status: 'CALLED', tokenNumber: 2 });
    const apptHeld = await createAppointment({ doctorId: doctorId1, patientId: pNoOpt, serviceDate: today, status: 'HELD', tokenNumber: 3 });

    // Seed encounter and bill item for apptWaiting (NH4)
    const serviceId = uuid();
    await admin`
      insert into services (id, hospital_id, kind, name, doctor_id, selling_price_paise)
      values (${serviceId}, ${hospitalId}, 'consultation', 'Consultation', ${doctorId1}, 50000)
    `;

    const encounterId = uuid();
    const billId = uuid();
    const billItemId = uuid();
    await admin`
      insert into encounters (id, hospital_id, branch_id, patient_id, appointment_id, attending_doctor_id, origin, status)
      values (${encounterId}, ${hospitalId}, ${branchId}, ${pOptIn}, ${apptWaiting}, ${doctorId1}, 'queue', 'open')
    `;
    await admin`
      insert into bills (id, hospital_id, encounter_id, patient_id, status)
      values (${billId}, ${hospitalId}, ${encounterId}, ${pOptIn}, 'draft')
    `;
    await admin`
      insert into bill_items (id, hospital_id, bill_id, item_type, service_id, appointment_id, description, quantity, unit_price_paise, total_paise, subtotal_paise)
      values (${billItemId}, ${hospitalId}, ${billId}, 'consultation', ${serviceId}, ${apptWaiting}, 'Consultation Fee', 1, 50000, 50000, 50000)
    `;

    const result = await createBlackoutPeriodAndNotify({
      hospitalId,
      branchId,
      startDate: today,
      endDate: today,
      reopenDate: '2026-10-25',
      reason: 'Diwali Festival',
      publicReason: 'Closed for Diwali',
      actorUserId: userId,
      now,
      timezone: TZ,
    });

    expect(result.cancelledCount).toBe(2); // apptWaiting and apptHeld
    expect(result.notifiedCount).toBe(1); // only pOptIn for apptWaiting

    // Verify appointment statuses
    const [w] = await admin<{ status: string }[]>`select status from appointments where id = ${apptWaiting}`;
    const [c] = await admin<{ status: string }[]>`select status from appointments where id = ${apptCalled}`;
    const [h] = await admin<{ status: string }[]>`select status from appointments where id = ${apptHeld}`;

    expect(w.status).toBe('CANCELLED');
    expect(c.status).toBe('CALLED'); // Untouched!
    expect(h.status).toBe('CANCELLED');

    // Verify queue_events written
    const events = await withTenant(hospitalId, (tx) =>
      tx.select().from(queueEvents).where(eq(queueEvents.appointmentId, apptWaiting)),
    );
    expect(events.length).toBe(1);
    expect(events[0].action).toBe('cancel');
    expect(events[0].fromStatus).toBe('WAITING');
    expect(events[0].toStatus).toBe('CANCELLED');
    expect((events[0].metadata as any)?.reason).toBe('blackout');
    expect((events[0].metadata as any)?.blackout_id).toBe(result.blackoutId);

    // Verify bill_item voided (NH4)
    const [voidedItem] = await admin<{ voided_at: Date | null; void_reason: string | null }[]>`
      select voided_at, void_reason from bill_items where id = ${billItemId}
    `;
    expect(voidedItem.voided_at).not.toBeNull();
    expect(voidedItem.void_reason).toBe('blackout');

    // Verify outbox notice queued
    const outboxRows = await withTenant(hospitalId, (tx) =>
      tx.select().from(notificationOutbox).where(eq(notificationOutbox.appointmentId, apptWaiting)),
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].milestone).toBe('appointment_cancelled:blackout');
    expect(outboxRows[0].templateCode).toBe('appointment_cancelled');
  });

  it('3. doctor-specific blackout isolates cancellations to target doctor', async () => {
    const now = new Date('2026-10-24T10:00:00+05:30');
    const today = serviceDateIn(TZ, now);

    const p = await createPatient('+919876543230', true);

    const apptDoc1 = await createAppointment({ doctorId: doctorId1, patientId: p, serviceDate: today, status: 'WAITING', tokenNumber: 1 });
    const apptDoc2 = await createAppointment({ doctorId: doctorId2, patientId: p, serviceDate: today, status: 'WAITING', tokenNumber: 1 });

    const result = await createBlackoutPeriodAndNotify({
      hospitalId,
      branchId,
      doctorId: doctorId1,
      startDate: today,
      endDate: today,
      reopenDate: '2026-10-25',
      reason: 'Doctor on leave',
      publicReason: 'Dr Alpha on leave',
      actorUserId: userId,
      now,
      timezone: TZ,
    });

    expect(result.cancelledCount).toBe(1);

    const [d1] = await admin<{ status: string }[]>`select status from appointments where id = ${apptDoc1}`;
    const [d2] = await admin<{ status: string }[]>`select status from appointments where id = ${apptDoc2}`;

    expect(d1.status).toBe('CANCELLED');
    expect(d2.status).toBe('WAITING'); // Doc2 untouched!
  });

  it('4. overlapping active blackout creation is rejected with validation error (NB4)', async () => {
    const now = new Date('2026-10-24T10:00:00+05:30');

    await createBlackoutPeriodAndNotify({
      hospitalId,
      branchId,
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      reopenDate: '2026-11-06',
      reason: 'Maintenance',
      actorUserId: userId,
      now,
      timezone: TZ,
    });

    // Overlapping blackout
    await expect(
      createBlackoutPeriodAndNotify({
        hospitalId,
        branchId,
        startDate: '2026-11-03',
        endDate: '2026-11-07',
        reopenDate: '2026-11-08',
        reason: 'Extended Maintenance',
        actorUserId: userId,
        now,
        timezone: TZ,
      }),
    ).rejects.toThrow(/already covers part of this date range/i);
  });

  it('5. cancelBlackoutPeriod revokes blackout and immediately unblocks intake', async () => {
    const now = new Date('2026-10-24T10:00:00+05:30');

    const created = await createBlackoutPeriodAndNotify({
      hospitalId,
      branchId,
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      reopenDate: '2026-11-13',
      reason: 'Conference',
      actorUserId: userId,
      now,
      timezone: TZ,
    });

    // Verify it is closed
    const closed = await resolveOpdClosure({
      hospitalId,
      doctorId: doctorId1,
      branchId,
      serviceDate: '2026-11-11',
      now,
      timezone: TZ,
    });
    expect(closed.isClosed).toBe(true);

    // Cancel / revoke blackout
    await cancelBlackoutPeriod({
      hospitalId,
      blackoutId: created.blackoutId,
      actorUserId: userId,
      now,
    });

    // Verify it is now open
    const reopened = await resolveOpdClosure({
      hospitalId,
      doctorId: doctorId1,
      branchId,
      serviceDate: '2026-11-11',
      now,
      timezone: TZ,
    });
    expect(reopened.isClosed).toBe(false);
    expect(reopened.closureType).toBe('none');
  });

  it('6. listBlackoutPeriods returns active and past blackouts with doctor/branch scope', async () => {
    const now = new Date('2026-10-24T10:00:00+05:30');

    await createBlackoutPeriodAndNotify({
      hospitalId,
      branchId,
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      reopenDate: '2026-12-03',
      reason: 'Winter Break',
      publicReason: 'Clinic Closed for Winter Break',
      actorUserId: userId,
      now,
      timezone: TZ,
    });

    const list = await listBlackoutPeriods({ hospitalId });
    expect(list.length).toBe(1);
    expect(list[0].startDate).toBe('2026-12-01');
    expect(list[0].endDate).toBe('2026-12-02');
    expect(list[0].reopenDate).toBe('2026-12-03');
    expect(list[0].reason).toBe('Winter Break');
    expect(list[0].publicReason).toBe('Clinic Closed for Winter Break');
    expect(list[0].cancelledAt).toBeNull();
  });
});
