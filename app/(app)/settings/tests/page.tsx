import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { SaveButton, SaveForm } from '@/components/save-form';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { CLOCK_FROM, DEFAULT_CLOCK_MINUTES, SERVICE_POINT_KINDS, directionsLine } from '@/lib/domain/test-orders';
import { listBranches, listStaffMembers } from '@/lib/services/auth';
import { listServicePoints, listTestItems, type ServicePointRow } from '@/lib/services/test-orders';
import {
  assignStaffAction,
  createServicePointAction,
  placeTestsAction,
  removeStaffAction,
  setServicePointActiveAction,
  updateServicePointAction,
} from './actions';

export const metadata = { title: 'Tests · Settings' };

const field = 'mt-1 block h-11 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300';

/**
 * Settings → Tests (IPD sheets plan C4a). Each lab or room: its name and the
 * way to it in English, Marathi and Hindi (read out to a patient who is lost),
 * when its "not arrived" clock starts and how long it runs (D-LABCLOCK), and
 * its staff. Then which test is done where: a test with no lab or room is
 * billed as before but never followed up.
 */
export default async function TestSettingsPage({ searchParams }: PageProps<'/settings/tests'>) {
  const session = await requireSession();
  await requireModule(session, 'test_follow_up');
  if (!can(session.role, 'tests.configure')) notFound();
  const query = await searchParams;
  const savedPoint = typeof query.point === 'string' ? query.point : null;

  const [points, tests, branches, staff] = await Promise.all([
    listServicePoints(session.hospitalId, { includeInactive: true }),
    listTestItems(session.hospitalId),
    listBranches(session.hospitalId),
    listStaffMembers(session.hospitalId),
  ]);
  const activeStaff = staff.filter((s) => s.active);
  const openPoints = points.filter((p) => p.active);
  const unplaced = tests.filter((t) => !t.servicePointId).length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link href="/settings" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Settings
      </Link>
      <div>
        <h1 className="text-xl font-bold text-ink-900">Tests and labs</h1>
        <p className="text-sm text-ink-600">
          Where each test is done, the way there, and who follows up a patient who has not arrived. Tests themselves (names and prices) are under{' '}
          <Link href="/settings/ipd/items" className="font-medium text-brand-700 underline">
            Settings → IPD items
          </Link>
          .
        </p>
      </div>
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      {points.length === 0 ? (
        <Card>
          <EmptyState title="No lab or room yet" hint="Add the first one below, e.g. Pathology lab, X-ray room, ECG room." />
        </Card>
      ) : (
        points.map((point) => (
          <PointCard key={point.id} point={point} staff={activeStaff} justSaved={savedPoint === point.id} />
        ))
      )}

      <Card>
        <CardHeader title="Add a lab or room" hint="Floor and section help the staff guide a patient on the phone." />
        <form action={createServicePointAction} className="space-y-4 p-4 sm:p-5">
          <PointFields branches={branches} defaultBranch={session.branchId ?? branches[0]?.id} />
          <Button type="submit" variant="primary" className="h-11">
            Add lab or room
          </Button>
        </form>
      </Card>

      <Card>
        <div id="tests" className="scroll-mt-20" />
        <CardHeader
          title="Which test is done where"
          hint={
            tests.length === 0
              ? 'No tests yet'
              : unplaced > 0
                ? `${unplaced} test${unplaced === 1 ? '' : 's'} not placed: they are billed but not followed up`
                : 'Every test is placed'
          }
        />
        {tests.length === 0 ? (
          <EmptyState title="No tests in the item list" hint="Add them under Settings → IPD items and tick “This is a lab or imaging test”." />
        ) : openPoints.length === 0 ? (
          <EmptyState title="Add a lab or room first" />
        ) : (
          <SaveForm action={placeTestsAction} justSaved={query.placed === '1'} className="p-0">
            <ul className="divide-y divide-ink-100">
              {tests.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm sm:px-5">
                  <span className={cn('min-w-0 font-semibold', t.servicePointId ? 'text-ink-900' : 'text-amber-800')}>{t.name}</span>
                  <input type="hidden" name={`was:${t.id}`} value={t.servicePointId ?? ''} />
                  <select
                    name={`place:${t.id}`}
                    defaultValue={t.servicePointId ?? ''}
                    aria-label={`Where ${t.name} is done`}
                    className="h-11 min-w-48 rounded-lg border-0 bg-white px-2 text-sm ring-1 ring-inset ring-ink-300"
                  >
                    <option value="">Not followed up</option>
                    {points.map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.active}>
                        {p.name}
                        {p.active ? '' : ' (closed)'}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
            <div className="border-t border-ink-100 px-4 py-3 sm:px-5">
              <SaveButton label="Save" countNoun="test" variant="primary" size="md" />
            </div>
          </SaveForm>
        )}
      </Card>
    </div>
  );
}

function PointCard({
  point,
  staff,
  justSaved,
}: {
  point: ServicePointRow;
  staff: { userId: string; name: string; role: string }[];
  justSaved: boolean;
}) {
  const assigned = new Set(point.staff.map((s) => s.userId));
  const addable = staff.filter((s) => !assigned.has(s.userId));
  return (
    <Card>
      <div id={`point-${point.id}`} className="scroll-mt-20" />
      <CardHeader
        title={
          <span className={cn(!point.active && 'text-ink-400')}>
            {point.name} · {SERVICE_POINT_KINDS[point.kind]}
            {point.active ? '' : ' · closed'}
          </span>
        }
        hint={`${directionsLine(point, 'en')} · ${point.branchName} · ${point.tests} test${point.tests === 1 ? '' : 's'} · clock ${CLOCK_FROM[point.clockFrom].toLowerCase()}, ${point.clockMinutes} min`}
        action={
          <form action={setServicePointActiveAction}>
            <input type="hidden" name="servicePointId" value={point.id} />
            <input type="hidden" name="active" value={String(!point.active)} />
            <Button type="submit" variant="ghost" size="sm" className="h-11">
              {point.active ? 'Close' : 'Reopen'}
            </Button>
          </form>
        }
      />

      <div className="border-b border-ink-100 px-4 py-3 sm:px-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Staff who follow up</h3>
        {point.staff.length === 0 ? (
          <p className="mt-1 text-sm text-amber-800">Nobody yet: a patient who does not arrive goes straight to you.</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-2">
            {point.staff.map((s) => (
              <li key={s.userId}>
                <form action={removeStaffAction} className="inline-flex items-center gap-1 rounded-full bg-ink-100 py-1 pl-3 pr-1 text-sm">
                  <input type="hidden" name="servicePointId" value={point.id} />
                  <input type="hidden" name="userId" value={s.userId} />
                  <span>
                    {s.name} <span className="text-xs capitalize text-ink-500">{s.role}</span>
                  </span>
                  <button
                    type="submit"
                    aria-label={`Remove ${s.name}`}
                    className="flex size-9 items-center justify-center rounded-full text-ink-500 hover:bg-ink-200 hover:text-ink-900"
                  >
                    ×
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {addable.length > 0 ? (
          <form action={assignStaffAction} className="mt-2 flex gap-2">
            <input type="hidden" name="servicePointId" value={point.id} />
            <select name="userId" defaultValue="" aria-label={`Add staff to ${point.name}`} className="h-11 min-w-0 flex-1 rounded-lg border-0 bg-white px-2 text-sm ring-1 ring-inset ring-ink-300">
              <option value="" disabled>
                Add a person…
              </option>
              {addable.map((s) => (
                <option key={s.userId} value={s.userId}>
                  {s.name} ({s.role})
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary" className="h-11">
              Add
            </Button>
          </form>
        ) : null}
      </div>

      <details className="group" open={justSaved}>
        <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-medium text-brand-700 sm:px-5">
          Edit name, directions and clock
        </summary>
        <SaveForm action={updateServicePointAction} justSaved={justSaved} className="space-y-4 p-4 pt-0 sm:p-5 sm:pt-0">
          <input type="hidden" name="servicePointId" value={point.id} />
          <PointFields point={point} />
          <SaveButton label="Save" variant="primary" size="md" />
        </SaveForm>
      </details>
    </Card>
  );
}

function PointFields({
  point,
  branches,
  defaultBranch,
}: {
  point?: ServicePointRow;
  branches?: { id: string; name: string }[];
  defaultBranch?: string;
}) {
  const lang = (label: string, name: string, max: number, values: [string | null | undefined, string | null | undefined, string | null | undefined], placeholder: string, required = false) => (
    <fieldset className="grid gap-2 sm:grid-cols-3">
      <legend className="mb-1 text-sm font-medium text-ink-700">{label}</legend>
      <label className="block text-xs text-ink-600">
        English
        <input name={name} required={required} maxLength={max} defaultValue={values[0] ?? ''} placeholder={placeholder} className={field} />
      </label>
      <label className="block text-xs text-ink-600">
        मराठी
        <input name={`${name}Mr`} maxLength={max} defaultValue={values[1] ?? ''} lang="mr" className={field} />
      </label>
      <label className="block text-xs text-ink-600">
        हिंदी
        <input name={`${name}Hi`} maxLength={max} defaultValue={values[2] ?? ''} lang="hi" className={field} />
      </label>
    </fieldset>
  );
  return (
    <>
      {lang('Name', 'name', 60, [point?.name, point?.nameMr, point?.nameHi], 'e.g. Pathology lab', true)}
      {lang('Floor', 'floor', 40, [point?.floor, point?.floorMr, point?.floorHi], 'e.g. First floor')}
      {lang('Section — how to find it', 'section', 80, [point?.section, point?.sectionMr, point?.sectionHi], 'e.g. Room 12, behind the pharmacy')}
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-sm font-medium text-ink-700">
          Kind
          <select name="kind" defaultValue={point?.kind ?? 'lab'} className={field}>
            {Object.entries(SERVICE_POINT_KINDS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-ink-700">
          Clock starts
          <select name="clockFrom" defaultValue={point?.clockFrom ?? 'order'} className={field}>
            {Object.entries(CLOCK_FROM).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-ink-700">
          Not arrived after (min)
          <input
            name="clockMinutes"
            type="number"
            inputMode="numeric"
            min={5}
            max={240}
            required
            defaultValue={point?.clockMinutes ?? DEFAULT_CLOCK_MINUTES}
            className={field}
          />
        </label>
        {branches ? (
          <label className="block text-sm font-medium text-ink-700">
            Branch
            <select name="branchId" defaultValue={defaultBranch} className={field}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <p className="text-xs text-ink-500">
        Ward tests always count from the order (the ward bill is paid at discharge). “From payment” applies to OPD tests: the clock starts when the desk marks the visit paid.
      </p>
    </>
  );
}
