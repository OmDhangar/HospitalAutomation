import { describe, expect, it } from 'vitest';
import { STATEMENT_BREAKPOINT, parseMigration, readMigrationFolder } from '../files';
import { LINT_FROM, lintMigration, splitBodies } from '../lint';

const migration = (statements: string[], header = '', number = LINT_FROM) =>
  parseMigration(
    { idx: number, when: 1, tag: `${String(number).padStart(4, '0')}_test`, breakpoints: true },
    header + statements.join(`\n${STATEMENT_BREAKPOINT}\n`),
  );
const rules = (statements: string[], header = '') => lintMigration(migration(statements, header)).map((f) => f.rule);
const errors = (statements: string[], header = '') =>
  lintMigration(migration(statements, header))
    .filter((f) => f.level === 'error')
    .map((f) => f.rule);

describe('lintMigration', () => {
  it('passes an idempotent expand migration', () => {
    expect(
      rules([
        'CREATE TABLE IF NOT EXISTS tpr_entries (id uuid PRIMARY KEY, pulse smallint)',
        'ALTER TABLE admissions ADD COLUMN IF NOT EXISTS ipd_number integer',
        'CREATE INDEX IF NOT EXISTS tpr_entries_idx ON tpr_entries (id)',
        'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
        'DROP TRIGGER IF EXISTS t ON tpr_entries',
        'CREATE TRIGGER t BEFORE UPDATE ON tpr_entries FOR EACH ROW EXECUTE FUNCTION f()',
        'DROP POLICY IF EXISTS tenant_isolation ON tpr_entries',
        'CREATE POLICY tenant_isolation ON tpr_entries USING (true)',
        'ALTER TABLE tpr_entries DROP CONSTRAINT IF EXISTS tpr_pulse_range',
        'ALTER TABLE tpr_entries ADD CONSTRAINT tpr_pulse_range CHECK (pulse BETWEEN 20 AND 250)',
        "INSERT INTO hospital_features (hospital_id, module_id) VALUES ('x', 'tpr') ON CONFLICT DO NOTHING",
      ]),
    ).toEqual([]);
  });

  it('skips migrations written for the one-transaction runner', () => {
    expect(lintMigration(migration(['CREATE TABLE a (id int)'], '', 39))).toEqual([]);
  });

  it.each([
    ['CREATE TABLE a (id int)', 'create-table'],
    ['CREATE UNIQUE INDEX a_idx ON a (id)', 'create-index'],
    ['ALTER TABLE a ADD COLUMN b int', 'add-column'],
    ['CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql', 'create-or-replace'],
    ['CREATE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW EXECUTE FUNCTION f()', 'create-trigger'],
    ['CREATE POLICY p ON a USING (true)', 'create-policy'],
    ['ALTER TABLE a ADD CONSTRAINT a_chk CHECK (id > 0) NOT VALID', 'add-constraint'],
    ["CREATE TYPE mood AS ENUM ('a')", 'no-new-types'],
    ["INSERT INTO a (id) VALUES (1)", 'insert-on-conflict'],
    ['CREATE EXTENSION pgcrypto', 'create-if-not-exists'],
  ])('flags %s', (statement, rule) => {
    expect(errors([statement])).toContain(rule);
  });

  it('allows CREATE OR REPLACE TRIGGER without a drop', () => {
    expect(errors(['CREATE OR REPLACE TRIGGER t BEFORE UPDATE ON a FOR EACH ROW EXECUTE FUNCTION f()'])).toEqual([]);
  });

  it('keeps CONCURRENTLY out of transactions', () => {
    expect(errors(['CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON a (id)'])).toContain('concurrently-in-transaction');
    expect(errors(['CREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON a (id)'], '-- qurio:no-transaction\n')).toEqual([]);
  });

  it('allows a new enum value only in a no-transaction file, with IF NOT EXISTS, and still warns', () => {
    const statement = "ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'lab'";
    expect(errors([statement])).toContain('enum-add-value');
    const findings = lintMigration(migration([statement], '-- qurio:no-transaction\n'));
    expect(findings).toEqual([expect.objectContaining({ level: 'warning', rule: 'enum-add-value' })]);
  });

  it('keeps drops, renames and type changes for contract releases', () => {
    for (const statement of [
      'ALTER TABLE a DROP COLUMN IF EXISTS b',
      'DROP TABLE IF EXISTS a',
      'ALTER TABLE a RENAME COLUMN b TO c',
      'ALTER TABLE a ALTER COLUMN b TYPE bigint',
    ]) {
      expect(errors([statement])).toContain('contract-only');
      expect(errors([statement], '-- qurio:contract\n')).not.toContain('contract-only');
    }
    expect(errors(['DROP TABLE a'], '-- qurio:contract\n')).toContain('drop-if-exists');
  });

  it('warns about validating constraints and NOT NULL on existing tables only', () => {
    const existing = rules([
      'ALTER TABLE admissions DROP CONSTRAINT IF EXISTS c',
      'ALTER TABLE admissions ADD CONSTRAINT c CHECK (ipd_number > 0)',
    ]);
    expect(existing).toContain('not-valid');
    const fresh = rules([
      'CREATE TABLE IF NOT EXISTS t (id int)',
      'ALTER TABLE t DROP CONSTRAINT IF EXISTS c',
      'ALTER TABLE t ADD CONSTRAINT c CHECK (id > 0)',
      'ALTER TABLE t ALTER COLUMN id SET NOT NULL',
    ]);
    expect(fresh).not.toContain('not-valid');
    expect(fresh).not.toContain('set-not-null');
    expect(rules(['ALTER TABLE admissions ALTER COLUMN reason SET NOT NULL'])).toContain('set-not-null');
  });

  it('points backfills at batched jobs', () => {
    expect(rules(['UPDATE patients SET name = name'])).toContain('backfill');
  });

  it('checks the guard inside DO blocks that create policies or constraints', () => {
    const unguarded = `DO $outer$ BEGIN EXECUTE format('CREATE POLICY p ON %I USING (true)', 't'); END $outer$`;
    expect(errors([unguarded])).toContain('do-create-policy');
    const guarded = `DO $outer$ BEGIN EXECUTE format('DROP POLICY IF EXISTS p ON %I', 't'); EXECUTE format('CREATE POLICY p ON %I USING (true)', 't'); END $outer$`;
    expect(errors([guarded])).toEqual([]);
  });

  it('does not read SQL inside function bodies or comments as top-level statements', () => {
    expect(
      errors([
        `-- CREATE TABLE in a comment
         CREATE OR REPLACE FUNCTION g() RETURNS void AS $fn$ BEGIN CREATE TABLE x (id int); END $fn$ LANGUAGE plpgsql`,
      ]),
    ).toEqual([]);
    expect(splitBodies('select $$a$$, $tag$b$tag$ /* c */').bodies).toEqual(['$$a$$', '$tag$b$tag$']);
  });

  it('passes every real migration from LINT_FROM on', () => {
    const findings = readMigrationFolder('./drizzle').flatMap(lintMigration);
    expect(findings.filter((f) => f.level === 'error')).toEqual([]);
  });
});
