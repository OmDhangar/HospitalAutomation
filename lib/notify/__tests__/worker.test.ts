import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { hospitalMessageRatio } from '../worker';
import { closeDb } from '@/lib/db';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('worker hospitalMessageRatio', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 3 }) : (null as never);
  let hospitalId: string;
  let branchId: string;
  let doctorId: string;
  let patientId: string;

  beforeEach(async () => {
    hospitalId = uuid();
    branchId = uuid();
    doctorId = uuid();
    patientId = uuid();

    await admin`
      insert into hospitals (id, name, slug)
      values (${hospitalId}, 'Ratio Test Hospital', ${'ratio-' + hospitalId.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name)
      values (${branchId}, ${hospitalId}, 'Main')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Test')
    `;
    await admin`
      insert into patients (id, hospital_id, phone_e164, name)
      values (${patientId}, ${hospitalId}, '+919876543210', 'Test Patient')
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where id = ${hospitalId}`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('excludes administrative appointment_cancelled:blackout messages from monthly canary ratio', async () => {
    const now = new Date();
    const apptId = uuid();

    // 1 completed appointment this month
    await admin`
      insert into appointments (
        id, hospital_id, branch_id, doctor_id, patient_id,
        service_date, token_number, status, source, public_token,
        public_token_expires_at, completed_at
      )
      values (
        ${apptId}, ${hospitalId}, ${branchId}, ${doctorId}, ${patientId},
        current_date, 1, 'COMPLETED', 'walk_in', ${'tok-' + uuid().slice(0, 8)},
        now() + interval '1 day', now()
      )
    `;

    // 1 normal sent outbox message
    await admin`
      insert into notification_outbox (
        hospital_id, appointment_id, patient_id, milestone,
        template_code, locale, payload, status, sent_at
      )
      values (
        ${hospitalId}, ${apptId}, ${patientId}, 'queue_link',
        'queue_link', 'en', '{}'::jsonb, 'sent', now()
      )
    `;

    // 1 blackout cancellation sent message
    await admin`
      insert into notification_outbox (
        hospital_id, appointment_id, patient_id, milestone,
        template_code, locale, payload, status, sent_at
      )
      values (
        ${hospitalId}, ${apptId}, ${patientId}, 'appointment_cancelled:blackout',
        'appointment_cancelled', 'en', '{}'::jsonb, 'sent', now()
      )
    `;

    const ratio = await hospitalMessageRatio(hospitalId, now);

    // If blackout cancellations were included: ratio = (1 + 1) / 1 = 2.0
    // With exclusion: messagesSent = 1, completed = 1 -> ratio = 1.0
    expect(ratio).toBe(1.0);
  });
});
