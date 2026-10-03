import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { BedIcon, TagIcon } from '@/components/icons';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import { can } from '@/lib/domain/permissions';
import { listBranches } from '@/lib/services/auth';
import { listRoomChargeItems, listWardSetup, type WardSetupRow } from '@/lib/services/ipd-config';
import {
  addBedsAction,
  createWardAction,
  toggleBedAction,
  toggleWardAction,
  updateWardAction,
} from './actions';

export const metadata = { title: 'IPD · Settings' };

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer';

/**
 * Settings → IPD: wards and their beds (IPD plan §5.7).
 *
 * Built to be done in one sitting: "Ward A, room charge General ward bed,
 * beds 1-12" is one form. Beds are never deleted — a bed with history is part
 * of an old bill — only taken out of use. The price list lives one screen
 * down, under Items and prices.
 */
export default async function IpdSettingsPage({ searchParams }: PageProps<'/settings/ipd'>) {
  const session = await requireSession();
  const params = await searchParams;

  if (!can(session.role, 'ipd.configure')) {
    return (
      <Card>
        <EmptyState title="Owners only" hint="Ask the hospital owner to set up wards and beds." />
      </Card>
    );
  }

  const [wardRows, branchRows, roomItems] = await Promise.all([
    listWardSetup(session.hospitalId),
    listBranches(session.hospitalId),
    listRoomChargeItems(session.hospitalId),
  ]);
  const totalBeds = wardRows.reduce((sum, ward) => sum + ward.beds.filter((b) => b.active).length, 0);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-ink-500 hover:text-ink-800">
          ← Settings
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-bold text-ink-900">
          <BedIcon className="size-5 text-brand-600" />
          IPD wards and beds
        </h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {wardRows.length === 0
            ? 'Add each ward and its beds. Nurses then pick a patient by tapping their bed.'
            : `${wardRows.length} ward${wardRows.length === 1 ? '' : 's'}, ${totalBeds} beds in use.`}
        </p>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <Alert tone="success">{params.saved}</Alert> : null}

      {can(session.role, 'billing.price') ? (
        <Card>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <TagIcon className="size-5 text-brand-600" />
                <h2 className="text-base font-bold text-ink-900">Items and prices</h2>
              </div>
              <p className="mt-0.5 text-xs text-ink-500">
                Consumables, procedures, tests and room charges that nurses record at the bedside.
              </p>
            </div>
            <Link href="/settings/ipd/items" className="w-full sm:w-auto">
              <Button variant="secondary" className="w-full justify-center sm:w-auto">
                Manage items and prices
              </Button>
            </Link>
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-ink-900">Ward tablets and PINs</h2>
            <p className="mt-0.5 text-xs text-ink-500">
              A shared tablet per ward, unlocked by each nurse’s 4-digit PIN.
            </p>
          </div>
          <Link href="/settings/ipd/devices" className="w-full sm:w-auto">
            <Button variant="secondary" className="w-full justify-center sm:w-auto">
              Ward devices
            </Button>
          </Link>
        </div>
      </Card>

      {wardRows.length === 0 ? null : (
        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          {wardRows.map((ward) => (
            <WardCard key={ward.id} ward={ward} roomItems={roomItems} showBranch={branchRows.length > 1} />
          ))}
        </div>
      )}

      <Card>
        <CardHeader title="Add a ward" hint="Name it as staff say it: “Ward A”, “ICU”, “Female ward”." />
        <form action={createWardAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 sm:p-5">
          <Field label="Ward name">
            <Input name="name" required maxLength={60} placeholder="Ward A" />
          </Field>
          {branchRows.length > 1 ? (
            <Field label="Branch">
              <select name="branchId" required className={SELECT_CLASS} defaultValue={branchRows[0]?.id}>
                {branchRows.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <input type="hidden" name="branchId" value={branchRows[0]?.id ?? ''} />
          )}
          <RoomChargeField roomItems={roomItems} />
          <Field label="Beds" hint="“1-12” makes twelve beds. Lists work too: “1-6, ICU-1”.">
            <Input name="beds" placeholder="1-12" />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" size="lg" className="w-full sm:w-auto">
              Add ward
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function RoomChargeField({
  roomItems,
  defaultValue,
}: {
  roomItems: Awaited<ReturnType<typeof listRoomChargeItems>>;
  defaultValue?: string | null;
}) {
  return (
    <Field label="Room charge per day" hint="Billed every night for each occupied bed.">
      <select name="dailyChargeItemId" className={SELECT_CLASS} defaultValue={defaultValue ?? ''}>
        <option value="">No room charge</option>
        {roomItems.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} —{' '}
            {item.sellingPricePaise === null ? 'no price yet' : `${formatRupees(item.sellingPricePaise)}/day`}
          </option>
        ))}
      </select>
    </Field>
  );
}

function WardCard({
  ward,
  roomItems,
  showBranch,
}: {
  ward: WardSetupRow;
  roomItems: Awaited<ReturnType<typeof listRoomChargeItems>>;
  showBranch: boolean;
}) {
  const activeBeds = ward.beds.filter((bed) => bed.active);
  const occupied = activeBeds.filter((bed) => bed.occupied).length;

  return (
    <Card className={cn(!ward.active && 'opacity-70')}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {ward.name}
            {!ward.active ? (
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-bold uppercase text-ink-600">
                Closed
              </span>
            ) : null}
          </span>
        }
        hint={[
          showBranch ? ward.branchName : null,
          `${occupied} of ${activeBeds.length} beds occupied`,
          ward.dailyChargeName
            ? `${ward.dailyChargeName}${ward.dailyChargePaise === null ? ' (no price yet)' : ` · ${formatRupees(ward.dailyChargePaise)}/day`}`
            : 'No room charge',
        ]
          .filter(Boolean)
          .join(' · ')}
      />

      <div className="space-y-4 p-4 sm:p-5">
        {activeBeds.length === 0 ? (
          <p className="text-sm text-ink-500">No beds yet. Add them below.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label={`Beds in ${ward.name}`}>
            {activeBeds.map((bed) => (
              <li
                key={bed.id}
                className={cn(
                  'numeric flex h-9 min-w-9 items-center justify-center rounded-md px-2 text-sm font-semibold ring-1 ring-inset',
                  bed.occupied
                    ? 'bg-brand-50 text-brand-800 ring-brand-300'
                    : 'bg-white text-ink-600 ring-ink-200',
                )}
                title={bed.occupied ? 'Occupied' : 'Free'}
              >
                {bed.label}
              </li>
            ))}
          </ul>
        )}

        <form action={addBedsAction} className="flex items-end gap-2">
          <input type="hidden" name="wardId" value={ward.id} />
          <div className="flex-1">
            <Field label="Add beds">
              <Input name="labels" required placeholder="13-16" />
            </Field>
          </div>
          <Button type="submit" size="lg">
            Add
          </Button>
        </form>

        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-ink-500 hover:text-ink-800">
            Edit ward, or take beds out of use
          </summary>
          <div className="mt-3 space-y-4">
            <form action={updateWardAction} className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="wardId" value={ward.id} />
              <Field label="Ward name">
                <Input name="name" required maxLength={60} defaultValue={ward.name} />
              </Field>
              <RoomChargeField roomItems={roomItems} defaultValue={ward.dailyChargeItemId} />
              <div className="sm:col-span-2">
                <Button type="submit">Save ward</Button>
              </div>
            </form>

            {ward.beds.length > 0 ? (
              <ul className="divide-y divide-ink-100 rounded-lg ring-1 ring-ink-200">
                {ward.beds.map((bed) => (
                  <li key={bed.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className={cn('numeric font-medium', bed.active ? 'text-ink-900' : 'text-ink-400 line-through')}>
                      Bed {bed.label}
                      {bed.occupied ? <span className="ml-2 text-xs font-normal text-brand-700">occupied</span> : null}
                    </span>
                    <form action={toggleBedAction}>
                      <input type="hidden" name="bedId" value={bed.id} />
                      <input type="hidden" name="active" value={bed.active ? 'false' : 'true'} />
                      <Button type="submit" size="sm" variant="ghost" disabled={bed.occupied}>
                        {bed.active ? 'Take out of use' : 'Put back'}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : null}

            <form action={toggleWardAction}>
              <input type="hidden" name="wardId" value={ward.id} />
              <input type="hidden" name="active" value={ward.active ? 'false' : 'true'} />
              <Button type="submit" size="sm" variant={ward.active ? 'danger' : 'secondary'}>
                {ward.active ? 'Close this ward' : 'Reopen this ward'}
              </Button>
            </form>
          </div>
        </details>
      </div>
    </Card>
  );
}
