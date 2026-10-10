import { describe, expect, it } from 'vitest';
import {
  MODULES,
  dependencyOrder,
  dependentsOf,
  fileTabsFor,
  isModuleId,
  moduleAllows,
  printSheetsFor,
  resolveModuleStates,
  type ModuleDefinition,
  type ModuleStates,
  type StoredModuleRow,
} from '../registry';

const row = (moduleId: string, state: StoredModuleRow['state'], extra: Partial<StoredModuleRow> = {}): StoredModuleRow => ({
  moduleId,
  state,
  rolloutScope: { all: true },
  stage: 'observe',
  settings: {},
  ...extra,
});

const mod = (id: string, dependsOn: string[] = []): ModuleDefinition => ({
  id,
  title: id,
  description: id,
  tier: 'basic',
  core: false,
  dependsOn,
  uses: [],
  routes: [],
  fileTabs: [],
  printSheets: [],
  hasStages: false,
  defaultState: 'on',
});

describe('the registry itself', () => {
  it('has unique ids, known dependencies and no cycles', () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length);
    expect(() => dependencyOrder()).not.toThrow();
  });

  it('lets a core module depend only on core modules, so core is always fully on', () => {
    for (const def of MODULES.filter((m) => m.core)) {
      for (const dep of def.dependsOn) {
        expect(MODULES.find((m) => m.id === dep)?.core, `${def.id} → ${dep}`).toBe(true);
      }
    }
  });

  it('gives every route prefix to exactly one module', () => {
    const routes = MODULES.flatMap((m) => [...m.routes]);
    expect(new Set(routes).size).toBe(routes.length);
    for (const route of routes) expect(route.startsWith('/')).toBe(true);
  });

  it('uses each tab slug and print sheet id once', () => {
    const slugs = MODULES.flatMap((m) => m.fileTabs.map((t) => t.slug as string));
    const sheets = MODULES.flatMap((m) => m.printSheets.map((s) => s.id as string));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(sheets).size).toBe(sheets.length);
  });

  it('orders dependencies first and refuses a cycle or an unknown dependency', () => {
    const order = dependencyOrder([mod('b', ['a']), mod('a')]).map((m) => m.id);
    expect(order).toEqual(['a', 'b']);
    expect(() => dependencyOrder([mod('a', ['b']), mod('b', ['a'])])).toThrow(/cycle/);
    expect(() => dependencyOrder([mod('a', ['missing'])])).toThrow(/unknown/);
  });
});

describe('resolveModuleStates', () => {
  it('keeps core modules on whatever is stored', () => {
    const states = resolveModuleStates([row('core_ipd', 'off'), row('letterhead', 'read_only')]);
    expect(states.get('core_ipd')).toMatchObject({ state: 'on', source: 'core' });
    expect(states.get('letterhead')).toMatchObject({ state: 'on', source: 'core' });
  });

  it('gives every known module a state, and ignores rows for unknown modules', () => {
    const states = resolveModuleStates([row('no_such_module', 'on')]);
    expect([...states.keys()].sort()).toEqual(MODULES.map((m) => m.id).sort());
    expect(isModuleId('no_such_module')).toBe(false);
  });

  it('makes a module no more available than its least available hard dependency', () => {
    const modules = [mod('a'), mod('b', ['a']), mod('c', ['b'])];
    const offA = resolveModuleStates([row('a', 'off')], modules) as ReadonlyMap<string, { state: string; source: string; limitedBy: string | null }>;
    expect(offA.get('b')).toMatchObject({ state: 'off', source: 'dependency', limitedBy: 'a' });
    expect(offA.get('c')).toMatchObject({ state: 'off', source: 'dependency', limitedBy: 'b' });

    const readOnlyA = resolveModuleStates([row('a', 'read_only')], modules) as ReadonlyMap<string, { state: string }>;
    expect(readOnlyA.get('b')?.state).toBe('read_only');

    const offB = resolveModuleStates([row('b', 'off')], modules) as ReadonlyMap<string, { state: string; source: string }>;
    expect(offB.get('a')).toMatchObject({ state: 'on', source: 'default' });
    expect(offB.get('b')).toMatchObject({ state: 'off', source: 'stored' });
  });

  it('lists what depends on a module', () => {
    expect(dependentsOf('letterhead')).toContain('patient_file');
  });
});

describe('moduleAllows', () => {
  const states = (state: StoredModuleRow['state'], scope: StoredModuleRow['rolloutScope'] = { all: true }): ModuleStates =>
    new Map([
      [
        'patient_file',
        { id: 'patient_file', state, stage: 'observe', rolloutScope: scope, settings: {}, source: 'stored', limitedBy: null },
      ],
    ]) as unknown as ModuleStates;

  it('refuses everything when off', () => {
    expect(moduleAllows(states('off'), 'patient_file', 'read')).toBe(false);
    expect(moduleAllows(states('off'), 'patient_file', 'write')).toBe(false);
  });

  it('allows reads only when read-only', () => {
    expect(moduleAllows(states('read_only'), 'patient_file', 'read')).toBe(true);
    expect(moduleAllows(states('read_only'), 'patient_file', 'write')).toBe(false);
  });

  it('writes only on wards in the rollout, but reads everywhere', () => {
    const scoped = states('on', { all: false, wardIds: ['ward-a'] });
    expect(moduleAllows(scoped, 'patient_file', 'write', 'ward-a')).toBe(true);
    expect(moduleAllows(scoped, 'patient_file', 'write', 'ward-b')).toBe(false);
    expect(moduleAllows(scoped, 'patient_file', 'read', 'ward-b')).toBe(true);
    expect(moduleAllows(states('on', { all: false, wardIds: [] }), 'patient_file', 'write')).toBe(false);
  });

  it('refuses a module it has no state for', () => {
    expect(moduleAllows(new Map() as ModuleStates, 'patient_file', 'read')).toBe(false);
  });
});

describe('tabs and print sheets', () => {
  const states = resolveModuleStates([]);

  it('shows the Summary tab to every IPD role', () => {
    for (const role of ['owner', 'receptionist', 'doctor', 'nurse'] as const) {
      expect(fileTabsFor(states, role).map((t) => t.slug)).toEqual(['']);
    }
  });

  it('offers the file cover for printing', () => {
    expect(printSheetsFor(states, 'nurse').map((s) => s.id)).toEqual(['cover']);
  });
});
