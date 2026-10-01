import 'dotenv/config';
import postgres from 'postgres';
import { RETIRED_DEFAULT_PASSWORDS, hashPassword, unguessablePassword, verifyPassword } from '@/lib/security/password';

/**
 * Finds logins still on a password this product used to hand out by default.
 *
 * Until the fix that added this script, any account created without a typed
 * password got "Staff@123" (staff) or "Hospital@123" (hospital owners), and
 * was never made to change it. Anyone who could guess the email could sign in.
 * New accounts no longer get a default, but the old ones still have it.
 *
 *   npx tsx scripts/find-default-passwords.ts           report only, changes nothing
 *   npx tsx scripts/find-default-passwords.ts --lock    lock every account found
 *
 * Locking replaces the password with a random one nobody knows, marks the
 * account must-change, and signs it out everywhere. The holder then needs a
 * temporary password from the operator console (Platform → the hospital →
 * Issue temporary password).
 *
 * Why lock rather than only force a change at next sign-in: the forced change
 * happens after signing in with the old password, so whoever signs in first —
 * the owner or someone guessing "Hospital@123" — would get to choose the new
 * one. Locking takes that race away.
 *
 * Checks every account with scrypt, so it takes a second or so per account.
 * Uses DATABASE_ADMIN_URL: `users` is not tenant data, but this reads all of it.
 */
async function main() {
  const lock = process.argv.includes('--lock');
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is not set');

  const sql = postgres(url, { max: 1 });
  try {
    const users = await sql<{ id: string; email: string; password_hash: string; active: boolean }[]>`
      select id, email, password_hash, active from users order by email
    `;

    const found: { id: string; email: string; active: boolean }[] = [];
    for (const user of users) {
      for (const candidate of RETIRED_DEFAULT_PASSWORDS) {
        if (await verifyPassword(candidate, user.password_hash)) {
          found.push(user);
          break;
        }
      }
    }

    console.log(`Checked ${users.length} account(s). ${found.length} still on a default password.`);
    for (const user of found) {
      console.log(`  ${user.email}${user.active ? '' : '  (inactive)'}`);
    }

    if (found.length === 0) return;

    if (!lock) {
      console.log('\nNothing changed. Re-run with --lock to lock these accounts.');
      return;
    }

    for (const user of found) {
      const passwordHash = await hashPassword(unguessablePassword());
      await sql.begin(async (tx) => {
        await tx`
          update users set password_hash = ${passwordHash}, must_change_password = true
          where id = ${user.id}
        `;
        await tx`delete from sessions where user_id = ${user.id}`;
      });
    }
    console.log(
      `\nLocked ${found.length} account(s) and signed them out. Issue each a temporary ` +
        'password from the operator console.',
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
