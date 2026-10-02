import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { readWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { can } from '@/lib/domain/permissions';
import { listBranches } from '@/lib/services/auth';
import { listPinStatus, listWardDevices, resolveWardDevice } from '@/lib/services/ward-devices';
import { clearPinAction, registerThisDeviceAction, revokeDeviceAction } from './actions';

export const metadata = { title: 'Ward devices · Settings' };

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

/**
 * Settings → IPD → Ward devices (task T1.9, decision D-DV): shared ward
 * tablets and the PINs that unlock them. A tablet is registered from the
 * tablet itself; a PIN is set by its owner, with their own login, so the
 * hospital owner never knows anyone's PIN — they can only clear one.
 */
export default async function WardDevicesPage({ searchParams }: PageProps<'/settings/ipd/devices'>) {
  const session = await requireSession();
  const params = await searchParams;
  if (!can(session.role, 'ipd.configure')) {
    return (
      <Card>
        <EmptyState title="Owners only" hint="Ask the hospital owner to register ward tablets." />
      </Card>
    );
  }

  const [devices, people, branchRows, thisDevice] = await Promise.all([
    listWardDevices(session.hospitalId),
    listPinStatus(session.hospitalId),
    listBranches(session.hospitalId),
    resolveWardDevice(await readWardDeviceCookie()),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings/ipd" className="text-sm text-ink-500 hover:text-ink-800">
          ← Wards and beds
        </Link>
        <h1 className="mt-1 text-xl font-bold text-ink-900">Ward devices and PINs</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          A shared tablet on the ward opens on “Who is recording?”. Each nurse unlocks it with a 4-digit
          PIN, and it locks again after 10 minutes unused.
        </p>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <Alert tone="success">{params.saved}</Alert> : null}

      <Card>
        <CardHeader
          title={thisDevice ? `This device is “${thisDevice.label}”` : 'Register this device'}
          hint={thisDevice ? 'Sign out on it, and nurses can tap their name.' : 'Do this on the ward tablet itself.'}
        />
        {thisDevice ? null : (
          <form action={registerThisDeviceAction} className="grid gap-3 p-4 sm:grid-cols-3 sm:p-5">
            <Field label="Name it">
              <Input name="label" required maxLength={60} placeholder="Ward A tablet" />
            </Field>
            <Field label="Branch">
              <select name="branchId" className={SELECT_CLASS} defaultValue={session.branchId ?? branchRows[0]?.id}>
                {branchRows.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary" size="lg" className="w-full">
                Make this a ward tablet
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Card>
        <CardHeader title="Registered devices" />
        {devices.length === 0 ? (
          <EmptyState title="No ward tablets yet." hint="Nurses can still record from their own phones with their own login." />
        ) : (
          <ul className="divide-y divide-ink-200">
            {devices.map((device) => (
              <li key={device.id} className={cn('flex items-center justify-between gap-3 px-4 py-3 sm:px-5', device.revokedAt && 'opacity-60')}>
                <div className="min-w-0">
                  <p className="font-semibold text-ink-900">{device.label}</p>
                  <p className="text-xs text-ink-500">
                    {device.branchName}
                    {device.revokedAt
                      ? ' · removed'
                      : device.lastSeenAt
                        ? ` · last used ${device.lastSeenAt.toLocaleDateString('en-IN')}`
                        : ' · not used yet'}
                  </p>
                </div>
                {device.revokedAt ? null : (
                  <form action={revokeDeviceAction}>
                    <input type="hidden" name="deviceId" value={device.id} />
                    <Button type="submit" size="sm" variant="danger">
                      Remove
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Ward PINs" hint="Each person sets their own on the Ward screen, after signing in." />
        {people.length === 0 ? (
          <EmptyState title="No ward staff yet." hint="Add nurses in Settings → Staff." />
        ) : (
          <ul className="divide-y divide-ink-200">
            {people.map((person) => (
              <li key={person.userId} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div>
                  <p className="font-semibold text-ink-900">{person.name}</p>
                  <p className="text-xs capitalize text-ink-500">
                    {person.role} · {person.hasPin ? 'PIN set' : 'no PIN yet'}
                  </p>
                </div>
                {person.hasPin ? (
                  <form action={clearPinAction}>
                    <input type="hidden" name="userId" value={person.userId} />
                    <Button type="submit" size="sm" variant="ghost">
                      Clear PIN
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
