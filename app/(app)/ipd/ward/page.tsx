import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input } from '@/components/ui';
import { BedIcon, ChevronRightIcon } from '@/components/icons';
import { GoToLastWard } from '@/components/ipd/last-ward';
import { OutboxStatus } from '@/components/ipd/outbox-status';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getIpdCensus } from '@/lib/services/ipd-census';
import { hasPin } from '@/lib/services/ward-devices';
import { setOwnPinAction } from '../actions';

export const metadata = { title: 'Ward · IPD' };

/**
 * The nurse's start screen (IPD plan §5.6): one big button per ward. With a
 * single ward — or a remembered one on this phone — it goes straight there.
 */
export default async function WardPickerPage({ searchParams }: PageProps<'/ipd/ward'>) {
  const session = await requireSession();
  const params = await searchParams;
  if (!can(session.role, 'ipd.record')) {
    return (
      <Card>
        <EmptyState title="Recording is for the ward team" hint="Nurses and the desk record items here." />
      </Card>
    );
  }

  const census = await getIpdCensus({ hospitalId: session.hospitalId, branchId: session.branchId });
  const choosing = params.pick === '1';
  const message = typeof params.error === 'string' || typeof params.saved === 'string';
  // On her own login (not a shared tablet), a nurse can set the PIN she uses
  // on the tablet; until she has one, this screen is not skipped.
  const ownLogin = session.wardDeviceId === null && !session.readOnly;
  const pinSet = ownLogin ? await hasPin(session.hospitalId, session.userId) : true;
  const stay = choosing || message || !pinSet;
  if (census.wards.length === 1 && !stay) redirect(`/ipd/ward/${census.wards[0].id}`);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {!stay ? <GoToLastWard wardIds={census.wards.map((ward) => ward.id)} /> : null}
      <OutboxStatus />
      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <Alert tone="success">{params.saved}</Alert> : null}
      <h1 className="text-xl font-bold text-ink-900">Which ward are you on?</h1>
      {census.wards.length === 0 ? (
        <Card>
          <EmptyState title="No wards yet." hint="Ask the hospital owner to add wards and beds." />
        </Card>
      ) : (
        <ul className="space-y-3">
          {census.wards.map((ward) => (
            <li key={ward.id}>
              <Link
                href={`/ipd/ward/${ward.id}`}
                className="flex min-h-20 items-center justify-between gap-3 rounded-2xl bg-white px-5 shadow-xs ring-1 ring-ink-200 hover:ring-brand-500"
              >
                <span className="flex items-center gap-3">
                  <span className="flex size-12 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                    <BedIcon className="size-6" />
                  </span>
                  <span>
                    <span className="block text-xl font-bold text-ink-900">{ward.name}</span>
                    <span className="block text-base text-ink-600">
                      <span className="numeric">{ward.occupied}</span> patient{ward.occupied === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>
                <ChevronRightIcon className="size-6 text-ink-400" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {ownLogin ? (
        <Card>
          <CardHeader
            title={pinSet ? 'Change your ward tablet PIN' : 'Set your ward tablet PIN'}
            hint="Four digits, to unlock the shared tablet on your ward."
          />
          <form action={setOwnPinAction} className="grid grid-cols-2 gap-3 p-4">
            <Field label="New PIN">
              <Input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required autoComplete="new-password" className="numeric h-12 text-lg" />
            </Field>
            <Field label="Again">
              <Input name="confirm" type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required autoComplete="new-password" className="numeric h-12 text-lg" />
            </Field>
            <Button type="submit" size="lg" className="col-span-2">
              Save PIN
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
