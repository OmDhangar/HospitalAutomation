import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { readMigrationFolder, type MigrationFile } from '@/lib/db/migrations/files';
import { LINT_FROM, lintMigration } from '@/lib/db/migrations/lint';
import { planMigrations, type AppliedMigration } from '@/lib/db/migrations/plan';
import { afterMigrations, beforeMigrations } from './lib/migration-hooks';

/**
 * Migration runner v2 (ADR-025, IPD sheets plan §9.3).
 *
 *   npx tsx scripts/migrate-v2.ts --dry-run        # print the plan; write nothing
 *   npx tsx scripts/migrate-v2.ts                  # apply
 *   npx tsx scripts/migrate-v2.ts --rerun-check    # apply, then re-run every new migration to prove it is idempotent
 *   npx tsx scripts/migrate-v2.ts --folder <dir>   # use a copy of drizzle/ (rehearsals)
 *
 * Differences from drizzle's `migrate()`, which `npm run db:migrate` still uses
 * until the owner switches after a dry run on production-sized data:
 *
 * - **One transaction per migration**, not one for all of them, with
 *   `lock_timeout` (3 s by default) so a migration waiting on a busy table gives
 *   up and retries instead of queueing every query behind it.
 * - **`-- qurio:no-transaction` files** run statement by statement, for
 *   `CREATE INDEX CONCURRENTLY`.
 * - **Refuses** a journal that drizzle would apply wrongly without a word (an
 *   unapplied entry older than the last applied one; `when` going backwards),
 *   and any migration from 0041 on that fails the idempotency lint.
 * - **An advisory lock**, so two deploys cannot migrate at once.
 *
 * It reads and writes the same `drizzle.__drizzle_migrations` history, so
 * either runner can follow the other.
 */

const ADVISORY_LOCK_KEY = 'qurio:migrations';
const DEFAULT_LOCK_TIMEOUT = '3s';
const DEFAULT_STATEMENT_TIMEOUT = '10min';
const MAX_ATTEMPTS = 5;
// lock_not_available (lock_timeout fired) and deadlock_detected: both safe to retry.
const RETRYABLE = new Set(['55P03', '40P01']);

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const rerunCheck = args.has('--rerun-check');
// A copy of drizzle/ for rehearsals (e.g. with a pending migration promoted); defaults to the real one.
const folderIndex = process.argv.indexOf('--folder');
const MIGRATIONS_FOLDER = folderIndex >= 0 ? process.argv[folderIndex + 1] : './drizzle';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RolledBack extends Error {}

async function readHistory(sql: Sql): Promise<AppliedMigration[]> {
  const [{ exists }] = await sql<{ exists: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
  if (!exists) return [];
  const rows = await sql<{ hash: string; created_at: string }[]>`
    select hash, created_at from drizzle.__drizzle_migrations`;
  return rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }));
}

async function runStatements(sql: Sql, file: MigrationFile): Promise<void> {
  for (const statement of file.statements) await sql.unsafe(statement);
}

async function applyOne(sql: Sql, file: MigrationFile): Promise<void> {
  const lockTimeout = file.directives.lockTimeout ?? DEFAULT_LOCK_TIMEOUT;
  const statementTimeout = file.directives.statementTimeout ?? DEFAULT_STATEMENT_TIMEOUT;

  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      if (file.directives.noTransaction) {
        await sql`select set_config('lock_timeout', ${lockTimeout}, false),
                         set_config('statement_timeout', ${statementTimeout}, false)`;
        try {
          await runStatements(sql, file);
          await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${file.hash}, ${file.when})`;
        } finally {
          await sql`reset lock_timeout`;
          await sql`reset statement_timeout`;
        }
      } else {
        await sql.begin(async (tx) => {
          await tx`select set_config('lock_timeout', ${lockTimeout}, true),
                          set_config('statement_timeout', ${statementTimeout}, true)`;
          await runStatements(tx as unknown as Sql, file);
          await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${file.hash}, ${file.when})`;
        });
      }
      console.log(`  applied ${file.tag} in ${Date.now() - started} ms${file.directives.noTransaction ? ' (no transaction)' : ''}`);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!code || !RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) throw error;
      const wait = 2 ** attempt * 1000;
      console.warn(`  ${file.tag}: ${code === '55P03' ? 'lock timeout' : 'deadlock'}, retrying in ${wait / 1000} s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await sleep(wait);
    }
  }
}

/** Runs each migration from LINT_FROM on a second time; a transactional one is rolled back afterwards. */
async function checkReruns(sql: Sql, files: MigrationFile[]): Promise<boolean> {
  let ok = true;
  for (const file of files.filter((f) => f.number >= LINT_FROM)) {
    try {
      if (file.directives.noTransaction) {
        await runStatements(sql, file);
      } else {
        await sql
          .begin(async (tx) => {
            await runStatements(tx as unknown as Sql, file);
            throw new RolledBack();
          })
          .catch((error) => {
            if (!(error instanceof RolledBack)) throw error;
          });
      }
      console.log(`  re-run ok: ${file.tag}`);
    } catch (error) {
      ok = false;
      console.error(`  re-run FAILED: ${file.tag}: ${(error as Error).message}`);
    }
  }
  return ok;
}

async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is not set');

  const files = readMigrationFolder(MIGRATIONS_FOLDER);
  const findings = files.flatMap(lintMigration);
  for (const finding of findings) {
    console[finding.level === 'error' ? 'error' : 'warn'](
      `lint ${finding.level}: ${finding.tag} statement ${finding.statement + 1}: ${finding.rule}: ${finding.message}`,
    );
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [{ locked }] = await sql<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtext(${ADVISORY_LOCK_KEY})) as locked`;
    if (!locked) throw new Error('another migration run holds the lock; try again when it has finished');

    const plan = planMigrations(files, await readHistory(sql));
    for (const problem of plan.problems) {
      console[problem.level === 'error' ? 'error' : 'warn'](`plan ${problem.level}: ${problem.message}`);
    }
    console.log(
      `${plan.applied.length} applied, ${plan.pending.length} pending` +
        (plan.pending.length ? `: ${plan.pending.map((f) => f.tag).join(', ')}` : ''),
    );

    const lintErrors = findings.filter((f) => f.level === 'error');
    const planErrors = plan.problems.filter((p) => p.level === 'error');
    if (lintErrors.length || planErrors.length) {
      throw new Error(`refusing to migrate: ${lintErrors.length} lint error(s), ${planErrors.length} plan error(s)`);
    }

    if (dryRun) {
      for (const file of plan.pending) {
        console.log(
          `  would apply ${file.tag}: ${file.statements.length} statement(s), ` +
            `${file.directives.noTransaction ? 'no transaction' : 'one transaction'}, ` +
            `lock_timeout ${file.directives.lockTimeout ?? DEFAULT_LOCK_TIMEOUT}`,
        );
      }
      console.log('dry run: nothing written');
      return;
    }

    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`;

    await beforeMigrations(sql);
    for (const file of plan.pending) await applyOne(sql, file);
    await afterMigrations(sql, drizzle(sql));
    console.log(`migrations applied, plan tiers seeded, execute granted`);

    if (rerunCheck && !(await checkReruns(sql, files))) {
      throw new Error('re-run check failed: a migration is not idempotent');
    }
  } finally {
    await sql`select pg_advisory_unlock_all()`.catch(() => {});
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
