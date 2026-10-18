import postgres from 'postgres';
import dotenv from 'dotenv';
import { randomUUID as uuidv4 } from 'node:crypto';
import { hashPassword } from '../lib/security/password';

dotenv.config();

const admin = postgres(process.env.DATABASE_ADMIN_URL!, {
  max: 4,
  idle_timeout: 120,
  connect_timeout: 30,
});

async function seedKavitaIpd() {
  console.log('🚀 Seeding comprehensive mock data for Kavita Shinde across all IPD modules...');

  // 1. Get or verify demo hospital
  const [hospital] = await admin`
    select id, name, slug from hospitals where slug = 'demo-hospital' limit 1
  `;
  if (!hospital) {
    throw new Error('demo-hospital not found. Please run npm run db:seed first.');
  }
  console.log(`  ✓ Found Hospital: ${hospital.name} (${hospital.id})`);

  // 2. Get Branches
  const branches = await admin`
    select id, name from branches where hospital_id = ${hospital.id} order by name
  `;
  const mainBranch = branches[0];
  console.log(`  ✓ Found Branch: ${mainBranch.name} (${mainBranch.id})`);

  // 3. Ensure Doctors have registration numbers and qualifications
  await admin`
    update doctors
    set registration_no = 'MMC-2012-08492',
        qualification = 'MBBS, MD (General Medicine)',
        on_letterhead = true
    where hospital_id = ${hospital.id} and name = 'Dr. Rajesh Kulkarni'
  `;
  await admin`
    update doctors
    set registration_no = 'MMC-2015-09876',
        qualification = 'MBBS, MS (General Surgery)',
        on_letterhead = true
    where hospital_id = ${hospital.id} and name = 'Dr. Amit Mehra'
  `;

  const [attendingDoctor] = await admin`
    select id, name, registration_no, user_id from doctors
    where hospital_id = ${hospital.id} and name = 'Dr. Rajesh Kulkarni'
    limit 1
  `;
  console.log(`  ✓ Attending Doctor: ${attendingDoctor.name} [Reg: ${attendingDoctor.registration_no}]`);

  // 4. Ensure Nurse User exists
  const passwordHash = await hashPassword('Demo@12345');
  let [nurseUser] = await admin`
    select id, name, email from users where email = 'nurse.priya@demo.hospital'
  `;
  if (!nurseUser) {
    [nurseUser] = await admin`
      insert into users (email, password_hash, name, is_platform_admin, active)
      values ('nurse.priya@demo.hospital', ${passwordHash}, 'Nurse Priya Sharma', false, true)
      returning id, name, email
    `;
    await admin`
      insert into staff_memberships (user_id, hospital_id, branch_id, role, active)
      values (${nurseUser.id}, ${hospital.id}, ${mainBranch.id}, 'nurse', true)
      on conflict do nothing
    `;
  }
  console.log(`  ✓ Ward Nurse User: ${nurseUser.name} (${nurseUser.email})`);

  const [ownerUser] = await admin`
    select u.id, u.name from users u
    join staff_memberships sm on sm.user_id = u.id
    where sm.hospital_id = ${hospital.id} and sm.role = 'owner'
    limit 1
  `;

  // 5. Setup Charge Items for Room & Care Entries
  console.log('  → Setting up Room & Service charge items...');
  const chargeItemsToSeed = [
    { kind: 'room', name: 'Female Medical Ward Bed', unit: 'day', sellingPricePaise: 120000 },
    { kind: 'room', name: 'ICU Bed Charge', unit: 'day', sellingPricePaise: 350000 },
    { kind: 'room', name: 'General Ward Bed', unit: 'day', sellingPricePaise: 80000 },
    { kind: 'service', name: 'Inpatient Nursing Care Charge', unit: 'day', sellingPricePaise: 50000 },
    { kind: 'service', name: 'Doctor Inpatient Evaluation Visit', unit: 'visit', sellingPricePaise: 60000 },
    { kind: 'consumable', name: 'IV Cannula 20G Pink', unit: 'piece', sellingPricePaise: 9500 },
    { kind: 'consumable', name: 'IV Infusion Administration Set', unit: 'piece', sellingPricePaise: 8000 },
    { kind: 'consumable', name: 'Disposable Syringe 5ml with needle', unit: 'piece', sellingPricePaise: 2500 },
    { kind: 'consumable', name: 'Sterile Examination Gloves (Pair)', unit: 'pair', sellingPricePaise: 4000 },
  ];

  const chargeItemMap = new Map<string, string>();
  for (const item of chargeItemsToSeed) {
    const [row] = await admin`
      insert into charge_items
        (hospital_id, kind, name, unit, selling_price_paise, active)
      values
        (${hospital.id}, ${item.kind}, ${item.name}, ${item.unit}, ${item.sellingPricePaise}, true)
      on conflict (hospital_id, kind, lower(name)) do update
      set selling_price_paise = excluded.selling_price_paise,
          active = true
      returning id, name
    `;
    chargeItemMap.set(item.name, row.id);
  }

  // 6. Setup Inpatient Medicines Catalog
  console.log('  → Setting up Inpatient Medicines Catalog...');
  const medicinesToSeed = [
    { name: 'Ceftriaxone 1g Inj', genericName: 'Ceftriaxone', form: 'Injection', unit: 'vial', sellingPricePaise: 45000 },
    { name: 'Pantoprazole 40mg Tab', genericName: 'Pantoprazole', form: 'Tablet', unit: 'tablet', sellingPricePaise: 1500 },
    { name: 'Paracetamol 1g IV Infusion', genericName: 'Paracetamol', form: 'Infusion', unit: 'bottle', sellingPricePaise: 12000 },
    { name: 'Paracetamol 650mg Tab', genericName: 'Paracetamol', form: 'Tablet', unit: 'tablet', sellingPricePaise: 250 },
    { name: 'Ondansetron 4mg Inj', genericName: 'Ondansetron', form: 'Injection', unit: 'ampoule', sellingPricePaise: 3500 },
    { name: 'Tramadol 50mg Inj', genericName: 'Tramadol', form: 'Injection', unit: 'ampoule', sellingPricePaise: 6000 },
    { name: 'Hydrocortisone 100mg Inj', genericName: 'Hydrocortisone', form: 'Injection', unit: 'vial', sellingPricePaise: 8500 },
    { name: 'Cefixime 200mg Tab', genericName: 'Cefixime', form: 'Tablet', unit: 'tablet', sellingPricePaise: 2200 },
    { name: 'Metformin 500mg Tab', genericName: 'Metformin', form: 'Tablet', unit: 'tablet', sellingPricePaise: 300 },
    { name: 'Thyronorm 50mcg Tab', genericName: 'Thyroxine Sodium', form: 'Tablet', unit: 'tablet', sellingPricePaise: 450 },
    { name: 'Normal Saline 0.9% 500ml', genericName: 'Sodium Chloride', form: 'Infusion', unit: 'bottle', sellingPricePaise: 6500 },
    { name: 'Ringer Lactate 500ml', genericName: 'Ringer Lactate', form: 'Infusion', unit: 'bottle', sellingPricePaise: 7000 },
  ];

  const medicineMap = new Map<string, string>();
  for (const med of medicinesToSeed) {
    const [row] = await admin`
      insert into medicines
        (hospital_id, name, generic_name, form, unit, selling_price_paise, active)
      values
        (${hospital.id}, ${med.name}, ${med.genericName}, ${med.form}, ${med.unit}, ${med.sellingPricePaise}, true)
      on conflict (hospital_id, lower(name), coalesce(lower(strength), ''), coalesce(lower(form), '')) do update
      set selling_price_paise = excluded.selling_price_paise,
          generic_name = excluded.generic_name,
          active = true
      returning id, name
    `;
    medicineMap.set(med.name, row.id);
  }

  // 7. Setup Wards & Beds
  console.log('  → Setting up Wards & Beds...');
  const [femaleWard] = await admin`
    insert into wards
      (hospital_id, branch_id, name, sort_order, daily_charge_item_id, active)
    values
      (${hospital.id}, ${mainBranch.id}, 'Female Medical Ward', 1, ${chargeItemMap.get('Female Medical Ward Bed') ?? null}, true)
    on conflict (hospital_id, branch_id, lower(name)) do update
    set daily_charge_item_id = excluded.daily_charge_item_id,
        active = true
    returning id, name
  `;

  const [icuWard] = await admin`
    insert into wards
      (hospital_id, branch_id, name, sort_order, daily_charge_item_id, active)
    values
      (${hospital.id}, ${mainBranch.id}, 'ICU / High Dependency Unit', 2, ${chargeItemMap.get('ICU Bed Charge') ?? null}, true)
    on conflict (hospital_id, branch_id, lower(name)) do update
    set daily_charge_item_id = excluded.daily_charge_item_id,
        active = true
    returning id, name
  `;

  // Create Beds in Female Medical Ward
  const femaleBedsData = [
    { label: 'F-01', status: 'vacant', sortOrder: 1 },
    { label: 'F-02', status: 'vacant', sortOrder: 2 },
    { label: 'F-03', status: 'cleaning', sortOrder: 3 }, // Showcases Bed Cleaning state!
    { label: 'F-04', status: 'vacant', sortOrder: 4 },
    { label: '12', status: 'vacant', sortOrder: 12 },    // Kavita Shinde's bed
  ];

  const bedMap = new Map<string, string>();
  for (const b of femaleBedsData) {
    const [bedRow] = await admin`
      insert into beds
        (hospital_id, ward_id, label, sort_order, status, active)
      values
        (${hospital.id}, ${femaleWard.id}, ${b.label}, ${b.sortOrder}, ${b.status}, true)
      on conflict (ward_id, lower(label)) do update
      set sort_order = excluded.sort_order,
          active = true
      returning id, label
    `;
    bedMap.set(b.label, bedRow.id);
  }

  // Create Beds in ICU
  await admin`
    insert into beds
      (hospital_id, ward_id, label, sort_order, status, active)
    values
      (${hospital.id}, ${icuWard.id}, 'ICU-01', 1, 'vacant', true),
      (${hospital.id}, ${icuWard.id}, 'ICU-02', 2, 'maintenance', true)
    on conflict (ward_id, lower(label)) do nothing
  `;

  const kavitaBedId = bedMap.get('12')!;

  // 8. Find or Create Kavita Shinde Patient
  console.log('  → Locating Kavita Shinde patient record...');
  let [kavita] = await admin`
    select id, name, gender, phone_e164 from patients
    where hospital_id = ${hospital.id} and name = 'Kavita Shinde'
    limit 1
  `;
  if (!kavita) {
    [kavita] = await admin`
      insert into patients
        (hospital_id, name, gender, phone_e164, age)
      values
        (${hospital.id}, 'Kavita Shinde', 'Female', '+919822010023', 33)
      returning id, name, gender, phone_e164
    `;
  }
  console.log(`  ✓ Kavita Shinde ID: ${kavita.id}`);

  // 9. Clean up any prior IPD records for Kavita Shinde cleanly
  console.log('  → Resetting any prior IPD records for Kavita Shinde...');
  await admin`set session_replication_role = 'replica'`;
  const existingAdm = await admin`select id from admissions where hospital_id = ${hospital.id} and patient_id = ${kavita.id}`;
  for (const a of existingAdm) {
    await admin`delete from ipd_take_home_prescriptions where hospital_id = ${hospital.id}`;
    await admin`delete from ipd_discharge_summaries where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from ipd_admission_home_medications where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from patient_measurements where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from vitals_readings where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from intake_output where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from ipd_clinical_tasks where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from ipd_emar_integration_outbox where hospital_id = ${hospital.id}`;
    await admin`delete from ipd_medication_administrations where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from ipd_medication_order_actions where hospital_id = ${hospital.id}`;
    await admin`delete from ipd_medication_orders where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from ipd_clinical_rounds where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from ipd_allergy_assessments where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from bed_assignments where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from bill_items where hospital_id = ${hospital.id}`;
    await admin`delete from patient_payments where hospital_id = ${hospital.id} and patient_id = ${kavita.id}`;
    await admin`delete from bills where hospital_id = ${hospital.id} and patient_id = ${kavita.id}`;
    await admin`delete from care_entries where hospital_id = ${hospital.id} and admission_id = ${a.id}`;
    await admin`delete from admissions where id = ${a.id}`;
  }
  await admin`delete from encounters where hospital_id = ${hospital.id} and patient_id = ${kavita.id} and stage = 'ipd'`;
  await admin`set session_replication_role = 'origin'`;

  // 10. Create Encounter & Admission (Admitted 3 days ago)
  console.log('  → Creating Inpatient Admission (IPD #6159)...');
  const admissionTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const [encounter] = await admin`
    insert into encounters
      (hospital_id, branch_id, patient_id, attending_doctor_id, origin, stage, status, opened_at)
    values
      (${hospital.id}, ${mainBranch.id}, ${kavita.id}, ${attendingDoctor.id}, 'emergency', 'ipd', 'open', ${admissionTime})
    returning id
  `;

  const [admission] = await admin`
    insert into admissions
      (hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id,
       status, ipd_number, reason, vitals_frequency, admitted_at, requested_at)
    values
      (${hospital.id}, ${encounter.id}, ${kavita.id}, ${mainBranch.id}, ${attendingDoctor.id},
       'admitted', 6159, 'Acute Pyelonephritis (Right Kidney) with High-Grade Fever, Chills & Dysuria', 'q4h', ${admissionTime}, ${admissionTime})
    returning id, ipd_number
  `;
  console.log(`  ✓ Admission Created: ID ${admission.id} (IPD #${admission.ipd_number})`);

  // 11. Assign Bed 12
  await admin`
    insert into bed_assignments
      (hospital_id, admission_id, bed_id, from_at, assigned_by_user_id)
    values
      (${hospital.id}, ${admission.id}, ${kavitaBedId}, ${admissionTime}, ${ownerUser.id})
  `;
  await admin`
    update beds set status = 'occupied' where id = ${kavitaBedId}
  `;
  console.log(`  ✓ Assigned to Female Medical Ward · Bed 12`);

  // 12. Allergy Assessment: Severe Penicillin allergy documented
  console.log('  → Recording verified Drug Allergy Assessment...');
  await admin`
    insert into ipd_allergy_assessments
      (hospital_id, admission_id, encounter_id, patient_id, status, allergens, is_current, reviewed_by_user_id, reviewed_at)
    values
      (${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, 'allergies_documented',
       ${JSON.stringify([
         {
           substance: 'Penicillin / Amoxicillin',
           reaction: 'Severe Urticaria, Facial Angioedema & Bronchospasm',
           severity: 'severe',
         },
       ])}::jsonb,
       true, ${attendingDoctor.user_id ?? ownerUser.id}, ${admissionTime})
  `;

  // 13. Patient Measurements Timeline (Weight, Height, BMI)
  console.log('  → Recording Body Measurements Timeline...');
  await admin`
    insert into patient_measurements
      (hospital_id, patient_id, admission_id, recorded_at, weight_kg, height_cm, bmi, notes, recorded_by_user_id)
    values
      (${hospital.id}, ${kavita.id}, ${admission.id}, ${admissionTime}, 62.00, 162.0, 23.6, 'Admission baseline measurement. Well hydrated.', ${nurseUser.id}),
      (${hospital.id}, ${kavita.id}, ${admission.id}, now() - interval '2 hours', 62.50, 162.0, 23.8, 'Daily follow-up measurement. Weight stable, adequate oral intake.', ${nurseUser.id})
  `;

  // 14. Vitals Readings & NEWS2 Deterioration Progression
  console.log('  → Recording Vitals Progression & NEWS2 Score...');
  await admin`
    insert into vitals_readings
      (hospital_id, admission_id, recorded_at, temperature_f, pulse_bpm, bp_systolic, bp_diastolic,
       respiratory_rate, spo2_percent, pain_score, avpu, news2_score, bsl, recorded_by_user_id)
    values
      -- Admission Day 1: High fever, tachycardia, tachypnea (NEWS2 = 4)
      (${hospital.id}, ${admission.id}, ${admissionTime}, 101.8, 108, 112, 74, 22, 97, 7, 'A', 4, 148, ${nurseUser.id}),
      -- Day 2: Settling down (NEWS2 = 1)
      (${hospital.id}, ${admission.id}, now() - interval '1 day 4 hours', 99.4, 90, 118, 76, 18, 98, 4, 'A', 1, 132, ${nurseUser.id}),
      -- Day 3 Today: Stable and afebrile (NEWS2 = 0)
      (${hospital.id}, ${admission.id}, now() - interval '4 hours', 98.4, 78, 120, 80, 16, 99, 1, 'A', 0, 118, ${nurseUser.id})
  `;

  // 15. Intake / Output Fluid Balance
  console.log('  → Recording Intake / Output Fluid Balance...');
  await admin`
    insert into intake_output
      (hospital_id, admission_id, recorded_at, kind, ml, notes, recorded_by_user_id)
    values
      (${hospital.id}, ${admission.id}, ${admissionTime} + interval '6 hours', 'IV', 1000, 'Normal Saline 0.9% infusion', ${nurseUser.id}),
      (${hospital.id}, ${admission.id}, ${admissionTime} + interval '8 hours', 'ORAL', 800, 'Water and electrolyte soup', ${nurseUser.id}),
      (${hospital.id}, ${admission.id}, ${admissionTime} + interval '12 hours', 'URINE', 1400, 'Clear amber urine via foley', ${nurseUser.id}),
      (${hospital.id}, ${admission.id}, now() - interval '1 day 2 hours', 'ORAL', 1500, 'Oral fluids', ${nurseUser.id}),
      (${hospital.id}, ${admission.id}, now() - interval '1 day', 'URINE', 1750, 'Adequate spontaneous voiding', ${nurseUser.id}),
      (${hospital.id}, ${admission.id}, now() - interval '3 hours', 'ORAL', 1200, 'Oral breakfast and water', ${nurseUser.id}),
      (${hospital.id}, ${admission.id}, now() - interval '1 hour', 'URINE', 950, 'Clear urine', ${nurseUser.id})
  `;

  // 16. Doctor Clinical Rounds & Notes
  console.log('  → Recording Daily Doctor Evaluations (Rounds)...');
  const round1Id = uuidv4();
  const round2Id = uuidv4();
  const round3Id = uuidv4();

  await admin`
    insert into ipd_clinical_rounds
      (id, hospital_id, admission_id, encounter_id, patient_id, doctor_id, author_user_id,
       evaluation_notes, status, version, signed_at, created_at)
    values
      (${round1Id}, ${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, ${attendingDoctor.id}, ${ownerUser.id},
       'Day 1 Admission Round: 33yo female presented with acute right flank pain, high-grade fever with chills x 3 days, and dysuria. Positive right renal angle tenderness. Known case of T2DM on Metformin. Urine analysis confirms severe pyuria (>30 pus cells). Commencing parenteral Ceftriaxone 1g BD, IV hydration, and antipyretics. Diabetic renal diet with q4h vitals monitoring.',
       'signed', 1, ${admissionTime} + interval '2 hours', ${admissionTime} + interval '2 hours'),
      (${round2Id}, ${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, ${attendingDoctor.id}, ${ownerUser.id},
       'Day 2 Morning Round: Patient afebrile for 18h. Flank tenderness significantly subsided. Tolerating oral diet well. Urine output adequate (1800ml/24h). Urine culture reports E. Coli sensitive to Ceftriaxone. Continue current antibiotics and IV fluids.',
       'signed', 1, now() - interval '1 day 2 hours', now() - interval '1 day 2 hours'),
      (${round3Id}, ${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, ${attendingDoctor.id}, ${ownerUser.id},
       'Day 3 Morning Round: Patient markedly improved. Afebrile for 48 hours. Burning micturition completely resolved. Hemodynamically stable. Plan for step-down to oral Cefixime and discharge tomorrow morning. Home medications reconciled.',
       'signed', 1, now() - interval '3 hours', now() - interval '3 hours')
  `;

  // 17. Admission Home Medication Reconciliation
  console.log('  → Recording Admission Home Medication Reconciliation...');
  await admin`
    insert into ipd_admission_home_medications
      (hospital_id, admission_id, medicine_name, dosage, frequency, reconciliation_status, reconciliation_notes, recorded_by_user_id)
    values
      (${hospital.id}, ${admission.id}, 'Tab Metformin 500mg', '500mg', 'BD', 'continued', 'Continue regular diabetic therapy after meals', ${nurseUser.id}),
      (${hospital.id}, ${admission.id}, 'Tab Thyronorm 50mcg', '50mcg', 'OD', 'continued', 'Continue thyroid supplement early morning empty stomach', ${nurseUser.id}),
      (${hospital.id}, ${admission.id}, 'Tab Combiflam (Ibuprofen + Paracetamol)', '1 Tab', 'PRN', 'stopped', 'Stopped due to acute pyelonephritis / renal safety caution. Replaced by IV Paracetamol as needed.', ${nurseUser.id})
  `;

  // 18. Medication Orders & Bedside eMAR
  console.log('  → Prescribing Medication Orders & Bedside eMAR schedule...');
  const orderCeftriaxoneId = uuidv4();
  const orderPantoId = uuidv4();
  const orderOndansetronId = uuidv4();
  const orderVerbalHydrocortId = uuidv4();

  // Order 1: Ceftriaxone 1g IV BD
  await admin`
    insert into ipd_medication_orders
      (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id,
       medicine_id, medicine_name, strength, form, dose_amount, dose_unit, route,
       schedule_type, frequency_code, schedule_times, is_prn, starts_at, ends_at, duration_days,
       status, prescriber_doctor_id, created_by_user_id, signed_at, round_note_id)
    values
      (${orderCeftriaxoneId}, ${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, ${orderCeftriaxoneId},
       ${medicineMap.get('Ceftriaxone 1g Inj') ?? null}, 'Ceftriaxone 1g Inj', '1g', 'Injection', 1000, 'mg', 'iv_push',
       'scheduled', 'BD', '["08:00", "20:00"]'::jsonb, false, ${admissionTime}, now() + interval '2 days', 5,
       'active', ${attendingDoctor.id}, ${ownerUser.id}, ${admissionTime} + interval '2 hours', ${round1Id})
  `;
  await admin`
    insert into ipd_medication_order_actions
      (hospital_id, order_id, action, actor_user_id, doctor_id, occurred_at)
    values
      (${hospital.id}, ${orderCeftriaxoneId}, 'sign', ${ownerUser.id}, ${attendingDoctor.id}, ${admissionTime} + interval '2 hours')
  `;

  // Order 2: Pantoprazole 40mg Oral OD
  await admin`
    insert into ipd_medication_orders
      (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id,
       medicine_id, medicine_name, strength, form, dose_amount, dose_unit, route,
       schedule_type, frequency_code, schedule_times, is_prn, starts_at, ends_at, duration_days,
       status, prescriber_doctor_id, created_by_user_id, signed_at, round_note_id)
    values
      (${orderPantoId}, ${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, ${orderPantoId},
       ${medicineMap.get('Pantoprazole 40mg Tab') ?? null}, 'Pantoprazole 40mg Tab', '40mg', 'Tablet', 40, 'mg', 'oral',
       'scheduled', 'OD', '["08:00"]'::jsonb, false, ${admissionTime}, now() + interval '2 days', 5,
       'active', ${attendingDoctor.id}, ${ownerUser.id}, ${admissionTime} + interval '2 hours', ${round1Id})
  `;
  await admin`
    insert into ipd_medication_order_actions
      (hospital_id, order_id, action, actor_user_id, doctor_id, occurred_at)
    values
      (${hospital.id}, ${orderPantoId}, 'sign', ${ownerUser.id}, ${attendingDoctor.id}, ${admissionTime} + interval '2 hours')
  `;

  // Order 3: Ondansetron 4mg IV PRN (SOS)
  await admin`
    insert into ipd_medication_orders
      (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id,
       medicine_id, medicine_name, strength, form, dose_amount, dose_unit, route,
       schedule_type, is_prn, prn_indication, prn_min_interval_hours, prn_max_daily_doses,
       starts_at, ends_at, duration_days, status, prescriber_doctor_id, created_by_user_id, signed_at, round_note_id)
    values
      (${orderOndansetronId}, ${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, ${orderOndansetronId},
       ${medicineMap.get('Ondansetron 4mg Inj') ?? null}, 'Ondansetron 4mg Inj', '4mg', 'Injection', 4, 'mg', 'iv_push',
       'prn', true, 'Nausea or acute vomiting', 8, 3,
       ${admissionTime}, now() + interval '2 days', 5, 'active', ${attendingDoctor.id}, ${ownerUser.id}, ${admissionTime} + interval '2 hours', ${round1Id})
  `;
  await admin`
    insert into ipd_medication_order_actions
      (hospital_id, order_id, action, actor_user_id, doctor_id, occurred_at)
    values
      (${hospital.id}, ${orderOndansetronId}, 'sign', ${ownerUser.id}, ${attendingDoctor.id}, ${admissionTime} + interval '2 hours')
  `;

  // Order 4: Verbal Order with Pending Co-Sign (Hydrocortisone 100mg IV)
  await admin`
    insert into ipd_medication_orders
      (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id,
       medicine_id, medicine_name, strength, form, dose_amount, dose_unit, route,
       schedule_type, is_prn, starts_at, ends_at, duration_days, status,
       is_verbal, verbal_order_status, verbal_doctor_name, verbal_clinical_rationale,
       prescriber_doctor_id, created_by_user_id, signed_at)
    values
      (${orderVerbalHydrocortId}, ${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, ${orderVerbalHydrocortId},
       ${medicineMap.get('Hydrocortisone 100mg Inj') ?? null}, 'Hydrocortisone 100mg Inj', '100mg', 'Injection', 100, 'mg', 'iv_push',
       'stat', false, now() - interval '6 hours', now() + interval '12 hours', 1, 'active',
       true, 'pending_cosign', 'Dr. Rajesh Kulkarni', 'Telephone instruction given during acute urticarial rash flare-up in emergency',
       ${attendingDoctor.id}, ${nurseUser.id}, now() - interval '6 hours')
  `;
  await admin`
    insert into ipd_medication_order_actions
      (hospital_id, order_id, action, actor_user_id, doctor_id, occurred_at, reason)
    values
      (${hospital.id}, ${orderVerbalHydrocortId}, 'sign', ${nurseUser.id}, ${attendingDoctor.id}, now() - interval '6 hours', 'Nurse entered urgent verbal order')
  `;

  // 19. Record Administrations for eMAR
  console.log('  → Logging Bedside eMAR administrations...');
  // Past administrations for Ceftriaxone
  const adminTimes = [
    admissionTime,
    new Date(admissionTime.getTime() + 12 * 60 * 60 * 1000),
    new Date(admissionTime.getTime() + 24 * 60 * 60 * 1000),
    new Date(admissionTime.getTime() + 36 * 60 * 60 * 1000),
    new Date(Date.now() - 2 * 60 * 60 * 1000), // Today morning 08:00 dose
  ];

  for (const t of adminTimes) {
    const adminId = uuidv4();
    await admin`
      insert into ipd_medication_administrations
        (id, hospital_id, admission_id, order_id, order_chain_id, client_id,
         scheduled_time, actual_time, decision_time, outcome, dose_given,
         dose_amount_numeric, route_given, nurse_user_id, recorded_at)
      values
        (${adminId}, ${hospital.id}, ${admission.id}, ${orderCeftriaxoneId}, ${orderCeftriaxoneId}, ${uuidv4()},
         ${t}, ${t}, null, 'administered', '1000 mg', 1000, 'iv_push', ${nurseUser.id}, ${t})
    `;
  }

  // Administration for PRN Ondansetron
  await admin`
    insert into ipd_medication_administrations
      (id, hospital_id, admission_id, order_id, order_chain_id, client_id,
       actual_time, decision_time, outcome, dose_given,
       dose_amount_numeric, route_given, clinical_note, nurse_user_id, recorded_at)
    values
      (${uuidv4()}, ${hospital.id}, ${admission.id}, ${orderOndansetronId}, ${orderOndansetronId}, ${uuidv4()},
       ${admissionTime} + interval '4 hours', null, 'administered', '4 mg',
       4, 'iv_push', 'Administered for breakthrough acute nausea after admission', ${nurseUser.id}, ${admissionTime} + interval '4 hours')
  `;

  // Administration for Verbal Hydrocortisone
  await admin`
    insert into ipd_medication_administrations
      (id, hospital_id, admission_id, order_id, order_chain_id, client_id,
       actual_time, decision_time, outcome, dose_given,
       dose_amount_numeric, route_given, clinical_note, nurse_user_id, recorded_at)
    values
      (${uuidv4()}, ${hospital.id}, ${admission.id}, ${orderVerbalHydrocortId}, ${orderVerbalHydrocortId}, ${uuidv4()},
       now() - interval '5 hours', null, 'administered', '100 mg',
       100, 'iv_push', 'Stat dose administered as per verbal order by Dr. Kulkarni', ${nurseUser.id}, now() - interval '5 hours')
  `;

  // 20. Clinical Tasks
  console.log('  → Adding Clinical Tasks...');
  await admin`
    insert into ipd_clinical_tasks
      (hospital_id, order_id, admission_id, scheduled_at, status, note, acted_by_user_id, acted_at)
    values
      (${hospital.id}, ${orderCeftriaxoneId}, ${admission.id}, now() - interval '2 hours', 'GIVEN', 'Morning IV antibiotic dose administered on schedule', ${nurseUser.id}, now() - interval '2 hours'),
      (${hospital.id}, ${orderCeftriaxoneId}, ${admission.id}, now() + interval '2 hours', 'DUE', 'Evening IV antibiotic dose scheduled for 20:00', null, null),
      (${hospital.id}, ${orderPantoId}, ${admission.id}, now() + interval '14 hours', 'DUE', 'Morning empty stomach PPI tablet', null, null)
  `;

  // 21. Bedside Care Entries (Consumables, Syringes, Fluids)
  console.log('  → Posting Bedside Care Entries & Consumables...');
  const careItems = [
    { name: 'IV Cannula 20G Pink', qty: 1, time: admissionTime },
    { name: 'IV Infusion Administration Set', qty: 1, time: admissionTime },
    { name: 'Disposable Syringe 5ml with needle', qty: 4, time: new Date(admissionTime.getTime() + 12 * 60 * 60 * 1000) },
    { name: 'Sterile Examination Gloves (Pair)', qty: 3, time: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  ];

  for (const c of careItems) {
    const chargeItemId = chargeItemMap.get(c.name);
    if (chargeItemId) {
      await admin`
        insert into care_entries
          (hospital_id, admission_id, encounter_id, patient_id, charge_item_id, description, quantity, occurred_at, recorded_by_user_id, client_id)
        values
          (${hospital.id}, ${admission.id}, ${encounter.id}, ${kavita.id}, ${chargeItemId}, ${c.name}, ${c.qty}, ${c.time}, ${nurseUser.id}, ${uuidv4()})
      `;
    }
  }

  // 22. Initial Deposit Payment (₹10,000 Advance)
  console.log('  → Recording Admission Deposit Payment (₹10,000)...');
  await admin`
    insert into patient_payments
      (hospital_id, encounter_id, patient_id, kind, amount_paise, method, reference, received_at, received_by_user_id)
    values
      (${hospital.id}, ${encounter.id}, ${kavita.id}, 'payment', 1000000, 'upi', 'Admission Advance Deposit (UPI/2026/89401294)', ${admissionTime}, ${ownerUser.id})
  `;

  // 23. Draft Versioned Discharge Summary with Structured Take-Home Prescriptions
  console.log('  → Creating Versioned Discharge Summary & Take-Home Prescriptions...');
  const [dischargeSummary] = await admin`
    insert into ipd_discharge_summaries
      (hospital_id, admission_id, version, discharge_type, status,
       primary_diagnosis, secondary_diagnoses, hospital_course, condition_at_discharge,
       investigation_summary, discharge_advice, diet_advice, urgent_warning_signs,
       follow_up_date, prescriber_doctor_id, prescriber_registration_no)
    values
      (${hospital.id}, ${admission.id}, 1, 'regular', 'draft',
       'Acute Pyelonephritis (Right Kidney) - Resolving',
       'Type 2 Diabetes Mellitus, Hypothyroidism',
       '33-year-old female admitted via emergency with high-grade fever, chills, vomiting, and severe right loin pain. Evaluated and diagnosed with acute pyelonephritis. Commenced on parenteral Ceftriaxone, IV fluids, and strict vitals monitoring. Patient responded favorably, became afebrile after 36 hours. Urine culture showed E. Coli sensitive to Cephalosporins. Inflammatory markers showed marked improvement. Step-down oral therapy initiated.',
       'Patient is hemodynamically stable, afebrile, tolerating oral diet, and voiding clear urine without pain.',
       'CBC: TLC reduced from 16,800 to 7,400 /cu.mm. Urine R/M: Pus cells decreased from 30-40 to 2-3 /HPF. Renal Function: Serum Creatinine 0.8 mg/dL, Blood Urea 24 mg/dL. USG Abdomen: Mild right renal enlargement, no hydronephrosis, no calculi.',
       'Complete the full 5-day course of oral antibiotics without skipping. Maintain adequate daily oral fluid intake (minimum 2.5 to 3 liters per day). Strict hygiene and glycemic control.',
       'Diabetic renal-safe diet: Low salt, low refined carbohydrates, high fiber, plenty of warm boiled water.',
       'Seek immediate emergency medical attention in case of recurrent high-grade fever with chills, vomiting, flank pain, hematuria, or sudden drop in urine output.',
       ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]},
       ${attendingDoctor.id}, 'MMC-2012-08492')
    returning id, status
  `;

  // Structured Take-Home Prescriptions
  const takeHomeRx = [
    { medicineName: 'Tab Cefixime 200mg', dosage: '200mg', route: 'oral', frequency: '1 Tab Twice Daily (BD)', duration: '5 days', instructions: 'Take after food with water' },
    { medicineName: 'Tab Pantoprazole 40mg', dosage: '40mg', route: 'oral', frequency: '1 Tab Once Daily (OD)', duration: '7 days', instructions: 'Take 30 minutes before breakfast' },
    { medicineName: 'Tab Paracetamol 650mg', dosage: '650mg', route: 'oral', frequency: '1 Tab SOS / PRN', duration: '3 days', instructions: 'Take only in case of fever > 100°F or body pain (max 3 times/day)' },
    { medicineName: 'Tab Metformin 500mg', dosage: '500mg', route: 'oral', frequency: '1 Tab Twice Daily (BD)', duration: '30 days', instructions: 'Continue regular diabetic therapy after meals' },
    { medicineName: 'Tab Thyronorm 50mcg', dosage: '50mcg', route: 'oral', frequency: '1 Tab Once Daily (OD)', duration: '30 days', instructions: 'First thing in morning empty stomach with water' },
  ];

  for (const rx of takeHomeRx) {
    await admin`
      insert into ipd_take_home_prescriptions
        (hospital_id, discharge_summary_id, medicine_name, dosage, route, frequency, duration, instructions)
      values
        (${hospital.id}, ${dischargeSummary.id}, ${rx.medicineName}, ${rx.dosage}, ${rx.route}, ${rx.frequency}, ${rx.duration}, ${rx.instructions})
    `;
  }

  console.log('\n✨ ============================================================ ✨');
  console.log('🎉 KAVITA SHINDE IPD SHOWCASE DATA POPULATED SUCCESSFULLY!');
  console.log('✨ ============================================================ ✨\n');
  console.log(`👤 Patient:        Kavita Shinde (33 yrs, Female)`);
  console.log(`🏥 Hospital:       ${hospital.name}`);
  console.log(`🛏️ Bed / Ward:     Female Medical Ward · Bed 12 (Bed F-03 is in 'cleaning' state)`);
  console.log(`📋 IPD No:         #${admission.ipd_number}`);
  console.log(`👨‍⚕️ Attending:     ${attendingDoctor.name} [Reg: ${attendingDoctor.registration_no}]`);
  console.log(`🚨 Allergy:        Penicillin / Amoxicillin (Severe - Red Badge Active)`);
  console.log(`⚖️ Measurements:   62.5 kg, 162 cm, BMI 23.8 (Normal weight)`);
  console.log(`💓 Vitals & NEWS2: Temperature 98.4°F, Pulse 78, BP 120/80, NEWS2 = 0`);
  console.log(`💊 eMAR:           Scheduled BD Ceftriaxone & OD Pantoprazole`);
  console.log(`📞 Verbal Order:   Hydrocortisone 100mg IV -> 'pending_cosign' (Showcases Verbal Co-Sign!)`);
  console.log(`📄 Discharge:      Draft Summary with 5 Structured Take-Home Prescriptions`);
  console.log(`💳 Billing:        Deposit of ₹10,000 recorded; Bed-days & Consumables active`);
  console.log(`\n🔗 Open Directly in Browser:`);
  console.log(`   • Inpatient Chart: /ipd/patients/${admission.id}`);
  console.log(`   • Treatment / eMAR: /ipd/patients/${admission.id}?tab=treatment`);
  console.log(`   • Vitals & NEWS2:   /ipd/patients/${admission.id}?tab=vitals`);
  console.log(`   • Discharge Tab:    /ipd/patients/${admission.id}?tab=discharge`);
  console.log(`   • Billing Tab:      /ipd/patients/${admission.id}?tab=billing`);
  console.log(`   • Ward Census View: /ipd\n`);

  await admin.end();
  process.exit(0);
}

seedKavitaIpd().catch(async (err) => {
  console.error('❌ Error seeding Kavita Shinde IPD mock data:', err);
  await admin.end();
  process.exit(1);
});
