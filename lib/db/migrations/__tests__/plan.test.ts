import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseDirectives, parseMigration, readMigrationFolder, tagNumber } from '../files';
import { planMigrations } from '../plan';

const file = (number: number, when: number, content = `select ${number};`) =>
  parseMigration({ idx: number, when, tag: `${String(number).padStart(4, '0')}_m${number}`, breakpoints: true }, content);

describe('migration files', () => {
  it('hashes the whole file the way drizzle does, so histories stay interchangeable', () => {
    const content = 'create table a (id int);\r\n--> statement-breakpoint\r\nselect 1;\r\n';
    const parsed = file(41, 1, content);
    expect(parsed.hash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(parsed.statements).toHaveLength(2);
  });

  it('drops blank statements after the last breakpoint', () => {
    expect(file(41, 1, 'select 1;\n--> statement-breakpoint\n\n').statements).toHaveLength(1);
  });

  it('reads directives only from the comment block at the top', () => {
    expect(parseDirectives('-- qurio:no-transaction\n-- qurio:lock-timeout=10s\nselect 1;')).toEqual({
      noTransaction: true,
      contract: false,
      lockTimeout: '10s',
      statementTimeout: null,
    });
    expect(parseDirectives('select 1;\n-- qurio:no-transaction').noTransaction).toBe(false);
    expect(parseDirectives('-- a plain comment\n-- qurio:contract\nselect 1;').contract).toBe(true);
  });

  it('refuses a directive it does not understand rather than ignoring it', () => {
    expect(() => parseDirectives('-- qurio:no-transactions\nselect 1;')).toThrow(/directive/);
    expect(() => parseDirectives('-- qurio:lock-timeout=soon\nselect 1;')).toThrow(/directive/);
  });

  it('takes the number from the tag', () => {
    expect(tagNumber('0041_ipd_foundation')).toBe(41);
    expect(() => tagNumber('41_x')).toThrow();
  });

  it('reads the real journal', () => {
    const files = readMigrationFolder('./drizzle');
    expect(files.length).toBeGreaterThan(30);
    expect(planMigrations(files, []).problems.filter((p) => p.level === 'error')).toEqual([]);
  });
});

describe('planMigrations', () => {
  const files = [file(1, 100), file(2, 200), file(3, 300)];

  it('applies everything to an empty database', () => {
    const plan = planMigrations(files, []);
    expect(plan.pending.map((f) => f.number)).toEqual([1, 2, 3]);
    expect(plan.problems).toEqual([]);
  });

  it('applies only what is newer than the last applied migration', () => {
    const plan = planMigrations(files, [
      { hash: files[0].hash, createdAt: 100 },
      { hash: files[1].hash, createdAt: 200 },
    ]);
    expect(plan.pending.map((f) => f.number)).toEqual([3]);
    expect(plan.applied.map((f) => f.number)).toEqual([1, 2]);
    expect(plan.lastAppliedWhen).toBe(200);
  });

  it('refuses an unapplied migration that drizzle would skip silently', () => {
    // 0040 promoted with an old `when` after 0041 is already applied.
    const promoted = [file(39, 100), file(41, 300), file(40, 200)];
    const plan = planMigrations(promoted, [
      { hash: promoted[0].hash, createdAt: 100 },
      { hash: promoted[1].hash, createdAt: 300 },
    ]);
    expect(plan.problems.map((p) => p.code)).toContain('would_be_skipped');
    expect(plan.pending).toEqual([]);
  });

  it('refuses a journal whose when values go backwards', () => {
    const plan = planMigrations([file(1, 200), file(2, 100)], []);
    expect(plan.problems.map((p) => p.code)).toContain('when_not_increasing');
  });

  it('refuses a number used twice', () => {
    const twice = [file(41, 100), parseMigration({ idx: 2, when: 200, tag: '0041_other', breakpoints: true }, 'select 2;')];
    expect(planMigrations(twice, []).problems.map((p) => p.code)).toContain('duplicate_number');
  });

  it('warns when an applied file was edited afterwards', () => {
    const plan = planMigrations(files, [{ hash: 'something-else', createdAt: 100 }]);
    expect(plan.problems).toContainEqual(expect.objectContaining({ level: 'warning', code: 'changed_after_apply' }));
  });

  it('warns about history the journal does not know', () => {
    const plan = planMigrations(files, [{ hash: 'x', createdAt: 999 }]);
    expect(plan.problems).toContainEqual(expect.objectContaining({ level: 'warning', code: 'unknown_history' }));
  });
});
