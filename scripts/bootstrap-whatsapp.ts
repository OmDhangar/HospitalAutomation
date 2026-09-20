import 'dotenv/config';
import postgres from 'postgres';
import { hashPassword } from '@/lib/security/password';

/**
 * The smallest database state in which WhatsApp booking actually works.
 *
 * `seed-demo.ts` exists to make the dashboard look real — 28 days of history,
 * thousands of appointments — and none of that is required for a patient to
 * message the number and get a reply. When the goal is "is the bot alive", that
 * bulk insert is only a way for the attempt to fail.
 *
 * So this creates exactly four things, and nothing else:
 *
 *   hospital → branch → one active doctor → the WhatsApp number
 *
 * Those four are precisely what `handleInboundMessage` walks before it can
 * respond: an active hospital it can resolve the number to, and at least one
 * active doctor to offer. Miss any of them and the bot returns silently.
 *
 *   npx tsx scripts/bootstrap-whatsapp.ts
 *
 * Idempotent and additive. It re-runs safely, touches no other hospital, and
 * deletes nothing — so it cannot repeat the orphaning that seed-demo.ts did.
 */

const SLUG = process.env.BOOTSTRAP_SLUG ?? 'live-test';
const NAME = process.env.BOOTSTRAP_NAME ?? 'Test Hospital';
const EMAIL = (process.env.SEED_EMAIL ?? 'owner@demo.hospital').toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-opd-queue';

async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is not set');

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!phoneNumberId) {
    throw new Error(
      'WHATSAPP_PHONE_NUMBER_ID is not set.\n' +
        'Get it from business.facebook.com → WhatsApp Manager → API Setup —\n' +
        'the numeric "Phone number ID" below the phone number itself.\n' +
        'Without it nothing here can route a real message, so this refuses to\n' +
        'create a hospital that only looks configured.',
    );
  }

  if (!/^\d{10,20}$/.test(phoneNumberId)) {
    throw new Error(
      `WHATSAPP_PHONE_NUMBER_ID='${phoneNumberId}' is not a Meta phone number id.\n` +
        'It should be 10-20 digits. A display number (+91 …) or a placeholder\n' +
        'will never match what arrives in the webhook.',
    );
  }

  const sql = postgres(url, { max: 1 });
  console.log(`\nBootstrapping '${NAME}' for WhatsApp\n`);

  // 1. Hospital. Reused if the slug already exists, so re-runs are harmless.
  const [hospital] = await sql<{ id: string }[]>`
    insert into hospitals (name, slug, timezone, default_locale, active)
    values (${NAME}, ${SLUG}, 'Asia/Kolkata', 'en', true)
    on conflict (slug) do update set active = true, name = excluded.name
    returning id
  `;
  console.log(`  hospital   ${hospital.id}`);

  // 2. Branch.
  const [existingBranch] = await sql<{ id: string }[]>`
    select id from branches where hospital_id = ${hospital.id} limit 1
  `;
  const branch =
    existingBranch ??
    (
      await sql<{ id: string }[]>`
        insert into branches (hospital_id, name, active)
        values (${hospital.id}, 'Main Branch', true)
        returning id
      `
    )[0];
  console.log(`  branch     ${branch.id}`);

  /**
   * 3. One active doctor.
   *
   * Not optional. `handleInboundMessage` returns without replying when the
   * doctor list is empty, which looks identical to every other silent exit.
   */
  const [existingDoctor] = await sql<{ id: string }[]>`
    select id from doctors where hospital_id = ${hospital.id} and active = true limit 1
  `;
  const doctor =
    existingDoctor ??
    (
      await sql<{ id: string }[]>`
        insert into doctors
          (hospital_id, branch_id, name, specialty, default_consult_minutes, active)
        values (${hospital.id}, ${branch.id}, 'Dr. Test', 'General Medicine', 10, true)
        returning id
      `
    )[0];
  console.log(`  doctor     ${doctor.id}`);

  /**
   * 4. The WhatsApp number — the only row that decides whether inbound routes.
   *
   * ON CONFLICT re-points the number at this hospital rather than failing,
   * because the id is globally unique and may still be held by an orphaned row
   * from an earlier run.
   */
  await sql`
    insert into whatsapp_numbers
      (hospital_id, phone_number_id, display_phone_number, verified_name,
       status, registered_at)
    values
      (${hospital.id}, ${phoneNumberId},
       ${process.env.WHATSAPP_DISPLAY_NUMBER ?? null}, ${NAME},
       'registered', now())
    on conflict (phone_number_id) do update set
      hospital_id   = excluded.hospital_id,
      verified_name = excluded.verified_name,
      status        = 'registered',
      registered_at = coalesce(whatsapp_numbers.registered_at, now()),
      updated_at    = now()
  `;
  console.log(`  number     ${phoneNumberId}`);

  // 5. A login, so the settings pages are reachable. Optional for the bot.
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, password_hash, name, is_platform_admin, active)
    values (${EMAIL}, ${await hashPassword(PASSWORD)}, 'Test Owner', true, true)
    on conflict (email) do update set active = true
    returning id
  `;
  await sql`
    insert into staff_memberships (user_id, hospital_id, branch_id, role, active)
    values (${user.id}, ${hospital.id}, ${branch.id}, 'owner', true)
    on conflict do nothing
  `;
  console.log(`  login      ${EMAIL} / ${PASSWORD}`);

  // Prove it end to end rather than asserting it: this is the same function
  // the webhook calls, so a hospital id here means inbound will route.
  const [check] = await sql<{ hospital_id: string | null }[]>`
    select public.resolve_whatsapp_number(${phoneNumberId}) as hospital_id
  `;

  if (check?.hospital_id === hospital.id) {
    console.log('\n  ✓ resolve_whatsapp_number routes to this hospital.');
    console.log('    Send a WhatsApp message to the number now.\n');
  } else {
    console.log('\n  ✗ The number does NOT resolve. Inbound will be dropped.');
    console.log('    Run: npx tsx scripts/diagnose-whatsapp.ts\n');
    process.exitCode = 1;
  }

  await sql.end();
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
