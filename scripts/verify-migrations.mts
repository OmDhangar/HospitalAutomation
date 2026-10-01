/**
 * Rehearses the migration set on a throwaway database before it touches the one
 * holding real patient data.
 *
 *   npx tsx scripts/verify-migrations.mts create   # create, migrate, grant
 *   npx tsx scripts/verify-migrations.mts drop     # remove it
 *
 * Why this exists: `drizzle/` is applied to a database with a live pilot
 * hospital in it, and a migration is the one change that cannot be rolled back
 * by redeploying. This builds an empty database beside it on the same server,
 * runs every migration from 0000, and grants the app role what it needs — so the
 * integration suite can be pointed at it and prove the new SQL works before the
 * real database sees it:
 *
 *   ADMIN=$(grep ^DATABASE_ADMIN_URL= .env | cut -d= -f2- | sed 's#/neondb?#/qurio_scratch?#')
 *   APP=$(grep ^DATABASE_URL= .env | cut -d= -f2- | sed 's#/neondb?#/qurio_scratch?#')
 *   DATABASE_ADMIN_URL="$ADMIN" DATABASE_URL="$APP" npm run test:integration
 *
 * It prints the two connection strings on `create` for exactly that. Drop the
 * database when finished; it is billable storage otherwise.
 */
import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const SCRATCH = 'qurio_scratch';
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appRole = process.env.APP_DB_ROLE ?? 'opd_app';
const command = process.argv[2];

if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is not set');
if (command !== 'create' && command !== 'drop') {
  console.error('usage: verify-migrations.mts create|drop');
  process.exit(1);
}

const urlFor = (base: string, database: string) => {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
};

const admin = postgres(adminUrl, { max: 1, connect_timeout: 20 });

// A guard, not politeness: the name is fixed, and pointing this at the real
// database by mistake would drop it.
if (new URL(adminUrl).pathname === `/${SCRATCH}`) {
  throw new Error(`DATABASE_ADMIN_URL already points at ${SCRATCH}; refusing to act`);
}

if (command === 'drop') {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  console.log(`dropped ${SCRATCH}`);
  await admin.end();
  process.exit(0);
}

await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${SCRATCH}`);
console.log(`created ${SCRATCH}`);
await admin.end();

const scratchAdminUrl = urlFor(adminUrl, SCRATCH);
const scratch = postgres(scratchAdminUrl, { max: 1, connect_timeout: 20 });

await migrate(drizzle(scratch), { migrationsFolder: './drizzle' });
const [{ n }] = await scratch<{ n: number }[]>`
  select count(*)::int as n from drizzle.__drizzle_migrations`;
console.log(`applied ${n} migrations`);

/**
 * The grants db-bootstrap makes, scoped to this database, plus the EXECUTE
 * grants migrate.ts adds. Without the latter the app role cannot write at all:
 * the read-only policies call app_read_only(), policies run as the querying
 * role, and 0023 revokes that function from PUBLIC.
 */
const build = async (template: string, ...args: string[]) => {
  const [row] = await scratch<{ stmt: string }[]>`
    select format(${template}::text, variadic ${args}::text[]) as stmt`;
  return row.stmt;
};
const run = async (template: string, ...args: string[]) =>
  scratch.unsafe(await build(template, ...args));

await run('GRANT CONNECT ON DATABASE %I TO %I', SCRATCH, appRole);
await run('GRANT USAGE ON SCHEMA public TO %I', appRole);
await run('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', appRole);
await run('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', appRole);
for (const fn of [
  'public.resolve_public_token(text)',
  'public.resolve_user_hospital(uuid)',
  'public.resolve_whatsapp_number(text)',
  'public.app_read_only()',
  'public.app_clinical_access()',
]) {
  await run(`GRANT EXECUTE ON FUNCTION ${fn} TO %I`, appRole);
}
console.log(`granted to ${appRole}`);

await scratch.end();

console.log('\nPoint the integration suite at it with:');
console.log(`  export DATABASE_ADMIN_URL="${scratchAdminUrl}"`);
console.log(`  export DATABASE_URL="${urlFor(process.env.DATABASE_URL!, SCRATCH)}"`);
