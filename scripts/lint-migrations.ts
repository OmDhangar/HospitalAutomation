import { readMigrationFolder } from '@/lib/db/migrations/files';
import { lintMigration } from '@/lib/db/migrations/lint';
import { planMigrations } from '@/lib/db/migrations/plan';

/**
 * Checks `drizzle/` without a database: the journal's order and numbering, and
 * the idempotency lint for migrations from 0041 on (ADR-025). For CI and for a
 * quick look before opening a pull request:
 *
 *   npm run db:lint-migrations
 */

const files = readMigrationFolder('./drizzle');
const findings = files.flatMap(lintMigration);
const problems = planMigrations(files, []).problems;

for (const problem of problems) console.error(`journal ${problem.level}: ${problem.message}`);
for (const finding of findings) {
  console[finding.level === 'error' ? 'error' : 'warn'](
    `${finding.level}: ${finding.tag} statement ${finding.statement + 1}: ${finding.rule}: ${finding.message}`,
  );
}

const all = [...findings, ...problems];
const errors = all.filter((f) => f.level === 'error').length;
console.log(`${files.length} migrations checked, ${errors} error(s), ${all.length - errors} warning(s)`);
process.exit(errors > 0 ? 1 : 0);
