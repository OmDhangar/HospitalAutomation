import 'dotenv/config';
import postgres from 'postgres';
import { closeDb } from '@/lib/db';
import { serviceDateIn } from '@/lib/domain/time';
import { createStaffUser } from '@/lib/services/auth';
import { advanceQueue, createWalkIn } from '@/lib/services/queue';

/**
 * Creates a realistic hospital to develop and demo against.
 *
 * Backdated consultations are part of the point: without a history of real
 * durations the ETA model has nothing to work from and every estimate falls
 * back to the configured default, which is not what a demo should show.
 */
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed demo data in production');
}

const EMAIL = process.env.SEED_EMAIL ?? 'owner@demo.hospital';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-opd-queue';
const TZ = 'Asia/Kolkata';

const NAMES = [
  'Ramesh Patil', 'Sunita Deshmukh', 'Anil Jadhav', 'Kavita Shinde',
  'Prakash More', 'Meena Kulkarni', 'Sanjay Pawar', 'Asha Gaikwad',
  'Vijay Bhosale', 'Lata Salunkhe', 'Nitin Chavan', 'Rekha Mane',
];

async function main() {
  const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2 });

  await admin`delete from hospitals where slug = 'demo-hospital'`;
  await admin`delete from users where email = ${EMAIL}`;

  const [hospital] = await admin`
    insert into hospitals (name, slug, timezone, default_locale, plan_tier_code)
    values ('Sunrise Multispeciality Hospital', 'demo-hospital', ${TZ}, 'mr', 'large')
    returning id
  `;
  const [branch] = await admin`
    insert into branches (hospital_id, name, address)
    values (${hospital.id}, 'Main building', 'Station Road, Satara')
    returning id
  `;

  await admin`
    insert into whatsapp_numbers
      (hospital_id, phone_number_id, display_phone_number, verified_name, status, quality_rating, messaging_tier, registered_at)
    values (
      ${hospital.id}, ${'demo-pn-' + hospital.id.slice(0, 8)}, '+919000000001',
      'Sunrise Hospital', 'registered', 'GREEN', 'TIER_1K', now()
    )
  `;

  const doctorRows = await admin`
    insert into doctors (hospital_id, branch_id, name, specialty, default_consult_minutes)
    values
      (${hospital.id}, ${branch.id}, 'Dr Kulkarni', 'General medicine', 8),
      (${hospital.id}, ${branch.id}, 'Dr Sharma', 'Paediatrics', 12),
      (${hospital.id}, ${branch.id}, 'Dr Naik', 'Orthopaedics', 15)
    returning id, name
  `;

  await createStaffUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Dr Anjali Rao',
    hospitalId: hospital.id,
    role: 'owner',
    branchId: branch.id,
  });

  // Yesterday's completed consultations, so the ETA model has real samples
  // rather than falling back to each doctor's configured default.
  const yesterday = serviceDateIn(TZ, new Date(Date.now() - 24 * 60 * 60 * 1000));
  const [historyPatient] = await admin`
    insert into patients (hospital_id, phone_e164, name, locale)
    values (${hospital.id}, '+919000000000', 'Past Patient', 'mr')
    returning id
  `;

  for (const [index, doctor] of doctorRows.entries()) {
    // Each doctor runs at a different pace, which is the whole reason the ETA
    // model is per-doctor.
    const base = 7 + index * 4;
    for (let i = 0; i < 18; i += 1) {
      const minutes = base + ((i * 3) % 7) - 3;
      await admin`
        insert into appointments
          (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
           status, source, public_token, public_token_expires_at,
           enqueued_at, called_at, consult_started_at, completed_at)
        values (
          ${hospital.id}, ${branch.id}, ${doctor.id}, ${historyPatient.id},
          ${yesterday}, ${i + 1}, 'COMPLETED', 'walk_in',
          ${`seed-${doctor.id}-${i}`}, now(),
          now() - interval '1 day',
          now() - interval '1 day',
          now() - interval '1 day',
          now() - interval '1 day' + (${minutes} * interval '1 minute')
        )
      `;
    }
  }

  // Today's live queue, created through the real service so every invariant,
  // event and outbox row is exercised exactly as it would be in production.
  const [first, second] = doctorRows;
  for (const [i, name] of NAMES.slice(0, 7).entries()) {
    await createWalkIn({
      hospitalId: hospital.id,
      branchId: branch.id,
      doctorId: first.id,
      timezone: TZ,
      patient: { phoneE164: `+9198765${String(43210 + i).padStart(5, '0')}`, name },
    });
  }
  for (const [i, name] of NAMES.slice(7, 11).entries()) {
    await createWalkIn({
      hospitalId: hospital.id,
      branchId: branch.id,
      doctorId: second.id,
      timezone: TZ,
      patient: { phoneE164: `+9198766${String(43210 + i).padStart(5, '0')}`, name },
    });
  }

  // Get each queue moving so the dashboard does not open on an empty state.
  await advanceQueue({ hospitalId: hospital.id, doctorId: first.id, timezone: TZ });
  await advanceQueue({ hospitalId: hospital.id, doctorId: first.id, timezone: TZ });
  await advanceQueue({ hospitalId: hospital.id, doctorId: second.id, timezone: TZ });

  const links = await admin`
    select a.token_number, a.public_token, p.name
    from appointments a join patients p on p.id = a.patient_id
    where a.hospital_id = ${hospital.id} and a.status = 'WAITING'
    order by a.token_number limit 3
  `;

  console.log('\nDemo hospital ready.\n');
  console.log(`  Sign in    ${EMAIL} / ${PASSWORD}`);
  console.log(`  Display    /display/${branch.id}`);
  console.log('\n  Patient queue links:');
  for (const link of links) {
    console.log(`    token ${link.token_number}  ${link.name}  ->  /q/${link.public_token}`);
  }
  console.log('');

  await admin.end();
  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
