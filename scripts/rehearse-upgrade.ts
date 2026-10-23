import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const UPGRADE_DB = 'qurio_upgrade_rehearsal';
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appRole = process.env.APP_DB_ROLE ?? 'opd_app';

if (!adminUrl) {
  console.error('DATABASE_ADMIN_URL is not set');
  process.exit(1);
}

const urlFor = (base: string, dbName: string) => {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
};

async function main() {
  console.log('===============================================================');
  console.log('STARTING CLAIMS 0066 -> 0067 UPGRADE REHEARSAL WITH SEEDED DATA');
  console.log('===============================================================');

  const rootAdmin = postgres(adminUrl!, { max: 1, connect_timeout: 20 });

  // 1. Clean previous rehearsal if existing and create fresh database
  await rootAdmin.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`);
  await rootAdmin.unsafe(`CREATE DATABASE ${UPGRADE_DB}`);
  console.log(`[1/6] Created fresh throwaway rehearsal database: ${UPGRADE_DB}`);
  await rootAdmin.end();

  const rehearsalAdminUrl = urlFor(adminUrl!, UPGRADE_DB);
  const sql = postgres(rehearsalAdminUrl, { max: 1, connect_timeout: 20 });

  try {
    // 2. Prepare 0000..0066 migration bundle in temp folder
    const tempMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drizzle-0066-'));
    const drizzleDir = path.resolve(process.cwd(), 'drizzle');
    const journalPath = path.join(drizzleDir, 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));

    // Filter journal up to idx 51 (0066_claims_tracker_and_tpa_desk)
    const entriesUpTo0066 = journal.entries.filter((e: any) => e.idx <= 51);
    const tempJournal = { ...journal, entries: entriesUpTo0066 };

    fs.mkdirSync(path.join(tempMigrationsDir, 'meta'), { recursive: true });
    fs.writeFileSync(
      path.join(tempMigrationsDir, 'meta', '_journal.json'),
      JSON.stringify(tempJournal, null, 2),
      'utf8'
    );

    for (const entry of entriesUpTo0066) {
      const fileName = `${entry.tag}.sql`;
      const srcFile = path.join(drizzleDir, fileName);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(tempMigrationsDir, fileName));
      }
    }

    // 3. Migrate database up to 0066
    await sql`select set_config('qurio.app_role', ${appRole}, false)`;
    await migrate(drizzle(sql), { migrationsFolder: tempMigrationsDir });
    console.log('[2/6] Successfully applied migrations 0000 through 0066');

    // Clean up temp migration dir
    fs.rmSync(tempMigrationsDir, { recursive: true, force: true });

    // 4. Seed 0066-era legacy claims data
    const hospitalId = crypto.randomUUID();
    const branchId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const patient1Id = crypto.randomUUID();
    const patient2Id = crypto.randomUUID();
    const patient3Id = crypto.randomUUID();
    const encounter1Id = crypto.randomUUID();
    const encounter2Id = crypto.randomUUID();
    const encounter3Id = crypto.randomUUID();
    const admission1Id = crypto.randomUUID();
    const admission2Id = crypto.randomUUID();
    const admission3Id = crypto.randomUUID();
    const payerId = crypto.randomUUID();
    const encPayer1Id = crypto.randomUUID();
    const encPayer2Id = crypto.randomUUID();
    const encPayer3Id = crypto.randomUUID();

    const claimSettledId = crypto.randomUUID();
    const claimPartialId = crypto.randomUUID();
    const claimActiveId = crypto.randomUUID();

    await sql`
      insert into hospitals (id, name, slug) values
      (${hospitalId}, 'Rehearsal Apollo Hospital', 'reh-apollo')
    `;

    await sql`
      insert into branches (id, hospital_id, name) values
      (${branchId}, ${hospitalId}, 'Main Campus')
    `;

    await sql`
      insert into users (id, name, email, password_hash) values
      (${userId}, 'Dr. Rehearsal Claims', 'claims@rehearsal.org', 'rehearsal_hash')
    `;

    await sql`
      insert into patients (id, hospital_id, name, gender, phone_e164) values
      (${patient1Id}, ${hospitalId}, 'Patient A (Settled)', 'female', '+919800000001'),
      (${patient2Id}, ${hospitalId}, 'Patient B (Partial)', 'male', '+919800000002'),
      (${patient3Id}, ${hospitalId}, 'Patient C (Active)', 'female', '+919800000003')
    `;

    const doctorId = crypto.randomUUID();

    await sql`
      insert into doctors (id, hospital_id, branch_id, name) values
      (${doctorId}, ${hospitalId}, ${branchId}, 'Dr. Star Doctor')
    `;

    await sql`
      insert into encounters (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin) values
      (${encounter1Id}, ${hospitalId}, ${branchId}, ${patient1Id}, ${doctorId}, 'direct'),
      (${encounter2Id}, ${hospitalId}, ${branchId}, ${patient2Id}, ${doctorId}, 'direct'),
      (${encounter3Id}, ${hospitalId}, ${branchId}, ${patient3Id}, ${doctorId}, 'direct')
    `;

    await sql`
      insert into admissions (id, hospital_id, branch_id, patient_id, encounter_id, admitting_doctor_id, admission_number, status, admitted_at) values
      (${admission1Id}, ${hospitalId}, ${branchId}, ${patient1Id}, ${encounter1Id}, ${doctorId}, 9001, 'admitted', now()),
      (${admission2Id}, ${hospitalId}, ${branchId}, ${patient2Id}, ${encounter2Id}, ${doctorId}, 9002, 'admitted', now()),
      (${admission3Id}, ${hospitalId}, ${branchId}, ${patient3Id}, ${encounter3Id}, ${doctorId}, 9003, 'admitted', now())
    `;

    await sql`
      insert into payer_profiles (id, name, code, category) values
      (${payerId}, 'Star Health Insurance', 'star-reh', 'tpa')
    `;

    await sql`
      insert into encounter_payers (id, hospital_id, encounter_id, patient_id, kind, payer_name) values
      (${encPayer1Id}, ${hospitalId}, ${encounter1Id}, ${patient1Id}, 'insurer', 'Star Health Insurance'),
      (${encPayer2Id}, ${hospitalId}, ${encounter2Id}, ${patient2Id}, 'insurer', 'Star Health Insurance'),
      (${encPayer3Id}, ${hospitalId}, ${encounter3Id}, ${patient3Id}, 'insurer', 'Star Health Insurance')
    `;

    // Legacy Claim 1: Fully settled in 0066 era
    // Note: settled_amount_paise = 4500000 (₹45,000), deduction = 500000 (₹5,000), approved = 5000000
    await sql`
      insert into claim_cases (
        id, hospital_id, branch_id, admission_id, encounter_id, patient_id,
        encounter_payer_id, payer_profile_id, claim_type, status,
        approved_amount_paise, settled_amount_paise, deduction_amount_paise,
        client_id, assigned_staff_user_id
      ) values (
        ${claimSettledId}, ${hospitalId}, ${branchId}, ${admission1Id}, ${encounter1Id}, ${patient1Id},
        ${encPayer1Id}, ${payerId}, 'cashless', 'settled',
        5000000, 4500000, 500000,
        ${crypto.randomUUID()}, ${userId}
      )
    `;

    // Legacy Claim 2: Partially settled in 0066 era
    // settled_amount_paise = 2000000 (₹20,000), approved = 5000000
    await sql`
      insert into claim_cases (
        id, hospital_id, branch_id, admission_id, encounter_id, patient_id,
        encounter_payer_id, payer_profile_id, claim_type, status,
        approved_amount_paise, settled_amount_paise, deduction_amount_paise,
        client_id, assigned_staff_user_id
      ) values (
        ${claimPartialId}, ${hospitalId}, ${branchId}, ${admission2Id}, ${encounter2Id}, ${patient2Id},
        ${encPayer2Id}, ${payerId}, 'cashless', 'partially_settled',
        5000000, 2000000, 0,
        ${crypto.randomUUID()}, ${userId}
      )
    `;

    // Legacy Claim 3: Active unsettled claim in 0066 era
    // settled_amount_paise = NULL, approved = 3000000
    await sql`
      insert into claim_cases (
        id, hospital_id, branch_id, admission_id, encounter_id, patient_id,
        encounter_payer_id, payer_profile_id, claim_type, status,
        approved_amount_paise, settled_amount_paise, deduction_amount_paise,
        client_id, assigned_staff_user_id
      ) values (
        ${claimActiveId}, ${hospitalId}, ${branchId}, ${admission3Id}, ${encounter3Id}, ${patient3Id},
        ${encPayer3Id}, ${payerId}, 'cashless', 'preauth_approved',
        3000000, null, 0,
        ${crypto.randomUUID()}, ${userId}
      )
    `;
    console.log('[3/6] Seeded 3 pre-existing 0066-era claims (Settled, Partial, Active)');

    // 5. Apply Migration 0067
    console.log('[4/6] Applying migration 0067_claims_lifecycle_corrections.sql...');
    const migration0067Sql = fs.readFileSync(
      path.join(drizzleDir, '0067_claims_lifecycle_corrections.sql'),
      'utf8'
    );
    // Execute 0067 statements
    await sql.unsafe(migration0067Sql);
    console.log('[4/6] Migration 0067 applied successfully!');

    // 6. Audit & Verify Backfill Results
    console.log('[5/6] Verifying backfill invariants on pre-existing claims:');

    const [claimSettled] = await sql`select * from claim_cases where id = ${claimSettledId}`;
    const [claimPartial] = await sql`select * from claim_cases where id = ${claimPartialId}`;
    const [claimActive] = await sql`select * from claim_cases where id = ${claimActiveId}`;
    const remittances = await sql`select * from claim_remittances`;

    console.log('\n--- CLAIM 1 (Legacy Settled) ---');
    console.log('Legacy settled_amount_paise preserved:', claimSettled.settled_amount_paise, '(Expected: 4500000)');
    console.log('Legacy deduction_amount_paise preserved:', claimSettled.deduction_amount_paise, '(Expected: 500000)');
    console.log('New settlement_status:', claimSettled.settlement_status, '(Expected: legacy_reconciliation_required)');
    console.log('legacy_reconciliation_required:', claimSettled.legacy_reconciliation_required, '(Expected: true)');
    console.log('total_remitted_paise:', claimSettled.total_remitted_paise, '(Expected: 0 - NOT blindly copied!)');
    console.log('current_authorized_limit_paise:', claimSettled.current_authorized_limit_paise, '(Expected: 5000000)');

    if (
      claimSettled.settlement_status !== 'legacy_reconciliation_required' ||
      claimSettled.legacy_reconciliation_required !== true ||
      Number(claimSettled.total_remitted_paise) !== 0 ||
      Number(claimSettled.settled_amount_paise) !== 4500000
    ) {
      throw new Error('Claim 1 backfill invariant violation!');
    }

    console.log('\n--- CLAIM 2 (Legacy Partially Settled) ---');
    console.log('New settlement_status:', claimPartial.settlement_status, '(Expected: legacy_reconciliation_required)');
    console.log('legacy_reconciliation_required:', claimPartial.legacy_reconciliation_required, '(Expected: true)');
    console.log('total_remitted_paise:', claimPartial.total_remitted_paise, '(Expected: 0)');

    if (
      claimPartial.settlement_status !== 'legacy_reconciliation_required' ||
      claimPartial.legacy_reconciliation_required !== true ||
      Number(claimPartial.total_remitted_paise) !== 0
    ) {
      throw new Error('Claim 2 backfill invariant violation!');
    }

    console.log('\n--- CLAIM 3 (Legacy Active / Unsettled) ---');
    console.log('New settlement_status:', claimActive.settlement_status, '(Expected: unsettled)');
    console.log('legacy_reconciliation_required:', claimActive.legacy_reconciliation_required, '(Expected: false)');
    console.log('total_remitted_paise:', claimActive.total_remitted_paise, '(Expected: 0)');
    console.log('current_authorized_limit_paise:', claimActive.current_authorized_limit_paise, '(Expected: 3000000)');

    if (
      claimActive.settlement_status !== 'unsettled' ||
      claimActive.legacy_reconciliation_required !== false ||
      Number(claimActive.total_remitted_paise) !== 0 ||
      Number(claimActive.current_authorized_limit_paise) !== 3000000
    ) {
      throw new Error('Claim 3 backfill invariant violation!');
    }

    console.log('\n--- CLAIM REMITTANCES TABLE ---');
    console.log('Remittance row count after 0067 backfill:', remittances.length, '(Expected: 0 - NO fake rows invented)');
    if (remittances.length !== 0) {
      throw new Error('Remittances table should contain zero fake backfill rows!');
    }

    // 7. Test Verified Reconciliation Step
    console.log('\n[6/6] Testing subsequent verified reconciliation recording on Claim 1:');
    const remittanceId = crypto.randomUUID();
    const remittanceClientId = crypto.randomUUID();
    await sql`
      insert into claim_remittances (
        id, hospital_id, claim_case_id, remittance_type, payment_method,
        payer_reference, amount_paise, tds_paise, deduction_paise, co_pay_paise,
        client_id, recorded_by_user_id
      ) values (
        ${remittanceId}, ${hospitalId}, ${claimSettledId}, 'payment', 'neft',
        'UTR-STAR-12345678', 4300000, 200000, 500000, 0,
        ${remittanceClientId}, ${userId}
      )
    `;

    await sql`
      update claim_cases
      set
        total_remitted_paise = 4300000,
        total_tds_withheld_paise = 200000,
        total_deductions_paise = 500000,
        adjudicated_payable_paise = 4500000,
        settlement_status = 'settled',
        legacy_reconciliation_required = false,
        updated_at = now()
      where id = ${claimSettledId}
    `;

    const [reconciledClaim] = await sql`select * from claim_cases where id = ${claimSettledId}`;
    console.log('Post-reconciliation settlement_status:', reconciledClaim.settlement_status, '(Expected: settled)');
    console.log('Post-reconciliation legacy_reconciliation_required:', reconciledClaim.legacy_reconciliation_required, '(Expected: false)');
    console.log('Post-reconciliation total_remitted_paise:', reconciledClaim.total_remitted_paise, '(Expected: 4300000)');
    console.log('Post-reconciliation total_tds_withheld_paise:', reconciledClaim.total_tds_withheld_paise, '(Expected: 200000)');

    if (
      reconciledClaim.settlement_status !== 'settled' ||
      reconciledClaim.legacy_reconciliation_required !== false ||
      Number(reconciledClaim.total_remitted_paise) !== 4300000 ||
      Number(reconciledClaim.total_tds_withheld_paise) !== 200000
    ) {
      throw new Error('Post-reconciliation assertion failure!');
    }

    console.log('\nALL UPGRADE REHEARSAL INVARIANTS PASSED PERFECTLY!');
  } finally {
    await sql.end();
    const cleanupAdmin = postgres(adminUrl!, { max: 1, connect_timeout: 20 });
    await cleanupAdmin.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`);
    console.log(`Cleaned up and dropped rehearsal database: ${UPGRADE_DB}`);
    await cleanupAdmin.end();
  }
}

main().catch((err) => {
  console.error('UPGRADE REHEARSAL FAILED:', err);
  process.exit(1);
});
