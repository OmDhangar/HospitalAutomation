import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// throttle.ts reads request headers; outside a request there are none.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { closeDb } from '@/lib/db';
import { serviceDateIn } from '@/lib/domain/time';
import { consumeThrottle } from '@/lib/security/throttle';
import { createStaffUser, StaffAccountError } from '@/lib/services/auth';
import { createHospital } from '@/lib/services/platform';
import { getDoctorSlotsForDate } from '@/lib/services/scheduling';
import { bookScheduledSlot, BookingError } from '@/lib/services/web-booking';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const uuid = () => crypto.randomUUID();
const TZ = 'Asia/Kolkata';

/**
 * Regression tests for the security audit fixes that only show up against a
 * real database: the account-claiming takeover, throttling, and the public
 * booking endpoint accepting any timestamp.
 */
describe.skipIf(!enabled)('security fixes', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 3 }) : (null as never);
  let hospitalId: string;
  let doctorId: string;
  /** Tomorrow in IST, so every slot in the schedule is still in the future. */
  let tomorrow: string;

  beforeEach(async () => {
    hospitalId = uuid();
    doctorId = uuid();
    const branchId = uuid();
    tomorrow = serviceDateIn(TZ, new Date(Date.now() + 24 * 60 * 60 * 1000));

    await admin`
      insert into hospitals (id, name, slug)
      values (${hospitalId}, 'Security Test Hospital', ${'sec-' + hospitalId.slice(0, 10)})
    `;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Secure')
    `;
    await admin`
      insert into doctor_schedules
        (hospital_id, doctor_id, weekday, mode, start_time, end_time, slot_minutes, effective_from)
      values
        (${hospitalId}, ${doctorId}, extract(dow from ${tomorrow}::date)::smallint, 'slot',
         '09:00', '17:00', 15, current_date)
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name in ('Security Test Hospital', 'Takeover Target')`;
    await admin`delete from users where email like '%@security-test.invalid'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  describe('a login cannot be claimed in advance', () => {
    const seedLogin = async (email: string) => {
      await admin`
        insert into users (email, password_hash, name)
        values (${email}, 'scrypt$00$00', 'Someone Else')
      `;
    };

    it('refuses to add staff under an email that already has a login', async () => {
      const email = `claimed-${uuid().slice(0, 8)}@security-test.invalid`;
      await seedLogin(email);

      await expect(
        createStaffUser({ hospitalId, email, name: 'New Hire', role: 'receptionist', password: 'a-strong-temp-pw' }),
      ).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });
    });

    it('refuses to onboard a hospital under a claimed owner email, creating nothing', async () => {
      const email = `owner-${uuid().slice(0, 8)}@security-test.invalid`;
      await seedLogin(email);

      await expect(
        createHospital({ name: 'Takeover Target', ownerName: 'Owner', ownerEmail: email }),
      ).rejects.toBeInstanceOf(StaffAccountError);

      const [{ count }] = await admin<{ count: number }[]>`
        select count(*)::int as count from hospitals where name = 'Takeover Target'
      `;
      expect(count).toBe(0);
    });

    it('refuses a weak or retired temporary password', async () => {
      for (const password of ['Staff@123', 'short']) {
        await expect(
          createStaffUser({
            hospitalId,
            email: `weak-${uuid().slice(0, 8)}@security-test.invalid`,
            name: 'New Hire',
            role: 'receptionist',
            password,
          }),
        ).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
      }
    });
  });

  describe('throttling', () => {
    it('allows up to the limit, then refuses, across calls', async () => {
      const key = `test:${uuid()}`;
      const rule = [{ key, limit: 2, windowMs: 60_000 }];

      expect(await consumeThrottle(rule)).toBe(true);
      expect(await consumeThrottle(rule)).toBe(true);
      expect(await consumeThrottle(rule)).toBe(false);
    });

    it('stores a hash, never the key itself', async () => {
      const key = `test:someone@security-test.invalid:${uuid()}`;
      await consumeThrottle([{ key, limit: 5, windowMs: 60_000 }]);

      const rows = await admin<{ key_hash: string }[]>`
        select key_hash from rate_limit_events order by id desc limit 5
      `;
      expect(rows.some((r) => r.key_hash.includes('security-test'))).toBe(false);
    });
  });

  describe('public booking', () => {
    const book = (slotDatetimeIso: string, phone = '+919800000001') =>
      bookScheduledSlot({
        hospitalId,
        doctorId,
        patientName: 'Test Patient',
        phoneE164: phone,
        slotDatetimeIso,
      });

    it('refuses a time outside the schedule', async () => {
      // 03:00 IST tomorrow: the doctor works 09:00 to 17:00.
      const threeAm = new Date(`${tomorrow}T03:00:00+05:30`).toISOString();
      await expect(book(threeAm)).rejects.toBeInstanceOf(BookingError);
    });

    it('refuses a time in the past', async () => {
      const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      await expect(book(past)).rejects.toBeInstanceOf(BookingError);
    });

    it('refuses a time too far ahead', async () => {
      const farAhead = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
      await expect(book(farAhead)).rejects.toMatchObject({ code: 'TOO_FAR_AHEAD' });
    });

    it('books a real free slot once, and refuses the same slot a second time', async () => {
      const { slots } = await getDoctorSlotsForDate({ hospitalId, doctorId, serviceDate: tomorrow });
      const free = slots.find((s) => s.available);
      expect(free).toBeDefined();

      const first = await book(free!.datetimeIso);
      expect(first.tokenNumber).toBe(1);

      await expect(book(free!.datetimeIso, '+919800000002')).rejects.toMatchObject({
        code: 'SLOT_UNAVAILABLE',
      });
    });
  });
});
