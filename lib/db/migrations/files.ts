import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads `drizzle/` the way drizzle's own migrator does, so the history the
 * runner v2 writes stays interchangeable with the history `migrate()` wrote
 * (ADR-025): same journal, same `--> statement-breakpoint` split, same hash
 * (sha256 of the whole file as read), same `created_at` = journal `when`.
 *
 * What it adds is the file's directives — comment lines at the top that change
 * how the runner applies it:
 *
 *   -- qurio:no-transaction        run statement by statement, outside a transaction
 *                                  (CREATE INDEX CONCURRENTLY, ALTER TYPE … ADD VALUE)
 *   -- qurio:contract              the file may drop or rename (a contract release)
 *   -- qurio:lock-timeout=10s      override the default lock_timeout
 *   -- qurio:statement-timeout=30min
 */

export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export type MigrationDirectives = {
  noTransaction: boolean;
  contract: boolean;
  lockTimeout: string | null;
  statementTimeout: string | null;
};

export type MigrationFile = {
  idx: number;
  tag: string;
  /** The number in front of the tag: 41 for `0041_…`. */
  number: number;
  /** Journal `when`; drizzle stores it as `created_at` and orders by it. */
  when: number;
  hash: string;
  statements: string[];
  directives: MigrationDirectives;
};

type JournalEntry = { idx: number; when: number; tag: string; breakpoints: boolean };

const TIMEOUT = /^\d+(ms|s|min|h)?$/;

/** Only the comment block at the very top of the file counts; a directive further down is prose. */
export function parseDirectives(sql: string): MigrationDirectives {
  const directives: MigrationDirectives = {
    noTransaction: false,
    contract: false,
    lockTimeout: null,
    statementTimeout: null,
  };
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('--')) break;
    const match = /^--\s*qurio:([a-z-]+)(?:=(\S+))?\s*$/.exec(line);
    if (!match) continue;
    const [, name, value] = match;
    if (name === 'no-transaction') directives.noTransaction = true;
    else if (name === 'contract') directives.contract = true;
    else if (name === 'lock-timeout' && value && TIMEOUT.test(value)) directives.lockTimeout = value;
    else if (name === 'statement-timeout' && value && TIMEOUT.test(value)) directives.statementTimeout = value;
    else throw new Error(`unknown or malformed migration directive: ${line}`);
  }
  return directives;
}

export function tagNumber(tag: string): number {
  const match = /^(\d{4})_/.exec(tag);
  if (!match) throw new Error(`migration tag does not start with a 4-digit number: ${tag}`);
  return Number(match[1]);
}

export function parseMigration(entry: JournalEntry, content: string): MigrationFile {
  return {
    idx: entry.idx,
    tag: entry.tag,
    number: tagNumber(entry.tag),
    when: entry.when,
    hash: createHash('sha256').update(content).digest('hex'),
    statements: content.split(STATEMENT_BREAKPOINT).filter((statement) => statement.trim() !== ''),
    directives: parseDirectives(content),
  };
}

export function readMigrationFolder(folder: string): MigrationFile[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries.map((entry) =>
    parseMigration(entry, readFileSync(join(folder, `${entry.tag}.sql`)).toString()),
  );
}
