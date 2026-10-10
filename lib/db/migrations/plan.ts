import type { MigrationFile } from './files';

/**
 * Decides which migrations to apply, and refuses the cases drizzle's own
 * migrator gets wrong silently (ADR-025).
 *
 * Drizzle applies a journal entry only when its `when` is newer than the newest
 * row in `drizzle.__drizzle_migrations`. An entry added with an older `when` —
 * for example 0040 promoted from `drizzle/pending/` without moving it to the
 * end — is skipped without a word, and the database silently lacks it. Here
 * that is an error, and so is a journal whose `when` values are not in order.
 */

export type AppliedMigration = { hash: string; createdAt: number };

export type PlanProblem = {
  level: 'error' | 'warning';
  code:
    | 'when_not_increasing'
    | 'duplicate_tag'
    | 'duplicate_number'
    | 'would_be_skipped'
    | 'changed_after_apply'
    | 'unknown_history';
  tag: string | null;
  message: string;
};

export type MigrationPlan = {
  pending: MigrationFile[];
  applied: MigrationFile[];
  lastAppliedWhen: number | null;
  problems: PlanProblem[];
};

export function planMigrations(files: MigrationFile[], history: AppliedMigration[]): MigrationPlan {
  const problems: PlanProblem[] = [];

  const seenTags = new Set<string>();
  const seenNumbers = new Set<number>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (seenTags.has(file.tag)) {
      problems.push({ level: 'error', code: 'duplicate_tag', tag: file.tag, message: `${file.tag} is in the journal twice` });
    }
    if (seenNumbers.has(file.number)) {
      problems.push({
        level: 'error',
        code: 'duplicate_number',
        tag: file.tag,
        message: `migration number ${String(file.number).padStart(4, '0')} is used twice`,
      });
    }
    seenTags.add(file.tag);
    seenNumbers.add(file.number);
    if (i > 0 && file.when <= files[i - 1].when) {
      problems.push({
        level: 'error',
        code: 'when_not_increasing',
        tag: file.tag,
        message: `${file.tag} has when=${file.when}, not newer than ${files[i - 1].tag} (${files[i - 1].when}); drizzle orders by when`,
      });
    }
  }

  const lastAppliedWhen = history.length === 0 ? null : Math.max(...history.map((row) => row.createdAt));
  const historyByWhen = new Map(history.map((row) => [row.createdAt, row]));
  const fileWhens = new Set(files.map((file) => file.when));

  const pending: MigrationFile[] = [];
  const applied: MigrationFile[] = [];
  for (const file of files) {
    const row = historyByWhen.get(file.when);
    if (row) {
      applied.push(file);
      if (row.hash !== file.hash) {
        problems.push({
          level: 'warning',
          code: 'changed_after_apply',
          tag: file.tag,
          message: `${file.tag} was edited after it was applied; never edit an applied migration`,
        });
      }
    } else if (lastAppliedWhen !== null && file.when <= lastAppliedWhen) {
      problems.push({
        level: 'error',
        code: 'would_be_skipped',
        tag: file.tag,
        message: `${file.tag} is not applied but is older than the last applied migration; give it a newer when at the end of the journal`,
      });
    } else {
      pending.push(file);
    }
  }

  for (const row of history) {
    if (!fileWhens.has(row.createdAt)) {
      problems.push({
        level: 'warning',
        code: 'unknown_history',
        tag: null,
        message: `the database has a migration (created_at=${row.createdAt}) that is not in the journal`,
      });
    }
  }

  return { pending, applied, lastAppliedWhen, problems };
}
