import { can, type Permission, type StaffRole } from '@/lib/domain/permissions';

/**
 * The module registry (ADR-021, IPD sheets plan §4.1).
 *
 * Every IPD capability that a hospital can switch on or off is declared here
 * once. The patient-file tabs, the print list and the Settings → Modules screen
 * are generated from this list, and pages and APIs check it on the server — so
 * a module that is off is hidden *and* refused, and nothing has to be kept in
 * step by hand.
 *
 * A hospital's choices live in `hospital_features`; a module with no row there
 * has its `defaultState`. Turning a module off never deletes data.
 *
 * Pure: no database, no React. A module is added here in the same change as its
 * first route, never before (so nothing lists a sheet that does not exist).
 */

export const MODULE_STATES = ['on', 'read_only', 'off'] as const;
export type ModuleState = (typeof MODULE_STATES)[number];

export const MODULE_STAGES = ['observe', 'warn', 'enforce'] as const;
export type ModuleStage = (typeof MODULE_STAGES)[number];

export type ModuleTier = 'basic' | 'standard' | 'enterprise';

/** A tab on the patient file, under /ipd/admissions/[id]. `slug` '' is the Summary. */
export type FileTab = { slug: string; label: string; permission: Permission; order: number };

/** A section of the whole-file print (/print/ipd-file/[admissionId]?sheets=…). */
export type PrintSheet = { id: string; label: string; permission: Permission; order: number };

export type ModuleDefinition = {
  id: string;
  title: string;
  description: string;
  tier: ModuleTier;
  /** Core modules are always on; Settings shows them but cannot change them. */
  core: boolean;
  /** Off (or read-only) when any of these is. */
  dependsOn: readonly string[];
  /** Used when present; the module still works without them. */
  uses: readonly string[];
  /** Page and API path prefixes the module owns; the coverage test checks each guards itself. */
  routes: readonly string[];
  fileTabs: readonly FileTab[];
  printSheets: readonly PrintSheet[];
  /** Whether observe / warn / enforce means anything for this module. */
  hasStages: boolean;
  defaultState: ModuleState;
};

export const MODULES = [
  {
    id: 'core_ipd',
    title: 'IPD',
    description: 'Admissions, wards and beds, bedside items, bed-day charges and the discharge bill.',
    tier: 'basic',
    core: true,
    dependsOn: [],
    uses: [],
    routes: ['/ipd', '/api/ipd', '/print/ipd-bill', '/settings/ipd'],
    fileTabs: [{ slug: '', label: 'Summary', permission: 'ipd.view', order: 0 }],
    printSheets: [],
    hasStages: false,
    defaultState: 'on',
  },
  {
    id: 'patient_file',
    title: 'Patient file',
    description: 'The patient’s IPD file: sheet tabs in paper order, and the whole-file print.',
    tier: 'basic',
    core: true,
    dependsOn: ['core_ipd', 'letterhead'],
    uses: [],
    routes: ['/print/ipd-file'],
    fileTabs: [],
    printSheets: [{ id: 'cover', label: 'File cover (admission details)', permission: 'ipd.view', order: 0 }],
    hasStages: false,
    defaultState: 'on',
  },
  {
    id: 'charts',
    title: 'T.P.R. chart',
    description: 'The nursing chart: pulse, BP, SpO2, temperature, sugar, breathing, intake and output — by the hour, like the paper.',
    tier: 'basic',
    core: false,
    dependsOn: ['patient_file'],
    uses: [],
    routes: ['/api/ipd/tpr', '/ipd/admissions/[id]/(file)/tpr'],
    fileTabs: [{ slug: 'tpr', label: 'TPR chart', permission: 'ipd.view', order: 10 }],
    printSheets: [{ id: 'tpr', label: 'Nursing T.P.R. chart', permission: 'ipd.view', order: 10 }],
    hasStages: false,
    // Off until the owner switches it on, ward by ward (plan §11.3 rule 8, §12).
    defaultState: 'off',
  },
  {
    id: 'stock',
    title: 'Risk-class stock',
    description:
      'Narcotics, psychotropics and other risk-class medicines: received against invoices, sent between stores, counted blind every day, differences explained and approved by a second person.',
    tier: 'basic',
    core: false,
    dependsOn: [],
    uses: [],
    routes: ['/ipd/stock', '/settings/stock'],
    fileTabs: [],
    printSheets: [],
    // Observe: a count by someone who moved the stock is flagged. Enforce: it is refused.
    hasStages: true,
    defaultState: 'off',
  },
  {
    id: 'staff_access',
    title: 'Staff sign-in',
    description: 'Ward tablets with a PIN per person, the lock on personal phones, and the monitoring notice.',
    tier: 'basic',
    core: true,
    dependsOn: [],
    uses: [],
    routes: ['/ward-device', '/unlock', '/notice', '/settings/staff-access', '/account'],
    fileTabs: [],
    printSheets: [],
    hasStages: false,
    defaultState: 'on',
  },
  {
    id: 'acct_core',
    title: 'Evidence log',
    description:
      'Every charting, bedside, billing and sign-in action recorded with who, when and from which device, sealed every hour so it cannot be changed unnoticed.',
    tier: 'basic',
    // Plan §4.2: the evidence log never stops.
    core: true,
    dependsOn: [],
    uses: [],
    routes: ['/accountability'],
    fileTabs: [],
    printSheets: [],
    hasStages: false,
    defaultState: 'on',
  },
  {
    id: 'letterhead',
    title: 'Letterhead',
    description: 'Hospital registration number, phones and doctors’ degrees printed at the top of every sheet.',
    tier: 'basic',
    core: true,
    dependsOn: [],
    uses: [],
    routes: ['/settings/letterhead'],
    fileTabs: [],
    printSheets: [],
    hasStages: false,
    defaultState: 'on',
  },
] as const satisfies readonly ModuleDefinition[];

export type ModuleId = (typeof MODULES)[number]['id'];

const BY_ID = new Map<string, ModuleDefinition>(MODULES.map((def) => [def.id, def]));

export const isModuleId = (value: string): value is ModuleId => BY_ID.has(value);

export function moduleById(id: ModuleId): ModuleDefinition {
  return BY_ID.get(id)!;
}

/** Wards a module is rolled out to; `all: true` is every ward. */
export type RolloutScope = { all: true } | { all: false; wardIds: string[] };

/** A `hospital_features` row, as stored. */
export type StoredModuleRow = {
  moduleId: string;
  state: ModuleState;
  rolloutScope: RolloutScope;
  stage: ModuleStage;
  settings: Record<string, unknown>;
};

export type EffectiveModule = {
  id: ModuleId;
  state: ModuleState;
  stage: ModuleStage;
  rolloutScope: RolloutScope;
  settings: Record<string, unknown>;
  /** Why the state is what it is. */
  source: 'core' | 'default' | 'stored' | 'dependency';
  /** The hard dependency that lowered the state, when `source` is 'dependency'. */
  limitedBy: ModuleId | null;
};

export type ModuleStates = ReadonlyMap<ModuleId, EffectiveModule>;

const RANK: Record<ModuleState, number> = { off: 0, read_only: 1, on: 2 };

/** Modules in an order where every module comes after its hard dependencies. */
export function dependencyOrder(modules: readonly ModuleDefinition[] = MODULES): ModuleDefinition[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const ordered: ModuleDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (def: ModuleDefinition, path: string[]) => {
    const seen = state.get(def.id);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`module dependency cycle: ${[...path, def.id].join(' → ')}`);
    state.set(def.id, 'visiting');
    for (const dep of def.dependsOn) {
      const target = byId.get(dep);
      if (!target) throw new Error(`module ${def.id} depends on unknown module ${dep}`);
      visit(target, [...path, def.id]);
    }
    state.set(def.id, 'done');
    ordered.push(def);
  };
  for (const def of modules) visit(def, []);
  return ordered;
}

/**
 * Each module's effective state for one hospital. Core modules are on whatever
 * is stored; a module is never more available than its least available hard
 * dependency; rows for modules this code does not know are ignored (deny by
 * default: an unknown id is never "on").
 */
export function resolveModuleStates(
  rows: readonly StoredModuleRow[],
  modules: readonly ModuleDefinition[] = MODULES,
): ModuleStates {
  const known = new Set(modules.map((m) => m.id));
  const stored = new Map(rows.filter((row) => known.has(row.moduleId)).map((row) => [row.moduleId, row]));
  const result = new Map<ModuleId, EffectiveModule>();

  for (const def of dependencyOrder(modules)) {
    const id = def.id as ModuleId;
    const row = stored.get(id);
    let state: ModuleState = def.core ? 'on' : (row?.state ?? def.defaultState);
    let source: EffectiveModule['source'] = def.core ? 'core' : row ? 'stored' : 'default';
    let limitedBy: ModuleId | null = null;

    for (const dep of def.dependsOn) {
      const depState = result.get(dep as ModuleId)!.state;
      if (RANK[depState] < RANK[state]) {
        state = depState;
        source = 'dependency';
        limitedBy = dep as ModuleId;
      }
    }

    result.set(id, {
      id,
      state,
      stage: def.hasStages ? (row?.stage ?? 'observe') : 'observe',
      rolloutScope: def.core ? { all: true } : (row?.rolloutScope ?? { all: true }),
      settings: row?.settings ?? {},
      source,
      limitedBy,
    });
  }
  return result;
}

/**
 * May this module be used for a read or a write, optionally on one ward?
 *
 * Off: nothing. Read-only: reads only. On: reads everywhere (records made
 * while a ward was in the rollout stay visible after it leaves), writes only on
 * wards inside the rollout scope.
 */
export function moduleAllows(
  states: ModuleStates,
  id: ModuleId,
  mode: 'read' | 'write',
  wardId: string | null = null,
): boolean {
  const def = states.get(id);
  if (!def || def.state === 'off') return false;
  if (mode === 'read') return true;
  if (def.state === 'read_only') return false;
  const scope = def.rolloutScope;
  if (scope.all || wardId === null) return scope.all || scope.wardIds.length > 0;
  return scope.wardIds.includes(wardId);
}

/** The patient-file tabs this role sees, in paper order. */
export function fileTabsFor(states: ModuleStates, role: StaffRole): FileTab[] {
  return MODULES.filter((def) => moduleAllows(states, def.id, 'read'))
    .flatMap((def) => def.fileTabs as readonly FileTab[])
    .filter((tab) => can(role, tab.permission))
    .sort((a, b) => a.order - b.order);
}

/** The sheets this role may print from the patient file, in paper order. */
export function printSheetsFor(states: ModuleStates, role: StaffRole): PrintSheet[] {
  return MODULES.filter((def) => moduleAllows(states, def.id, 'read'))
    .flatMap((def) => def.printSheets as readonly PrintSheet[])
    .filter((sheet) => can(role, sheet.permission))
    .sort((a, b) => a.order - b.order);
}

/** Modules whose hard dependencies include `id`: what else changes if it is turned off. */
export function dependentsOf(id: ModuleId): ModuleId[] {
  return MODULES.filter((def) => (def.dependsOn as readonly string[]).includes(id)).map((m) => m.id);
}
