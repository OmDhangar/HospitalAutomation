import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { planTiers } from '@/lib/db/schema';
import { SEED_PLAN_TIERS } from '@/lib/domain/pricing';

async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is not set');

  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);

  await migrate(db, { migrationsFolder: './drizzle' });

  /**
   * The rate card is data, not code, so it is seeded rather than hard-coded.
   * Upserting keeps a hand-edited price in the database intact across deploys —
   * only genuinely new tiers are added.
   */
  await db
    .insert(planTiers)
    .values(
      SEED_PLAN_TIERS.map((tier, index) => ({
        code: tier.code,
        name: tier.name,
        includedAppointments: tier.includedAppointments,
        monthlyPricePaise: tier.monthlyPricePaise,
        sortOrder: index,
      })),
    )
    .onConflictDoNothing();

  /**
   * Granted here rather than in the migration because the role name is
   * configurable, and here rather than in db:bootstrap because the function
   * does not exist until migrations have run.
   */
  const appRole = process.env.APP_DB_ROLE ?? 'opd_app';
  const bootstrapFunctions = [
    'public.resolve_public_token(text)',
    'public.resolve_user_hospital(uuid)',
    'public.resolve_whatsapp_number(text)',
  ];

  for (const fn of bootstrapFunctions) {
    const [{ stmt }] = await sql`
      select format('GRANT EXECUTE ON FUNCTION ' || ${fn}::text || ' TO %I', ${appRole}::text)
        as stmt
    `;
    await sql.unsafe(stmt);
  }

  console.log(`migrations applied, plan tiers seeded, execute granted to ${appRole}`);
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
