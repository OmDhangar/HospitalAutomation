import 'dotenv/config';
import postgres from 'postgres';
import { hashPassword } from '@/lib/security/password';

/**
 * Creates or updates an admin/owner user and hospital on the platform.
 *
 * Usage:
 *   npx tsx scripts/create-admin.ts <email> <password> [hospital_name] [user_name]
 *
 * Example:
 *   npx tsx scripts/create-admin.ts admin@quriiohq.com MySecretPass123! "City Care Hospital" "Dr. Admin"
 */
async function main() {
  const email = process.argv[2] || process.env.ADMIN_EMAIL;
  const password = process.argv[3] || process.env.ADMIN_PASSWORD;
  const hospitalName = process.argv[4] || process.env.HOSPITAL_NAME || 'My Hospital';
  const userName = process.argv[5] || process.env.USER_NAME || 'Hospital Administrator';

  if (!email || !password) {
    console.error('Usage: npx tsx scripts/create-admin.ts <email> <password> [hospital_name] [user_name]');
    process.exit(1);
  }

  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error('DATABASE_ADMIN_URL environment variable is not set');
    process.exit(1);
  }

  const sql = postgres(adminUrl, { max: 1 });

  console.log(`Setting up account for: ${email}`);

  // 1. Create hospital if not exists
  const slug = hospitalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  let [hospital] = await sql`
    select id, name, slug from hospitals where slug = ${slug} limit 1
  `;

  if (!hospital) {
    [hospital] = await sql`
      insert into hospitals (name, slug, timezone, default_locale, plan_tier_code, active)
      values (${hospitalName}, ${slug}, 'Asia/Kolkata', 'en', 'hospital', true)
      returning id, name, slug
    `;
    console.log(`Created hospital: ${hospital.name} (ID: ${hospital.id})`);
  } else {
    console.log(`Found existing hospital: ${hospital.name}`);
  }

  // 2. Create default branch if none exists
  let [branch] = await sql`
    select id, name from branches where hospital_id = ${hospital.id} and active = true limit 1
  `;

  if (!branch) {
    [branch] = await sql`
      insert into branches (hospital_id, name, address, active)
      values (${hospital.id}, 'Main Branch', 'Main OPD Wing', true)
      returning id, name
    `;
    console.log(`Created default branch: ${branch.name}`);
  }

  // 3. Create or update user
  const cleanEmail = email.toLowerCase().trim();
  const passwordHash = await hashPassword(password);

  let [user] = await sql`
    select id, email from users where email = ${cleanEmail} limit 1
  `;

  if (!user) {
    [user] = await sql`
      insert into users (email, password_hash, name, is_platform_admin, active)
      values (${cleanEmail}, ${passwordHash}, ${userName}, true, true)
      returning id, email
    `;
    console.log(`Created user: ${user.email}`);
  } else {
    await sql`
      update users
      set password_hash = ${passwordHash}, name = ${userName}, active = true, is_platform_admin = true
      where id = ${user.id}
    `;
    console.log(`Updated existing user: ${user.email} with new password.`);
  }

  // 4. Assign Owner role in staff_memberships
  const [membership] = await sql`
    select id, role from staff_memberships
    where user_id = ${user.id} and hospital_id = ${hospital.id} limit 1
  `;

  if (!membership) {
    await sql`
      insert into staff_memberships (user_id, hospital_id, branch_id, role, active)
      values (${user.id}, ${hospital.id}, ${branch.id}, 'owner', true)
    `;
    console.log(`Assigned role "owner" to ${user.email} for hospital ${hospital.name}.`);
  } else {
    await sql`
      update staff_memberships
      set role = 'owner', active = true, branch_id = ${branch.id}
      where id = ${membership.id}
    `;
    console.log(`Ensured active "owner" role for ${user.email}.`);
  }

  // 5. Ensure active subscription
  const [sub] = await sql`
    select id from subscriptions where hospital_id = ${hospital.id} and status = 'active' limit 1
  `;
  if (!sub) {
    const now = new Date();
    const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    const endsAt = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), 1, 0, 0, 0));

    await sql`
      insert into subscriptions
        (hospital_id, plan_tier_code, billing_cycle, status, price_paise, setup_fee_paise,
         daily_appointment_capacity, included_appointments, included_messages,
         starts_at, ends_at, change_reason)
      values
        (${hospital.id}, 'hospital', 'annual', 'active', 6999000, 0,
         150, 5300, 21200,
         ${startsAt.toISOString()}, ${endsAt.toISOString()}, 'admin_setup')
    `;
    console.log('Created active hospital subscription.');
  }

  await sql.end();
  console.log('\nSuccess! You can now sign in at:');
  console.log(`URL:      https://quriiohq.com/login`);
  console.log(`Email:    ${cleanEmail}`);
  console.log(`Password: ${password}\n`);
}

main().catch((err) => {
  console.error('Error creating admin user:', err);
  process.exit(1);
});
