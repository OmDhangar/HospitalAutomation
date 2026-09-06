import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { getCurrentSubscription } from '@/lib/services/subscriptions';
import { getHospitalUsage, getMessageBreakdown } from '@/lib/services/usage';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const TZ = 'Asia/Kolkata';
const uuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('hospital usage', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 3 }) : (null as never);

  let hospitalId: string;
  let otherHospitalId: string;
  let branchId: string;
  let doctorId: string;
  let patientId: string;
  /** Anchored well in the past so period boundaries can be exercised. */
  const startsAt = new Date('2026-07-10T00:00:00.000Z');

  const seedHospital = async (name: string) => {
    const id = uuid();
    await admin`
      insert into hospitals (id, name, slug, plan_tier_code)
      values (${id}, ${name}, ${'u-' + id.slice(0, 12)}, 'hospital')
    `;
    await admin`
      insert into subscriptions
        (hospital_id, plan_tier_code, billing_cycle, status, price_paise, setup_fee_paise,
         daily_appointment_capacity, included_appointments, included_messages,
         starts_at, ends_at, change_reason)
      values (${id}, 'hospital', 'monthly', 'active', 699900, 500000,
              150, 5300, 21200, ${startsAt}, ${new Date('2027-07-10T00:00:00.000Z')}, 'test')
    `;
    return id;
  };

  /** Writes a completed appointment directly, so the date can be controlled. */
  const completedAppointment = async (args: {
    hospital: string;
    completedAt: Date;
    serviceDate: string;
    token: number;
  }) => {
    await admin`
      insert into appointments
        (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
         status, source, public_token, public_token_expires_at, completed_at)
      values (${args.hospital}, ${branchId}, ${doctorId}, ${patientId},
              ${args.serviceDate}, ${args.token}, 'COMPLETED', 'walk_in',
              ${'tok-' + uuid()}, now() + interval '1 day', ${args.completedAt})
    `;
  };

  const sentMessage = async (args: {
    hospital: string;
    sentAt: Date;
    templateCode: string;
    milestone: string;
    status?: string;
  }) => {
    await admin`
      insert into notification_outbox
        (hospital_id, milestone, template_code, locale, payload, status, sent_at)
      values (${args.hospital}, ${args.milestone}, ${args.templateCode}, 'en', '{}'::jsonb,
              ${args.status ?? 'sent'}, ${args.sentAt})
    `;
  };

  beforeEach(async () => {
    hospitalId = await seedHospital('Usage Hospital');
    otherHospitalId = await seedHospital('Usage Hospital');

    branchId = uuid();
    doctorId = uuid();
    patientId = uuid();
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Test')
    `;
    await admin`
      insert into patients (id, hospital_id, phone_e164, name)
      values (${patientId}, ${hospitalId}, ${'+9199' + Date.now().toString().slice(-8)}, 'Test Patient')
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = 'Usage Hospital'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('reports the tier allowances from the subscription, not the live rate card', async () => {
    const usage = await getHospitalUsage({ hospitalId, timezone: TZ });

    expect(usage.today.allowance).toBe(150);
    expect(usage.appointments.allowance).toBe(5_300);
    expect(usage.messages.allowance).toBe(21_200);
  });

  it('starts every axis at zero for a hospital that has done nothing', async () => {
    const usage = await getHospitalUsage({ hospitalId, timezone: TZ });

    expect(usage.appointments.used).toBe(0);
    expect(usage.messages.used).toBe(0);
    expect(usage.appointments.remaining).toBe(5_300);
    expect(usage.messagesPerAppointment).toBeNull();
  });

  /**
   * The property the whole billing model rests on: usage must land in exactly
   * one period. An appointment completed in the previous window must not
   * consume this window's allowance.
   */
  it('counts only the current billing period', async () => {
    const now = new Date('2026-09-20T10:00:00.000Z');
    // Period runs 10 Sept – 10 Oct for a 10 July anchor.
    await completedAppointment({
      hospital: hospitalId,
      completedAt: new Date('2026-09-15T10:00:00.000Z'),
      serviceDate: '2026-09-15',
      token: 1,
    });
    // Previous period — must be excluded.
    await completedAppointment({
      hospital: hospitalId,
      completedAt: new Date('2026-08-20T10:00:00.000Z'),
      serviceDate: '2026-08-20',
      token: 2,
    });

    const usage = await getHospitalUsage({ hospitalId, timezone: TZ, now });

    expect(usage.period?.start.toISOString()).toContain('2026-09-10');
    expect(usage.appointments.used).toBe(1);
  });

  it('rolls into a new period without any reset having to run', async () => {
    await completedAppointment({
      hospital: hospitalId,
      completedAt: new Date('2026-09-15T10:00:00.000Z'),
      serviceDate: '2026-09-15',
      token: 1,
    });

    const during = await getHospitalUsage({
      hospitalId,
      timezone: TZ,
      now: new Date('2026-09-20T10:00:00.000Z'),
    });
    const after = await getHospitalUsage({
      hospitalId,
      timezone: TZ,
      now: new Date('2026-10-20T10:00:00.000Z'),
    });

    expect(during.appointments.used).toBe(1);
    // Same data, later moment: the previous period's usage simply is not in
    // this one. Nothing was zeroed; the window moved.
    expect(after.appointments.used).toBe(0);
  });

  it('counts only messages that were actually sent', async () => {
    const now = new Date('2026-09-20T10:00:00.000Z');
    const sentAt = new Date('2026-09-15T10:00:00.000Z');

    await sentMessage({ hospital: hospitalId, sentAt, templateCode: 'queue_link', milestone: 'queue_link' });
    await sentMessage({ hospital: hospitalId, sentAt, templateCode: 'queue_link', milestone: 'x', status: 'failed' });
    await sentMessage({ hospital: hospitalId, sentAt, templateCode: 'queue_link', milestone: 'y', status: 'suppressed' });

    const usage = await getHospitalUsage({ hospitalId, timezone: TZ, now });

    // Meta bills on delivery. A failed or suppressed message reached nobody and
    // must not consume the hospital's allowance.
    expect(usage.messages.used).toBe(1);
  });

  it('keeps one hospital out of another hospital total', async () => {
    const now = new Date('2026-09-20T10:00:00.000Z');
    const sentAt = new Date('2026-09-15T10:00:00.000Z');

    await sentMessage({ hospital: hospitalId, sentAt, templateCode: 'queue_link', milestone: 'a' });
    for (let i = 0; i < 5; i += 1) {
      await sentMessage({
        hospital: otherHospitalId,
        sentAt,
        templateCode: 'queue_link',
        milestone: `other-${i}`,
      });
    }

    const mine = await getHospitalUsage({ hospitalId, timezone: TZ, now });
    const theirs = await getHospitalUsage({ hospitalId: otherHospitalId, timezone: TZ, now });

    expect(mine.messages.used).toBe(1);
    expect(theirs.messages.used).toBe(5);
  });

  it('computes messages per appointment from real activity', async () => {
    const now = new Date('2026-09-20T10:00:00.000Z');
    const at = new Date('2026-09-15T10:00:00.000Z');

    await completedAppointment({
      hospital: hospitalId,
      completedAt: at,
      serviceDate: '2026-09-15',
      token: 1,
    });
    for (let i = 0; i < 3; i += 1) {
      await sentMessage({
        hospital: hospitalId,
        sentAt: at,
        templateCode: 'queue_link',
        milestone: `m-${i}`,
      });
    }

    const usage = await getHospitalUsage({ hospitalId, timezone: TZ, now });
    expect(usage.messagesPerAppointment).toBe(3);
  });

  it('breaks messages down by what they were for', async () => {
    const at = new Date('2026-09-15T10:00:00.000Z');
    await sentMessage({ hospital: hospitalId, sentAt: at, templateCode: 'queue_link', milestone: 'queue_link' });
    await sentMessage({ hospital: hospitalId, sentAt: at, templateCode: 'queue_milestone', milestone: 'queue_ahead_4' });
    await sentMessage({ hospital: hospitalId, sentAt: at, templateCode: 'conversation', milestone: 'conversation:doctor' });

    const breakdown = await getMessageBreakdown({
      hospitalId,
      from: new Date('2026-09-10T00:00:00.000Z'),
      to: new Date('2026-10-10T00:00:00.000Z'),
    });

    const byCategory = Object.fromEntries(breakdown.map((r) => [r.category, r.messages]));
    expect(byCategory.appointment_confirmation).toBe(1);
    expect(byCategory.queue_notification).toBe(1);
    expect(byCategory.booking_conversation).toBe(1);
  });

  it('gives a hospital with no subscription zeroes rather than invented allowances', async () => {
    const bare = uuid();
    await admin`
      insert into hospitals (id, name, slug) values (${bare}, 'Usage Hospital', ${'b-' + bare.slice(0, 12)})
    `;

    const usage = await getHospitalUsage({ hospitalId: bare, timezone: TZ });

    expect(usage.subscription).toBeNull();
    expect(usage.appointments.allowance).toBe(0);
    expect(usage.appointments.percent).toBeNull();
    expect(await getCurrentSubscription(bare)).toBeNull();
  });
});
