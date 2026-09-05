import 'dotenv/config';
import postgres from 'postgres';

/**
 * Prepares a managed Postgres database for this application.
 *
 * The tenancy model depends on there being two roles with different powers, so
 * this script creates the restricted one and then *verifies* the split rather
 * than assuming it. Managed providers differ in what they let you do, and a
 * silently over-privileged application role would disable row-level security
 * without any visible symptom.
 *
 * Run once per database:  npm run db:bootstrap
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appRole = process.env.APP_DB_ROLE ?? 'opd_app';
const appPassword = process.env.APP_DB_PASSWORD;

async function main() {
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is not set');
  if (!appPassword) {
    throw new Error(
      'APP_DB_PASSWORD is not set. Choose a strong password, put it in .env, ' +
        'and use the same one in DATABASE_URL.',
    );
  }

  const sql = postgres(adminUrl, { max: 1 });

  /**
   * DDL cannot take bind parameters, so statements are assembled by Postgres
   * itself via format(): %I and %L do the identifier and literal quoting, and
   * the values still travel as parameters. Never string-concatenate these.
   */
  const build = async (template: string, ...args: string[]) => {
    const [row] = await sql`
      select format(${template}::text, variadic ${args}::text[]) as stmt
    `;
    return row.stmt as string;
  };

  const run = async (template: string, ...args: string[]) =>
    sql.unsafe(await build(template, ...args));

  const [{ current_database: database }] = await sql`select current_database()`;

  const existing = await sql`select 1 from pg_roles where rolname = ${appRole}`;
  if (existing.length === 0) {
    await run('CREATE ROLE %I LOGIN PASSWORD %L', appRole, appPassword);
    console.log(`created role ${appRole}`);
  } else {
    await run('ALTER ROLE %I WITH LOGIN PASSWORD %L', appRole, appPassword);
    console.log(`updated password for existing role ${appRole}`);
  }

  // Best-effort: some providers reserve this. The assertion below is what counts.
  try {
    await run('ALTER ROLE %I NOBYPASSRLS', appRole);
  } catch {
    console.warn(`could not set NOBYPASSRLS on ${appRole}; verifying instead`);
  }

  await run('GRANT CONNECT ON DATABASE %I TO %I', database, appRole);
  await run('GRANT USAGE ON SCHEMA public TO %I', appRole);
  await run(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
    appRole,
  );
  await run('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', appRole);
  await run(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public ' +
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    appRole,
  );
  await run(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
    appRole,
  );

  const [app] = await sql`
    select rolbypassrls, rolsuper from pg_roles where rolname = ${appRole}
  `;
  /**
   * Role attributes are not inherited through membership, but managed providers
   * hand out owner roles in varied ways (Neon's, for instance, sits under
   * neon_superuser), so membership is worth reporting on before crying wolf.
   */
  const [admin] = await sql`
    select bool_or(r.rolbypassrls or r.rolsuper) as can_bypass
    from pg_roles r
    where pg_has_role(current_user, r.oid, 'member')
  `;

  await sql.end();

  // The dangerous direction. An app role that bypasses RLS means no isolation.
  if (app.rolbypassrls || app.rolsuper) {
    console.error(
      `\nFATAL: ${appRole} can bypass row-level security, so tenant isolation ` +
        'is NOT enforced. Do not point DATABASE_URL at this role.',
    );
    process.exit(1);
  }

  // The inconvenient direction. Only breaks migrations and the worker, and the
  // RLS test suite proves it empirically either way.
  if (!admin.can_bypass) {
    console.warn(
      '\nwarning: could not confirm the admin role bypasses RLS. If migrations ' +
        'or the worker start seeing no rows, this is why. `npm test` will ' +
        'settle it — the RLS suite asserts the admin role sees every tenant.',
    );
  }

  console.log(
    `\nok: ${appRole} is subject to RLS. ` +
      'Point DATABASE_URL at the app role and run npm run db:migrate.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
