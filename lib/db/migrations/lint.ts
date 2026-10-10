import type { MigrationFile } from './files';

/**
 * Idempotency and safety lint for hand-written migrations (ADR-025).
 *
 * The runner v2 applies one migration per transaction, and a `no-transaction`
 * file runs statement by statement — so a migration can stop half-way and be run
 * again. Every statement must therefore be safe to repeat, and changes must be
 * expand-only unless the file says it is a contract release.
 *
 * Applies to migrations numbered `LINT_FROM` and later; older files were written
 * for the one-transaction runner and are never re-run.
 *
 * It is a set of regular expressions over SQL, not a parser: it catches the
 * common mistakes and is honest about what it cannot see (a dynamic statement
 * built with `format()` inside a DO block is checked only for a guard nearby).
 */

export const LINT_FROM = 41;

export type LintFinding = {
  tag: string;
  statement: number;
  level: 'error' | 'warning';
  rule: string;
  message: string;
};

/** Strips comments and replaces dollar-quoted bodies, returning the bodies separately. */
export function splitBodies(statement: string): { outer: string; bodies: string[] } {
  const bodies: string[] = [];
  const outer = statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, (body) => {
      bodies.push(body);
      return ' $body$ ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { outer, bodies };
}

const rx = (source: string) => new RegExp(source, 'i');

export function lintMigration(file: MigrationFile): LintFinding[] {
  if (file.number < LINT_FROM) return [];
  const findings: LintFinding[] = [];
  const { noTransaction, contract } = file.directives;
  const push = (statement: number, level: LintFinding['level'], rule: string, message: string) =>
    findings.push({ tag: file.tag, statement, level, rule, message });

  const parsed = file.statements.map(splitBodies);
  const everything = parsed.map((p) => p.outer).join(' ; ');
  const tablesCreatedHere = new Set(
    [...everything.matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([\w."]+)/gi)].map((m) =>
      m[1].replace(/"/g, '').replace(/^public\./i, '').toLowerCase(),
    ),
  );
  const dropped = (kind: string, name: string, upTo: number) =>
    parsed
      .slice(0, upTo + 1)
      .some((p) => rx(`DROP\\s+${kind}\\s+IF\\s+EXISTS\\s+"?${name}"?\\b`).test(p.outer));

  parsed.forEach(({ outer, bodies }, i) => {
    if (rx('\\bCREATE\\s+(UNLOGGED\\s+)?TABLE\\s+(?!IF\\s+NOT\\s+EXISTS)').test(outer)) {
      push(i, 'error', 'create-table', 'CREATE TABLE needs IF NOT EXISTS');
    }
    if (
      rx('\\bCREATE\\s+(UNIQUE\\s+)?INDEX\\b').test(outer) &&
      !rx('\\bCREATE\\s+(UNIQUE\\s+)?INDEX\\s+(CONCURRENTLY\\s+)?IF\\s+NOT\\s+EXISTS\\b').test(outer)
    ) {
      push(i, 'error', 'create-index', 'CREATE INDEX needs IF NOT EXISTS');
    }
    if (rx('\\bCONCURRENTLY\\b').test(outer) && !noTransaction) {
      push(i, 'error', 'concurrently-in-transaction', 'CONCURRENTLY needs a `-- qurio:no-transaction` file');
    }
    if (rx('\\bADD\\s+COLUMN\\s+(?!IF\\s+NOT\\s+EXISTS)').test(outer)) {
      push(i, 'error', 'add-column', 'ADD COLUMN needs IF NOT EXISTS');
    }
    if (rx('\\bCREATE\\s+(FUNCTION|PROCEDURE|VIEW)\\b').test(outer)) {
      push(i, 'error', 'create-or-replace', 'use CREATE OR REPLACE for functions, procedures and views');
    }
    if (rx('\\bCREATE\\s+(SCHEMA|EXTENSION|SEQUENCE)\\s+(?!IF\\s+NOT\\s+EXISTS)').test(outer)) {
      push(i, 'error', 'create-if-not-exists', 'CREATE SCHEMA/EXTENSION/SEQUENCE needs IF NOT EXISTS');
    }

    const trigger = rx('\\bCREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+"?(\\w+)"?').exec(outer);
    if (trigger && !dropped('TRIGGER', trigger[1], i)) {
      push(i, 'error', 'create-trigger', `use CREATE OR REPLACE TRIGGER, or DROP TRIGGER IF EXISTS ${trigger[1]} first`);
    }
    const policy = rx('\\bCREATE\\s+POLICY\\s+"?(\\w+)"?').exec(outer);
    if (policy && !dropped('POLICY', policy[1], i)) {
      push(i, 'error', 'create-policy', `DROP POLICY IF EXISTS ${policy[1]} first`);
    }
    for (const constraint of outer.matchAll(/\bADD\s+CONSTRAINT\s+"?(\w+)"?/gi)) {
      if (!dropped('CONSTRAINT', constraint[1], i)) {
        push(i, 'error', 'add-constraint', `DROP CONSTRAINT IF EXISTS ${constraint[1]} first, or guard it in a DO block`);
      }
    }
    const altered = rx('\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?([\\w."]+)').exec(outer);
    const alteredTable = altered?.[1].replace(/"/g, '').replace(/^public\./i, '').toLowerCase();
    if (
      altered &&
      rx('\\bADD\\s+CONSTRAINT\\s+\\S+\\s+(FOREIGN\\s+KEY|CHECK)\\b').test(outer) &&
      !rx('\\bNOT\\s+VALID\\b').test(outer) &&
      !tablesCreatedHere.has(alteredTable!)
    ) {
      push(i, 'warning', 'not-valid', 'a new CHECK or FOREIGN KEY on an existing table should be NOT VALID, then VALIDATE later');
    }
    if (altered && rx('\\bSET\\s+NOT\\s+NULL\\b').test(outer) && !tablesCreatedHere.has(alteredTable!)) {
      push(i, 'warning', 'set-not-null', 'SET NOT NULL scans the table; add a validated CHECK (col IS NOT NULL) first');
    }

    if (rx('\\bCREATE\\s+TYPE\\b').test(outer)) {
      push(i, 'error', 'no-new-types', 'no new types or enums: use text + CHECK');
    }
    if (rx('\\bALTER\\s+TYPE\\b[\\s\\S]*\\bADD\\s+VALUE\\b').test(outer)) {
      if (!noTransaction || !rx('\\bADD\\s+VALUE\\s+IF\\s+NOT\\s+EXISTS\\b').test(outer)) {
        push(i, 'error', 'enum-add-value', 'ADD VALUE needs IF NOT EXISTS in a `-- qurio:no-transaction` file');
      } else {
        push(i, 'warning', 'enum-add-value', 'prefer text + CHECK over a new enum value');
      }
    }

    const destructive =
      rx('\\bDROP\\s+(TABLE|COLUMN|VIEW|FUNCTION|TYPE|SCHEMA)\\b').test(outer) ||
      rx('\\bRENAME\\b').test(outer) ||
      rx('\\bALTER\\s+COLUMN\\s+"?\\w+"?\\s+(SET\\s+DATA\\s+)?TYPE\\b').test(outer);
    if (destructive && !contract) {
      push(i, 'error', 'contract-only', 'drops, renames and type changes belong in a `-- qurio:contract` release');
    }
    if (rx('\\bDROP\\s+(TABLE|COLUMN|VIEW|FUNCTION|TYPE|SCHEMA|INDEX|TRIGGER|POLICY|CONSTRAINT)\\s+(?!IF\\s+EXISTS)').test(outer)) {
      push(i, 'error', 'drop-if-exists', 'DROP needs IF EXISTS');
    }

    if (/^INSERT\b/i.test(outer) && !rx('\\bON\\s+CONFLICT\\b').test(outer)) {
      push(i, 'error', 'insert-on-conflict', 'INSERT needs ON CONFLICT so a re-run adds nothing');
    }
    if (/^(UPDATE|DELETE)\b/i.test(outer)) {
      push(i, 'warning', 'backfill', 'data changes belong in a batched scripts/backfill job, not a migration');
    }

    for (const body of bodies) {
      if (!/^\s*DO\b/i.test(outer)) break;
      if (/\bCREATE\s+POLICY\b/i.test(body) && !/DROP\s+POLICY\s+IF\s+EXISTS|pg_policies/i.test(body)) {
        push(i, 'error', 'do-create-policy', 'a DO block that creates policies must drop them first or check pg_policies');
      }
      if (/\bADD\s+CONSTRAINT\b/i.test(body) && !/DROP\s+CONSTRAINT\s+IF\s+EXISTS|pg_constraint/i.test(body)) {
        push(i, 'error', 'do-add-constraint', 'a DO block that adds constraints must check pg_constraint');
      }
    }
  });

  return findings;
}
