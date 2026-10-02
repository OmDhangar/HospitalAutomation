import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, EmptyState } from '@/components/ui';
import { BedIcon, ChevronRightIcon } from '@/components/icons';
import { GoToLastWard } from '@/components/ipd/last-ward';
import { OutboxStatus } from '@/components/ipd/outbox-status';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getIpdCensus } from '@/lib/services/ipd-census';

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
  if (census.wards.length === 1 && !choosing) redirect(`/ipd/ward/${census.wards[0].id}`);

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {!choosing ? <GoToLastWard wardIds={census.wards.map((ward) => ward.id)} /> : null}
      <OutboxStatus />
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
    </div>
  );
}
