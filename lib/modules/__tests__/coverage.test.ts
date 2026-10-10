import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES } from '../registry';

/**
 * The registry is only a control if every route of a switchable module checks
 * it on the server (ADR-021). This reads the source: each page, layout, route
 * handler and server-action file under a non-core module's routes must call
 * `requireModule(`, `assertModule(` or pass `module: '<id>'` to ipdCaller.
 *
 * It also catches a registry route that points nowhere (a typo, or a module
 * declared before its code exists).
 */

const APP = join(process.cwd(), 'app');
const ENTRY_FILES = /^(page|layout|route|actions)\.tsx?$/;

/** `/settings/ipd` lives at app/(app)/settings/ipd; `/print/ipd-file` at app/print/ipd-file. */
function directoriesFor(route: string): string[] {
  const parts = route.split('/').filter(Boolean);
  return [join(APP, ...parts), join(APP, '(app)', ...parts)].filter((dir) => existsSync(dir) && statSync(dir).isDirectory());
}

function entryFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return entryFiles(path);
    return ENTRY_FILES.test(name) ? [path] : [];
  });
}

describe('module route coverage', () => {
  it('finds a directory for every route a module declares', () => {
    for (const def of MODULES) {
      for (const route of def.routes) {
        expect(directoriesFor(route), `${def.id}: ${route}`).not.toEqual([]);
      }
    }
  });

  it('makes every route of a switchable module check the module on the server', () => {
    const unguarded: string[] = [];
    for (const def of MODULES.filter((m) => !m.core)) {
      const guard = new RegExp(`requireModule\\([^)]*'${def.id}'|assertModule\\([^)]*'${def.id}'|module:\\s*'${def.id}'`);
      for (const route of def.routes) {
        for (const dir of directoriesFor(route)) {
          for (const file of entryFiles(dir)) {
            if (!guard.test(readFileSync(file, 'utf8'))) unguarded.push(`${def.id}: ${file.slice(process.cwd().length + 1)}`);
          }
        }
      }
    }
    expect(unguarded).toEqual([]);
  });
});
