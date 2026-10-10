import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { planTiers } from '@/lib/db/schema';
import { SEED_PLAN_TIERS } from '@/lib/domain/pricing';

/**
 * What runs before and after the migrations themselves, for the runner v2
 * (`scripts/migrate-v2.ts`). These are the same steps `scripts/migrate.ts`
 * performs around drizzle's `migrate()`; when v2 replaces it (ADR-025, after the
 * owner's dry run on production-sized data), `migrate.ts` is deleted and this
 * file is the only copy.
 */

export const APP_ROLE = process.env.APP_DB_ROLE ?? 'opd_app';

/** Functions that policies call as the app role; each is revoked from PUBLIC by its migration. */
export const APP_ROLE_FUNCTIONS = [
  'public.resolve_public_token(text)',
  'public.resolve_user_hospital(uuid)',
  'public.resolve_whatsapp_number(text)',
  // Load-bearing for every write: the read-only policies call it.
  'public.app_read_only()',
  // Called by the clinical_access policy on every clinical table.
  'public.app_clinical_access()',
];

export async function beforeMigrations(sql: Sql): Promise<void> {
  const typeExists = async (name: string) =>
    (await sql`select 1 from pg_type where typname = ${name}`).length > 0;

  // Enum values older migrations use in the same run; committed first because
  // a new value cannot be used in the transaction that adds it.
  if (await typeExists('staff_role')) {
    await sql`ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'nurse'`;
  }
  if (await typeExists('bill_item_type')) {
    for (const value of ['consumable', 'procedure', 'service', 'room']) {
      await sql.unsafe(`ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS '${value}'`);
    }
  }

  // 0039 grants the identity functions to the application role by name.
  await sql`select set_config('qurio.app_role', ${APP_ROLE}, false)`;
}

export async function afterMigrations(sql: Sql, db: PostgresJsDatabase): Promise<void> {
  // Fills gaps only: a price edited in the database is a commercial decision
  // and survives every deploy.
  await db
    .insert(planTiers)
    .values(
      SEED_PLAN_TIERS.map((tier, index) => ({
        code: tier.code,
        name: tier.name,
        patientsPerDay: tier.patientsPerDay,
        includedAppointments: tier.includedAppointments,
        includedMessages: tier.includedMessages,
        monthlyPricePaise: tier.monthlyPricePaise,
        annualPricePaise: tier.annualPricePaise,
        setupFeePaise: tier.setupFeePaise,
        overagePaisePerAppointment: tier.overagePaisePerAppointment,
        overagePaisePerMessage: tier.overagePaisePerMessage,
        sortOrder: index,
      })),
    )
    .onConflictDoNothing();

  for (const fn of APP_ROLE_FUNCTIONS) {
    const [{ stmt }] = await sql<{ stmt: string }[]>`
      select format('GRANT EXECUTE ON FUNCTION ' || ${fn}::text || ' TO %I', ${APP_ROLE}::text) as stmt`;
    await sql.unsafe(stmt);
  }
}
