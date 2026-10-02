import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { Card, EmptyState } from '@/components/ui';
import { BedGrid } from '@/components/ipd/bed-grid';
import { RememberWard } from '@/components/ipd/last-ward';
import { OutboxStatus } from '@/components/ipd/outbox-status';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getIpdCensus } from '@/lib/services/ipd-census';

export const metadata = { title: 'Ward grid · IPD' };

/**
 * The ward grid on a phone (IPD plan §5.6): big tiles, two or three to a row,
 * occupied beds highlighted. Tapping a bed is how the nurse says which
 * patient (D-ID); the record screen then shows the name large to confirm.
 */
export default async function WardGridPage({ params }: PageProps<'/ipd/ward/[wardId]'>) {
  const session = await requireSession();
  const { wardId } = await params;
  if (!can(session.role, 'ipd.record')) notFound();

  const census = await getIpdCensus({ hospitalId: session.hospitalId, branchId: session.branchId });
  const ward = census.wards.find((w) => w.id === wardId);
  if (!ward) notFound();
  const now = new Date();

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <RememberWard wardId={ward.id} />
      <AutoRefresh seconds={20} />
      <OutboxStatus />

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink-900">{ward.name}</h1>
        {census.wards.length > 1 ? (
          <Link href="/ipd/ward?pick=1" className="inline-flex min-h-12 items-center rounded-lg px-3 font-semibold text-brand-700 hover:bg-brand-50">
            Change ward
          </Link>
        ) : null}
      </div>
      <p className="text-base text-ink-600">
        Tap a patient’s bed to record. <span className="numeric font-semibold text-ink-900">{ward.occupied}</span> of{' '}
        <span className="numeric">{ward.beds.length}</span> beds occupied.
      </p>

      {ward.beds.length === 0 ? (
        <Card>
          <EmptyState title="No beds in this ward yet." />
        </Card>
      ) : (
        <BedGrid
          label={`Beds in ${ward.name}`}
          beds={ward.beds}
          timezone={session.timezone}
          now={now}
          size="lg"
          hrefFor={(bed) => `/ipd/ward/${ward.id}/bed/${bed.id}`}
        />
      )}
    </div>
  );
}
