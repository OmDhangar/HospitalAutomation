import 'dotenv/config';
import postgres from 'postgres';
import { closeDb } from '@/lib/db';
import { serviceDateIn } from '@/lib/domain/time';
import { hashPassword } from '@/lib/security/password';

/**
 * Creates a rich, realistic multi-specialty hospital environment for live demos
 * and showcase to doctors, hospital owners, and administrators.
 *
 * Populates:
 * - 5 Doctor specialties across General Medicine, Paediatrics, Orthopaedics, Dermatology, Cardiology
 * - Weekly doctor slot/queue working schedules
 * - Active Hospital plan tier & subscription with realistic quota tracking
 * - 28 days of deep historical consultations with accurate ETA sample durations & wait times
 * - Realistic WhatsApp notification outbox history across milestones (~4,500+ messages)
 * - Today's live OPD state:
 *     * Now Serving (with patient age, in-consultation / called pulse ring)
 *     * Waiting queues with Priority flags and Scheduled Slot badges
 *     * Parked patient recovery (Skipped & On-Hold tokens ready for Recall/Resume)
 *     * Punctuality / Delay tracking
 * - Verified WhatsApp Business setup
 */
if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed demo data in production');
}

const EMAIL = process.env.SEED_EMAIL ?? 'owner@demo.hospital';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-opd-queue';
const TZ = 'Asia/Kolkata';

// Realistic patient roster
const ADULT_PATIENTS = [
  { name: 'Suresh Gaitonde', age: 52, gender: 'Male', phone: '+919822010001' },
  { name: 'Pooja Jadhav', age: 29, gender: 'Female', phone: '+919822010002' },
  { name: 'Pandurang Shinde', age: 68, gender: 'Male', phone: '+919822010003' },
  { name: 'Meena Kulkarni', age: 45, gender: 'Female', phone: '+919822010004' },
  { name: 'Rahul Mane', age: 34, gender: 'Male', phone: '+919822010005' },
  { name: 'Snehal Chavan', age: 24, gender: 'Female', phone: '+919822010006' },
  { name: 'Dattatray Pawar', age: 58, gender: 'Male', phone: '+919822010007' },
  { name: 'Archana Bhosale', age: 39, gender: 'Female', phone: '+919822010008' },
  { name: 'Anand Verma', age: 47, gender: 'Male', phone: '+919822010009' },
  { name: 'Kavita Kadam', age: 41, gender: 'Female', phone: '+919822010010' },
  { name: 'Babanrao Shirole', age: 67, gender: 'Male', phone: '+919822010011' },
  { name: 'Ritu Agarwal', age: 28, gender: 'Female', phone: '+919822010012' },
  { name: 'Ganpatrao Mohite', age: 64, gender: 'Male', phone: '+919822010013' },
  { name: 'Nitin Deshmukh', age: 42, gender: 'Male', phone: '+919822010014' },
  { name: 'Sunita Deshmukh', age: 38, gender: 'Female', phone: '+919822010015' },
  { name: 'Prakash More', age: 51, gender: 'Male', phone: '+919822010016' },
  { name: 'Asha Gaikwad', age: 49, gender: 'Female', phone: '+919822010017' },
  { name: 'Vijay Bhosale', age: 56, gender: 'Male', phone: '+919822010018' },
  { name: 'Rekha Mane', age: 36, gender: 'Female', phone: '+919822010019' },
  { name: 'Sanjay Pawar', age: 44, gender: 'Male', phone: '+919822010020' },
  { name: 'Lata Salunkhe', age: 61, gender: 'Female', phone: '+919822010021' },
  { name: 'Anil Jadhav', age: 50, gender: 'Male', phone: '+919822010022' },
  { name: 'Kavita Shinde', age: 33, gender: 'Female', phone: '+919822010023' },
  { name: 'Ramesh Patil', age: 55, gender: 'Male', phone: '+919822010024' },
  { name: 'Deepak Thorat', age: 37, gender: 'Male', phone: '+919822010025' },
  { name: 'Shubhangi Jagtap', age: 31, gender: 'Female', phone: '+919822010026' },
  { name: 'Mahesh Sawant', age: 46, gender: 'Male', phone: '+919822010027' },
  { name: 'Shalini Ghorpade', age: 53, gender: 'Female', phone: '+919822010028' },
  { name: 'Chandrakant Tambe', age: 63, gender: 'Male', phone: '+919822010029' },
  { name: 'Varsha Kadam', age: 27, gender: 'Female', phone: '+919822010030' },
];

const PEDIATRIC_PATIENTS = [
  { name: 'Aarav Deshmukh', age: 4, gender: 'Male', phone: '+919822020001' },
  { name: 'Vihaan Joshi', age: 2, gender: 'Male', phone: '+919822020002' },
  { name: 'Ananya Patil', age: 6, gender: 'Female', phone: '+919822020003' },
  { name: 'Advait Shinde', age: 8, gender: 'Male', phone: '+919822020004' },
  { name: 'Sai Kulkarni', age: 1, gender: 'Male', phone: '+919822020005' },
  { name: 'Pari Chavan', age: 5, gender: 'Female', phone: '+919822020006' },
  { name: 'Reyansh More', age: 3, gender: 'Male', phone: '+919822020007' },
  { name: 'Ishaan Pawar', age: 7, gender: 'Male', phone: '+919822020008' },
  { name: 'Myra Gaikwad', age: 9, gender: 'Female', phone: '+919822020009' },
  { name: 'Kabir Bhosale', age: 2, gender: 'Male', phone: '+919822020010' },
  { name: 'Kiara Mane', age: 4, gender: 'Female', phone: '+919822020011' },
  { name: 'Devansh Salunkhe', age: 6, gender: 'Male', phone: '+919822020012' },
];

const ALL_PATIENTS = [...ADULT_PATIENTS, ...PEDIATRIC_PATIENTS];

async function main() {
  console.log('🚀 Starting rich mock data seeding for Doctor Dashboard showcase...');
  const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 4 });

  // 1. Ensure Rate Card / Plan Tiers exist
  console.log('  → Ensuring plan_tiers rate card is present...');
  const planTiersData = [
    { code: 'solo', name: 'Solo', patientsPerDay: 25, includedAppointments: 900, includedMessages: 3600, monthlyPricePaise: 199900, annualPricePaise: 1999000, setupFeePaise: 500000, sortOrder: 0 },
    { code: 'clinic', name: 'Clinic', patientsPerDay: 60, includedAppointments: 2100, includedMessages: 8400, monthlyPricePaise: 349900, annualPricePaise: 3499000, setupFeePaise: 500000, sortOrder: 1 },
    { code: 'practice', name: 'Practice', patientsPerDay: 100, includedAppointments: 3500, includedMessages: 14000, monthlyPricePaise: 499900, annualPricePaise: 4999000, setupFeePaise: 500000, sortOrder: 2 },
    { code: 'hospital', name: 'Hospital', patientsPerDay: 150, includedAppointments: 5300, includedMessages: 21200, monthlyPricePaise: 699900, annualPricePaise: 6999000, setupFeePaise: 500000, sortOrder: 3 },
    { code: 'large_opd', name: 'Large OPD', patientsPerDay: 200, includedAppointments: 7000, includedMessages: 28000, monthlyPricePaise: 899900, annualPricePaise: 8999000, setupFeePaise: 500000, sortOrder: 4 },
    { code: 'multi_branch', name: 'Multi-branch', patientsPerDay: 300, includedAppointments: 10500, includedMessages: 42000, monthlyPricePaise: 1299900, annualPricePaise: 12999000, setupFeePaise: 500000, sortOrder: 5 },
  ];

  for (const tier of planTiersData) {
    await admin`
      insert into plan_tiers
        (code, name, patients_per_day, included_appointments, included_messages,
         monthly_price_paise, annual_price_paise, setup_fee_paise, sort_order, active)
      values
        (${tier.code}, ${tier.name}, ${tier.patientsPerDay}, ${tier.includedAppointments},
         ${tier.includedMessages}, ${tier.monthlyPricePaise}, ${tier.annualPricePaise},
         ${tier.setupFeePaise}, ${tier.sortOrder}, true)
      on conflict (code) do update set
        name = excluded.name,
        patients_per_day = excluded.patients_per_day,
        included_appointments = excluded.included_appointments,
        included_messages = excluded.included_messages,
        monthly_price_paise = excluded.monthly_price_paise,
        annual_price_paise = excluded.annual_price_paise;
    `;
  }

  /**
   * 2. Clean previous demo hospital data cleanly
   *
   * The placeholder numbers have to go FIRST, and explicitly.
   *
   * `whatsapp_numbers.hospital_id` is ON DELETE SET NULL — correct for real
   * numbers, since a departing customer's SIM returns to inventory rather than
   * vanishing. But it means deleting the demo hospital *orphans* its number
   * instead of removing it, and the insert below then adds another. Re-seeding
   * therefore leaked one dead row per run, and a database with hundreds of them
   * makes the one row that matters impossible to find.
   */
  console.log('  → Clearing previous demo hospital data...');
  const [{ count: purged }] = await admin<{ count: number }[]>`
    with removed as (
      delete from whatsapp_numbers
      where phone_number_id like 'demo-pn-%'
      returning 1
    )
    select count(*)::int as count from removed
  `;
  if (purged > 0) {
    console.log(`    removed ${purged} placeholder WhatsApp number(s) from earlier runs`);
  }

  await admin`delete from hospitals where slug = 'demo-hospital'`;
  await admin`delete from users where email in (${EMAIL}, 'reception@demo.hospital')`;

  // 3. Create Multi-Specialty Hospital
  console.log('  → Creating hospital & branches...');
  const [hospital] = await admin`
    insert into hospitals
      (name, slug, timezone, default_locale, plan_tier_code, discount_percent, owner_phone_e164, active)
    values
      ('Sunrise Multispeciality Hospital', 'demo-hospital', ${TZ}, 'en', 'hospital', 0, '+919822012345', true)
    returning id, name, slug
  `;

  const [mainBranch] = await admin`
    insert into branches (hospital_id, name, address, active)
    values (${hospital.id}, 'Main OPD Wing', 'Station Road, Satara', true)
    returning id, name
  `;

  const [specialtyBranch] = await admin`
    insert into branches (hospital_id, name, address, active)
    values (${hospital.id}, 'Specialty Care Center', 'Model Colony, Satara', true)
    returning id, name
  `;

  /**
   * 4. WhatsApp Business Sender Setup
   *
   * `phone_number_id` is the routing key: `resolve_whatsapp_number` matches the
   * id Meta puts in the webhook against this column, and nothing else. The
   * display number below it is cosmetic.
   *
   * So a placeholder here is not a harmless fixture. Every real inbound message
   * resolves to no hospital and is dropped *after* the read receipt has already
   * gone out — the patient sees a blue tick and silence, the webhook returns
   * 200, and no error is logged anywhere. Seeding over a working id costs an
   * afternoon to rediscover, which is why the real one wins when it is set.
   */
  console.log('  → Configuring verified WhatsApp sender...');
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(
      '    ! WHATSAPP_PHONE_NUMBER_ID is not set — using a placeholder id.\n' +
        '      Real inbound WhatsApp messages will NOT route to this hospital.',
    );
  }
  await admin`
    insert into whatsapp_numbers
      (hospital_id, phone_number_id, display_phone_number, verified_name, status, quality_rating, messaging_tier, registered_at)
    values (
      ${hospital.id},
      ${process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || 'demo-pn-' + hospital.id.slice(0, 8)},
      '+91 98220 12345',
      'Sunrise Multispeciality Hospital',
      'registered',
      'GREEN',
      'TIER_1K',
      now() - interval '60 days'
    )
    /**
     * A real number survives re-seeding and is re-attached, not duplicated.
     *
     * Without this, seeding twice with WHATSAPP_PHONE_NUMBER_ID set fails on
     * the unique constraint the second time — the previous run's row was
     * orphaned by the hospital delete, not removed, so the id is still taken.
     * Re-pointing it at the new demo hospital is what the operator meant.
     */
    on conflict (phone_number_id) do update set
      hospital_id          = excluded.hospital_id,
      display_phone_number = excluded.display_phone_number,
      verified_name        = excluded.verified_name,
      status               = excluded.status,
      registered_at        = excluded.registered_at,
      updated_at           = now()
  `;

  // 5. Create Staff Users (Doctor/Owner & Receptionist)
  console.log('  → Creating demo staff accounts...');
  const passwordHash = await hashPassword(PASSWORD);

  const [ownerUser] = await admin`
    insert into users (email, password_hash, name, is_platform_admin, active)
    values (${EMAIL.toLowerCase()}, ${passwordHash}, 'Dr. Anjali Rao', false, true)
    returning id
  `;

  const [receptionUser] = await admin`
    insert into users (email, password_hash, name, is_platform_admin, active)
    values ('reception@demo.hospital', ${passwordHash}, 'Reception Desk (Satara)', false, true)
    returning id
  `;

  await admin`
    insert into staff_memberships (user_id, hospital_id, branch_id, role, active)
    values
      (${ownerUser.id}, ${hospital.id}, ${mainBranch.id}, 'owner', true),
      (${receptionUser.id}, ${hospital.id}, ${mainBranch.id}, 'receptionist', true)
  `;

  // 6. Active Subscription Record (Period matching current calendar month)
  console.log('  → Setting up active hospital subscription & quota...');
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

  await admin`
    insert into subscriptions
      (hospital_id, plan_tier_code, billing_cycle, status, price_paise, setup_fee_paise,
       daily_appointment_capacity, included_appointments, included_messages,
       starts_at, ends_at, change_reason)
    values
      (${hospital.id}, 'hospital', 'monthly', 'active', 699900, 0,
       150, 5300, 21200,
       ${startOfMonth.toISOString()}, ${endOfMonth.toISOString()}, 'initial_setup')
  `;

  // 7. Doctors & Multi-Specialties
  console.log('  → Registering 5 multi-specialty doctors...');
  const doctorsData = [
    { name: 'Dr. Rajesh Kulkarni', specialty: 'MD, General Medicine', branchId: mainBranch.id, defaultConsult: 8, mode: 'both' },
    { name: 'Dr. Anjali Deshmukh', specialty: 'DNB, Paediatrics', branchId: mainBranch.id, defaultConsult: 12, mode: 'both' },
    { name: 'Dr. Vikramaditya Joshi', specialty: 'MS, Orthopaedics & Joint Replacement', branchId: mainBranch.id, defaultConsult: 15, mode: 'slot' },
    { name: 'Dr. Sneha Patil', specialty: 'MD, Dermatology & Cosmetology', branchId: specialtyBranch.id, defaultConsult: 10, mode: 'both' },
    { name: 'Dr. Amit Mehra', specialty: 'DM, Cardiology', branchId: mainBranch.id, defaultConsult: 15, mode: 'queue' },
  ];

  const doctors: Array<{ id: string; name: string; specialty: string; defaultConsult: number; mode: string; branchId: string }> = [];

  for (const doc of doctorsData) {
    const [row] = await admin`
      insert into doctors
        (hospital_id, branch_id, name, specialty, default_consult_minutes, active)
      values
        (${hospital.id}, ${doc.branchId}, ${doc.name}, ${doc.specialty}, ${doc.defaultConsult}, true)
      returning id, name
    `;
    doctors.push({ ...doc, id: row.id, name: row.name });
  }

  // 8. Weekly Doctor Schedules (Monday to Saturday)
  console.log('  → Configuring doctor weekly working schedules & slot configurations...');
  for (const doc of doctors) {
    for (let weekday = 1; weekday <= 6; weekday++) {
      await admin`
        insert into doctor_schedules
          (hospital_id, doctor_id, weekday, mode, start_time, end_time, slot_minutes, break_start_time, break_end_time, effective_from)
        values
          (${hospital.id}, ${doc.id}, ${weekday}, ${doc.mode},
           '09:00:00', '13:00:00', ${doc.defaultConsult}, '13:00:00', '17:00:00', '2026-01-01')
      `;
    }
  }

  // 9. Patients Registration in Bulk
  console.log('  → Registering patient profiles...');
  const patientInsertRows = ALL_PATIENTS.map((p) => ({
    hospital_id: hospital.id,
    phone_e164: p.phone,
    name: p.name,
    age: p.age,
    gender: p.gender,
    locale: 'en',
    whatsapp_opt_in_at: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  }));

  const insertedPatients = await admin`
    insert into patients ${(admin as any)(
      patientInsertRows,
      'hospital_id',
      'phone_e164',
      'name',
      'age',
      'gender',
      'locale',
      'whatsapp_opt_in_at',
    )}
    returning id, name
  `;

  const patientMap = new Map<string, string>();
  for (const p of insertedPatients) {
    patientMap.set(p.name, p.id);
  }

  // 10. Historical Consultations & Notifications in Bulk
  console.log('  → Generating 28 days of historical OPD consultations in bulk...');
  const todayStr = serviceDateIn(TZ, now);

  const historicalAppointments: any[] = [];

  for (let dayOffset = 28; dayOffset >= 1; dayOffset--) {
    const pastDate = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
    const dayOfWeek = pastDate.getDay();
    if (dayOfWeek === 0) continue; // Skip Sundays

    const serviceDate = serviceDateIn(TZ, pastDate);

    for (const [docIdx, doc] of doctors.entries()) {
      const dailyVolume = Math.floor(14 + docIdx * 3 + ((dayOffset * 7) % 5));
      const baseConsult = doc.defaultConsult;

      for (let token = 1; token <= dailyVolume; token++) {
        const consultDuration = Math.max(4, baseConsult + ((token * 3) % 7) - 3);
        const patientIndex = (dayOffset * 5 + docIdx * 7 + token) % ALL_PATIENTS.length;
        const patientData = ALL_PATIENTS[patientIndex];
        const patientId = patientMap.get(patientData.name)!;

        const minutesFromOpen = (token - 1) * (baseConsult + 2);
        const aptEnqueued = new Date(pastDate);
        aptEnqueued.setHours(8, 30 + (token % 20), 0, 0);

        const aptCalled = new Date(pastDate);
        aptCalled.setHours(9, 0 + minutesFromOpen, 0, 0);

        const aptStarted = new Date(aptCalled.getTime() + 60 * 1000);
        const aptCompleted = new Date(aptStarted.getTime() + consultDuration * 60 * 1000);

        const isNoShow = token === dailyVolume && (dayOffset % 4 === 0);
        const status = isNoShow ? 'NO_SHOW' : 'COMPLETED';

        historicalAppointments.push({
          hospital_id: hospital.id,
          branch_id: doc.branchId,
          doctor_id: doc.id,
          patient_id: patientId,
          service_date: serviceDate,
          token_number: token,
          status,
          source: 'walk_in',
          public_token: `hist-${serviceDate}-${doc.id.slice(0, 4)}-${token}`,
          public_token_expires_at: aptCompleted.toISOString(),
          enqueued_at: aptEnqueued.toISOString(),
          called_at: isNoShow ? null : aptCalled.toISOString(),
          consult_started_at: isNoShow ? null : aptStarted.toISOString(),
          completed_at: isNoShow ? null : aptCompleted.toISOString(),
          created_at: aptEnqueued.toISOString(),
        });
      }
    }
  }

  // Insert historical appointments in chunks of 400
  console.log(`  → Bulk inserting ${historicalAppointments.length} historical appointments...`);
  const chunkSize = 400;
  const insertedApts: any[] = [];

  for (let i = 0; i < historicalAppointments.length; i += chunkSize) {
    const chunk = historicalAppointments.slice(i, i + chunkSize);
    const res = await admin`
      insert into appointments ${(admin as any)(
        chunk,
        'hospital_id',
        'branch_id',
        'doctor_id',
        'patient_id',
        'service_date',
        'token_number',
        'status',
        'source',
        'public_token',
        'public_token_expires_at',
        'enqueued_at',
        'called_at',
        'consult_started_at',
        'completed_at',
        'created_at',
      )}
      returning id, patient_id, enqueued_at, called_at, status
    `;
    insertedApts.push(...res);
  }

  // Generate bulk notification records
  console.log('  → Bulk inserting WhatsApp notifications for historical appointments...');
  const notifications: any[] = [];
  for (const apt of insertedApts) {
    if (apt.status !== 'COMPLETED') continue;

    notifications.push({
      hospital_id: hospital.id,
      appointment_id: apt.id,
      patient_id: apt.patient_id,
      channel: 'whatsapp',
      milestone: 'booking_confirmed',
      template_code: 'booking_confirmation_v1',
      locale: 'en',
      payload: JSON.stringify({ token: 1 }),
      status: 'sent',
      sent_at: apt.enqueued_at,
      delivered_at: apt.enqueued_at,
      created_at: apt.enqueued_at,
    });

    notifications.push({
      hospital_id: hospital.id,
      appointment_id: apt.id,
      patient_id: apt.patient_id,
      channel: 'whatsapp',
      milestone: 'queue_ahead_4',
      template_code: 'queue_status_update_v1',
      locale: 'en',
      payload: JSON.stringify({ ahead: 4 }),
      status: 'sent',
      sent_at: apt.called_at,
      delivered_at: apt.called_at,
      created_at: apt.called_at,
    });

    notifications.push({
      hospital_id: hospital.id,
      appointment_id: apt.id,
      patient_id: apt.patient_id,
      channel: 'whatsapp',
      milestone: 'queue_next',
      template_code: 'queue_next_v1',
      locale: 'en',
      payload: JSON.stringify({ next: true }),
      status: 'sent',
      sent_at: apt.called_at,
      delivered_at: apt.called_at,
      created_at: apt.called_at,
    });
  }

  for (let i = 0; i < notifications.length; i += chunkSize) {
    const chunk = notifications.slice(i, i + chunkSize);
    await admin`
      insert into notification_outbox ${(admin as any)(
        chunk,
        'hospital_id',
        'appointment_id',
        'patient_id',
        'channel',
        'milestone',
        'template_code',
        'locale',
        'payload',
        'status',
        'sent_at',
        'delivered_at',
        'created_at',
      )}
      on conflict do nothing
    `;
  }

  // 11. Today's Live OPD Data & Queues
  console.log("  → Seeding Today's live OPD queues, active consultations & parked tokens...");

  // Doctor 1: Dr. Rajesh Kulkarni (General Medicine)
  const doc1 = doctors[0];
  await admin`
    insert into doctor_day_states
      (hospital_id, doctor_id, service_date, mode, paused, scheduled_start_at, session_started_at, last_token_number)
    values
      (${hospital.id}, ${doc1.id}, ${todayStr}, 'both', false,
       now() - interval '2 hours', now() - interval '1 hour 55 minutes', 21)
    on conflict (doctor_id, service_date) do update set
      paused = false, last_token_number = 21, session_started_at = now() - interval '1 hour 55 minutes';
  `;

  // Completed today for Dr. Kulkarni (Tokens 1 to 13, except 9 and 11 which got parked)
  for (let t = 1; t <= 13; t++) {
    if (t === 9 || t === 11) continue;
    const p = ADULT_PATIENTS[t % ADULT_PATIENTS.length];
    const pid = patientMap.get(p.name)!;
    const consultMin = 7 + (t % 4);
    const completedAgo = (14 - t) * 8;

    await admin`
      insert into appointments
        (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
         status, source, public_token, public_token_expires_at,
         enqueued_at, called_at, consult_started_at, completed_at)
      values
        (${hospital.id}, ${doc1.branchId}, ${doc1.id}, ${pid}, ${todayStr}, ${t},
         'COMPLETED', 'walk_in', ${`today-doc1-${t}`}, now() + interval '12 hours',
         now() - (${completedAgo + 25} * interval '1 minute'),
         now() - (${completedAgo + consultMin} * interval '1 minute'),
         now() - (${completedAgo + consultMin} * interval '1 minute'),
         now() - (${completedAgo} * interval '1 minute'))
    `;
  }

  // Token 9: Skipped (Anand Verma - Absent when called)
  const p9 = patientMap.get('Anand Verma')!;
  await admin`
    insert into appointments
      (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
       status, source, public_token, public_token_expires_at,
       enqueued_at, called_at)
    values
      (${hospital.id}, ${doc1.branchId}, ${doc1.id}, ${p9}, ${todayStr}, 9,
       'SKIPPED', 'walk_in', 'today-doc1-9-skipped', now() + interval '12 hours',
       now() - interval '65 minutes', now() - interval '40 minutes')
  `;

  // Token 11: On-Hold (Kavita Kadam - Sent for BP / Vitals check)
  const p11 = patientMap.get('Kavita Kadam')!;
  await admin`
    insert into appointments
      (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
       status, source, public_token, public_token_expires_at,
       enqueued_at, called_at, consult_started_at)
    values
      (${hospital.id}, ${doc1.branchId}, ${doc1.id}, ${p11}, ${todayStr}, 11,
       'HELD', 'walk_in', 'today-doc1-11-onhold', now() + interval '12 hours',
       now() - interval '50 minutes', now() - interval '25 minutes', now() - interval '24 minutes')
  `;

  // Token 14: In Consultation right now (Suresh Gaitonde, 52 yrs)
  const p14 = patientMap.get('Suresh Gaitonde')!;
  await admin`
    insert into appointments
      (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
       status, source, public_token, public_token_expires_at,
       enqueued_at, called_at, consult_started_at)
    values
      (${hospital.id}, ${doc1.branchId}, ${doc1.id}, ${p14}, ${todayStr}, 14,
       'IN_CONSULTATION', 'walk_in', 'today-doc1-14-current', now() + interval '12 hours',
       now() - interval '35 minutes', now() - interval '6 minutes', now() - interval '5 minutes')
  `;

  // Waiting Patients for Dr. Kulkarni (Tokens 15 to 21)
  const waitingKulkarni = [
    { token: 15, name: 'Pooja Jadhav', priority: 0, waitMins: 32 },
    { token: 16, name: 'Pandurang Shinde', priority: 1, waitMins: 28 }, // Senior Citizen Priority
    { token: 17, name: 'Meena Kulkarni', priority: 0, waitMins: 24 },
    { token: 18, name: 'Rahul Mane', priority: 0, waitMins: 20, isSlot: true }, // Scheduled Slot
    { token: 19, name: 'Snehal Chavan', priority: 0, waitMins: 16 },
    { token: 20, name: 'Dattatray Pawar', priority: 0, waitMins: 12 },
    { token: 21, name: 'Archana Bhosale', priority: 0, waitMins: 8 },
  ];

  for (const item of waitingKulkarni) {
    const pid = patientMap.get(item.name)!;
    const scheduledSlot = item.isSlot ? new Date(now.getTime() + 45 * 60 * 1000) : null;

    await admin`
      insert into appointments
        (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
         status, priority, source, public_token, public_token_expires_at,
         scheduled_slot_at, enqueued_at)
      values
        (${hospital.id}, ${doc1.branchId}, ${doc1.id}, ${pid}, ${todayStr}, ${item.token},
         'WAITING', ${item.priority}, ${item.isSlot ? 'whatsapp' : 'walk_in'},
         ${`today-doc1-${item.token}`}, now() + interval '12 hours',
         ${scheduledSlot ? scheduledSlot.toISOString() : null},
         now() - (${item.waitMins} * interval '1 minute'))
    `;
  }

  // Doctor 2: Dr. Anjali Deshmukh (Paediatrics)
  const doc2 = doctors[1];
  await admin`
    insert into doctor_day_states
      (hospital_id, doctor_id, service_date, mode, paused, scheduled_start_at, session_started_at, last_token_number)
    values
      (${hospital.id}, ${doc2.id}, ${todayStr}, 'both', false,
       now() - interval '1 hour 45 minutes', now() - interval '1 hour 40 minutes', 13)
    on conflict (doctor_id, service_date) do update set
      paused = false, last_token_number = 13, session_started_at = now() - interval '1 hour 40 minutes';
  `;

  for (let t = 1; t <= 7; t++) {
    const p = PEDIATRIC_PATIENTS[t % PEDIATRIC_PATIENTS.length];
    const pid = patientMap.get(p.name)!;
    await admin`
      insert into appointments
        (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
         status, source, public_token, public_token_expires_at,
         enqueued_at, called_at, consult_started_at, completed_at)
      values
        (${hospital.id}, ${doc2.branchId}, ${doc2.id}, ${pid}, ${todayStr}, ${t},
         'COMPLETED', 'walk_in', ${`today-doc2-${t}`}, now() + interval '12 hours',
         now() - interval '90 minutes', now() - interval '70 minutes',
         now() - interval '68 minutes', now() - (${(8 - t) * 12} * interval '1 minute'))
    `;
  }

  // Token 8: Called (Aarav Deshmukh, 4 yrs) -> Pulse ring on dashboard!
  const pAarav = patientMap.get('Aarav Deshmukh')!;
  await admin`
    insert into appointments
      (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
       status, source, public_token, public_token_expires_at,
       enqueued_at, called_at)
    values
      (${hospital.id}, ${doc2.branchId}, ${doc2.id}, ${pAarav}, ${todayStr}, 8,
       'CALLED', 'walk_in', 'today-doc2-8-called', now() + interval '12 hours',
       now() - interval '25 minutes', now() - interval '2 minutes')
  `;

  // Waiting Pediatric Patients (Tokens 9 to 13)
  const waitingDeshmukh = [
    { token: 9, name: 'Vihaan Joshi', priority: 0, waitMins: 22 },
    { token: 10, name: 'Ananya Patil', priority: 0, waitMins: 18, isSlot: true },
    { token: 11, name: 'Advait Shinde', priority: 0, waitMins: 14 },
    { token: 12, name: 'Sai Kulkarni', priority: 1, waitMins: 10 }, // Infant Priority
    { token: 13, name: 'Pari Chavan', priority: 0, waitMins: 6 },
  ];

  for (const item of waitingDeshmukh) {
    const pid = patientMap.get(item.name)!;
    const scheduledSlot = item.isSlot ? new Date(now.getTime() + 60 * 60 * 1000) : null;

    await admin`
      insert into appointments
        (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
         status, priority, source, public_token, public_token_expires_at,
         scheduled_slot_at, enqueued_at)
      values
        (${hospital.id}, ${doc2.branchId}, ${doc2.id}, ${pid}, ${todayStr}, ${item.token},
         'WAITING', ${item.priority}, ${item.isSlot ? 'whatsapp' : 'walk_in'},
         ${`today-doc2-${item.token}`}, now() + interval '12 hours',
         ${scheduledSlot ? scheduledSlot.toISOString() : null},
         now() - (${item.waitMins} * interval '1 minute'))
    `;
  }

  // Doctor 3: Dr. Vikramaditya Joshi (Orthopaedics)
  const doc3 = doctors[2];
  await admin`
    insert into doctor_day_states
      (hospital_id, doctor_id, service_date, mode, paused, scheduled_start_at, session_started_at, last_token_number)
    values
      (${hospital.id}, ${doc3.id}, ${todayStr}, 'slot', false,
       now() - interval '1 hour 30 minutes', now() - interval '1 hour 30 minutes', 10)
    on conflict (doctor_id, service_date) do update set
      paused = false, last_token_number = 10;
  `;

  for (let t = 1; t <= 5; t++) {
    const p = ADULT_PATIENTS[(t + 12) % ADULT_PATIENTS.length];
    const pid = patientMap.get(p.name)!;
    await admin`
      insert into appointments
        (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
         status, source, public_token, public_token_expires_at,
         enqueued_at, called_at, consult_started_at, completed_at)
      values
        (${hospital.id}, ${doc3.branchId}, ${doc3.id}, ${pid}, ${todayStr}, ${t},
         'COMPLETED', 'walk_in', ${`today-doc3-${t}`}, now() + interval '12 hours',
         now() - interval '80 minutes', now() - interval '60 minutes',
         now() - interval '59 minutes', now() - (${(6 - t) * 15} * interval '1 minute'))
    `;
  }

  // Token 6: In consultation (Ganpatrao Mohite, 64 yrs)
  const pMohite = patientMap.get('Ganpatrao Mohite')!;
  await admin`
    insert into appointments
      (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
       status, source, public_token, public_token_expires_at,
       enqueued_at, called_at, consult_started_at)
    values
      (${hospital.id}, ${doc3.branchId}, ${doc3.id}, ${pMohite}, ${todayStr}, 6,
       'IN_CONSULTATION', 'walk_in', 'today-doc3-6-current', now() + interval '12 hours',
       now() - interval '40 minutes', now() - interval '8 minutes', now() - interval '7 minutes')
  `;

  for (let t = 7; t <= 10; t++) {
    const p = ADULT_PATIENTS[(t + 15) % ADULT_PATIENTS.length];
    const pid = patientMap.get(p.name)!;
    await admin`
      insert into appointments
        (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
         status, source, public_token, public_token_expires_at, enqueued_at)
      values
        (${hospital.id}, ${doc3.branchId}, ${doc3.id}, ${pid}, ${todayStr}, ${t},
         'WAITING', 'walk_in', ${`today-doc3-${t}`}, now() + interval '12 hours',
         now() - (${(11 - t) * 7} * interval '1 minute'))
    `;
  }

  // Doctor 4 & 5: Dr. Sneha Patil & Dr. Amit Mehra
  const doc4 = doctors[3];
  const doc5 = doctors[4];

  for (const doc of [doc4, doc5]) {
    await admin`
      insert into doctor_day_states
        (hospital_id, doctor_id, service_date, mode, paused, scheduled_start_at, session_started_at, last_token_number)
      values
        (${hospital.id}, ${doc.id}, ${todayStr}, 'both', false,
         now() - interval '1 hour', now() - interval '58 minutes', 8)
      on conflict (doctor_id, service_date) do update set
        paused = false, last_token_number = 8;
    `;

    for (let t = 1; t <= 4; t++) {
      const p = ADULT_PATIENTS[(t + 18) % ADULT_PATIENTS.length];
      const pid = patientMap.get(p.name)!;
      await admin`
        insert into appointments
          (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
           status, source, public_token, public_token_expires_at,
           enqueued_at, called_at, consult_started_at, completed_at)
        values
          (${hospital.id}, ${doc.branchId}, ${doc.id}, ${pid}, ${todayStr}, ${t},
           'COMPLETED', 'walk_in', ${`today-${doc.id.slice(0, 4)}-${t}`}, now() + interval '12 hours',
           now() - interval '50 minutes', now() - interval '35 minutes',
           now() - interval '34 minutes', now() - (${(5 - t) * 10} * interval '1 minute'))
      `;
    }

    // In consultation
    const pCurrent = ADULT_PATIENTS[22];
    const pidCurrent = patientMap.get(pCurrent.name)!;
    await admin`
      insert into appointments
        (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
         status, source, public_token, public_token_expires_at,
         enqueued_at, called_at, consult_started_at)
      values
        (${hospital.id}, ${doc.branchId}, ${doc.id}, ${pidCurrent}, ${todayStr}, 5,
         'IN_CONSULTATION', 'walk_in', ${`today-${doc.id.slice(0, 4)}-5`}, now() + interval '12 hours',
         now() - interval '30 minutes', now() - interval '5 minutes', now() - interval '4 minutes')
    `;

    // Waiting
    for (let t = 6; t <= 8; t++) {
      const p = ADULT_PATIENTS[(t + 20) % ADULT_PATIENTS.length];
      const pid = patientMap.get(p.name)!;
      await admin`
        insert into appointments
          (hospital_id, branch_id, doctor_id, patient_id, service_date, token_number,
           status, source, public_token, public_token_expires_at, enqueued_at)
        values
          (${hospital.id}, ${doc.branchId}, ${doc.id}, ${pid}, ${todayStr}, ${t},
           'WAITING', 'walk_in', ${`today-${doc.id.slice(0, 4)}-${t}`}, now() + interval '12 hours',
           now() - (${(9 - t) * 6} * interval '1 minute'))
      `;
    }
  }

  // 12. Create Sample Audit Log Entries
  console.log('  → Generating audit trail logs...');
  await admin`
    insert into audit_logs
      (hospital_id, actor_user_id, action, object_type, object_id, metadata, ip_address, created_at)
    values
      (${hospital.id}, ${ownerUser.id}, 'staff.login', 'user', ${ownerUser.id}, '{"method": "password"}'::jsonb, '127.0.0.1', now() - interval '2 hours'),
      (${hospital.id}, ${ownerUser.id}, 'doctor.schedule_updated', 'doctor', ${doc1.id}, '{"mode": "both", "slots": 8}'::jsonb, '127.0.0.1', now() - interval '1 day'),
      (${hospital.id}, ${receptionUser.id}, 'queue.walk_in_added', 'appointment', null, '{"doctor": "Dr. Rajesh Kulkarni", "token": 16, "priority": 1}'::jsonb, '127.0.0.1', now() - interval '28 minutes')
  `;

  // Fetch sample public links for live patient queue preview
  const liveSampleLinks = await admin`
    select a.token_number, a.public_token, p.name, d.name as doctor_name, a.status
    from appointments a
    join patients p on p.id = a.patient_id
    join doctors d on d.id = a.doctor_id
    where a.hospital_id = ${hospital.id} and a.service_date = ${todayStr}
      and a.status in ('WAITING', 'CALLED', 'IN_CONSULTATION', 'SKIPPED', 'HELD')
    order by d.name, a.token_number
    limit 6
  `;

  console.log('\n✨ ======================================================= ✨');
  console.log('🎉 SHOWCASE MOCK DATA POPULATED SUCCESSFULLY!');
  console.log('✨ ======================================================= ✨\n');
  console.log(`🏥 Hospital:   ${hospital.name} (${hospital.slug})`);
  console.log(`📍 Branches:   ${mainBranch.name} & ${specialtyBranch.name}`);
  console.log(`🔑 Sign In:    ${EMAIL} / ${PASSWORD}`);
  console.log(`📺 TV Display: /display/${mainBranch.id}`);
  console.log(`📊 Reports:    /reports`);
  console.log(`💳 Subscriptions: /subscription`);
  console.log(`⚙️ Settings:   /settings`);
  console.log('\n📱 Live Patient Mobile Queue Links (Scan / Open to test live patient view):');
  for (const link of liveSampleLinks) {
    console.log(`   • [${link.status}] Token #${link.token_number} (${link.name}) -> /q/${link.public_token} [${link.doctor_name}]`);
  }
  console.log('\n');

  await admin.end();
  await closeDb();
}

main().catch(async (error) => {
  console.error('❌ Error during mock data seeding:', error);
  process.exit(1);
});
