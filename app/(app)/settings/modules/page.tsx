import Link from 'next/link';
import { SaveButton, SaveForm } from '@/components/save-form';
import { SavedNotice } from '@/components/saved-notice';
import { Alert, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { LayersIcon } from '@/components/icons';
import { getModuleStatesForRequest } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { MODULES, dependentsOf, moduleById, type EffectiveModule, type ModuleDefinition } from '@/lib/modules/registry';
import { listWardSetup } from '@/lib/services/ipd-config';
import { setModuleStateAction } from './actions';

export const metadata = { title: 'Modules · Settings' };

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer';

const STATE_LABELS = { on: 'On', read_only: 'Read-only', off: 'Off' } as const;
const STATE_HINTS = {
  on: 'In use.',
  read_only: 'Old records can be viewed and printed; nothing new can be added.',
  off: 'Hidden. Records already made are kept and still print in the patient file.',
} as const;
const STAGE_LABELS = {
  observe: 'Observe — record only, no warnings',
  warn: 'Warn — show warnings, allow with a reason',
  enforce: 'Enforce — block until done',
} as const;

/**
 * Settings → Modules (ADR-021): what this hospital uses. Each module can be on,
 * read-only or off, and rolled out to chosen wards first; the core is always
 * on. Changes are audited and take effect at once, on the server as well as
 * on screen. Nothing is deleted when a module is turned off.
 */
export default async function ModulesSettingsPage({ searchParams }: PageProps<'/settings/modules'>) {
  const session = await requireSession();
  const params = await searchParams;
  if (!can(session.role, 'hospital.configure')) {
    return (
      <Card>
        <EmptyState title="Owners only" hint="Ask the hospital owner to change which modules are in use." />
      </Card>
    );
  }

  const [states, wards] = await Promise.all([getModuleStatesForRequest(session.hospitalId), listWardSetup(session.hospitalId)]);
  const activeWards = wards.filter((ward) => ward.active);
  const savedId = typeof params.id === 'string' ? params.id : null;
  const optional = MODULES.filter((def) => !def.core);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-ink-500 hover:text-ink-800">
          ← Settings
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-bold text-ink-900">
          <LayersIcon className="size-5 text-brand-600" />
          Modules
        </h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Switch parts of the IPD on ward by ward. Turning one off hides it; nothing recorded is deleted.
        </p>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <SavedNotice message={params.saved} /> : null}

      {optional.length === 0 ? (
        <Alert tone="info">
          Only the core is installed so far. New sheets (TPR chart, medicines round, stock counts) appear here as they arrive,
          off until you switch them on.
        </Alert>
      ) : null}

      {optional.map((def) => (
        <ModuleCard
          key={def.id}
          def={def}
          effective={states.get(def.id)!}
          wards={activeWards.map((ward) => ({ id: ward.id, name: `${ward.name} · ${ward.branchName}` }))}
          justSaved={savedId === def.id}
        />
      ))}

      <Card>
        <CardHeader title="Always on" hint="The core of the IPD. These cannot be switched off." />
        <ul className="divide-y divide-ink-100">
          {MODULES.filter((def) => def.core).map((def) => (
            <li key={def.id} className="flex items-start justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="font-semibold text-ink-900">{def.title}</p>
                <p className="text-sm text-ink-600">{def.description}</p>
              </div>
              <StateChip state="on" />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function StateChip({ state }: { state: EffectiveModule['state'] }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        state === 'on' && 'bg-brand-50 text-brand-800 ring-brand-300',
        state === 'read_only' && 'bg-amber-50 text-amber-900 ring-amber-300',
        state === 'off' && 'bg-ink-100 text-ink-600 ring-ink-200',
      )}
    >
      {STATE_LABELS[state]}
    </span>
  );
}

function ModuleCard({
  def,
  effective,
  wards,
  justSaved,
}: {
  def: ModuleDefinition;
  effective: EffectiveModule;
  wards: { id: string; name: string }[];
  justSaved: boolean;
}) {
  const scopedWards = effective.rolloutScope.all ? null : new Set(effective.rolloutScope.wardIds);
  const dependents = dependentsOf(effective.id).map((id) => moduleById(id).title);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-ink-900">{def.title}</h2>
          <p className="text-sm text-ink-600">{def.description}</p>
          {def.dependsOn.length > 0 ? (
            <p className="mt-1 text-xs text-ink-500">Needs: {def.dependsOn.map((id) => MODULES.find((m) => m.id === id)?.title ?? id).join(', ')}</p>
          ) : null}
          {effective.source === 'dependency' && effective.limitedBy ? (
            <p className="mt-1 text-xs font-semibold text-amber-800">
              Limited because {moduleById(effective.limitedBy).title} is {STATE_LABELS[effective.state].toLowerCase()}.
            </p>
          ) : null}
        </div>
        <StateChip state={effective.state} />
      </div>
      <SaveForm action={setModuleStateAction} justSaved={justSaved} className="grid gap-3 px-4 py-4 sm:grid-cols-2 sm:px-5">
        <input type="hidden" name="moduleId" value={def.id} />
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink-700">State</span>
          <select name="state" defaultValue={effective.source === 'dependency' ? 'on' : effective.state} className={SELECT_CLASS}>
            {(['on', 'read_only', 'off'] as const).map((state) => (
              <option key={state} value={state}>
                {STATE_LABELS[state]} — {STATE_HINTS[state]}
              </option>
            ))}
          </select>
        </label>
        {def.hasStages ? (
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink-700">Stage</span>
            <select name="stage" defaultValue={effective.stage} className={SELECT_CLASS}>
              {(['observe', 'warn', 'enforce'] as const).map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <fieldset className="sm:col-span-2">
          <legend className="mb-1 text-sm font-medium text-ink-700">Wards</legend>
          <label className="mr-4 inline-flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name="scope" value="all" defaultChecked={scopedWards === null} /> All wards
          </label>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name="scope" value="wards" defaultChecked={scopedWards !== null} /> Only these wards:
          </label>
          <div className="mt-1 flex flex-wrap gap-x-4">
            {wards.map((ward) => (
              <label key={ward.id} className="inline-flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="wardIds" value={ward.id} defaultChecked={scopedWards?.has(ward.id) ?? false} />
                {ward.name}
              </label>
            ))}
          </div>
        </fieldset>
        {dependents.length > 0 ? (
          <p className="text-xs text-ink-500 sm:col-span-2">Turning this off also limits: {dependents.join(', ')}.</p>
        ) : null}
        <div className="sm:col-span-2">
          <SaveButton label="Save" size="md" />
        </div>
      </SaveForm>
    </Card>
  );
}
