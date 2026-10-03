import Link from 'next/link';
import { Button, Card, EmptyState } from '@/components/ui';
import { BedIcon, PlusIcon } from '@/components/icons';
import { SectionTabs, type SectionTab } from '@/components/ipd/section-tabs';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';

/**
 * The IPD section (IPD plan §5): its own header strip under the app header —
 * a bed icon, "IPD", the hospital — and its own tabs, so staff always know
 * they are on the ward side and not the OPD queue.
 */
export default async function IpdLayout({ children }: LayoutProps<'/ipd'>) {
  const session = await requireSession();
  if (!can(session.role, 'ipd.view')) {
    return (
      <Card>
        <EmptyState title="Not available" hint="Your login does not include the IPD section." />
      </Card>
    );
  }

  const tabs: SectionTab[] = [];
  // The overview is for the OPD roles; a nurse's whole job is the ward.
  if (can(session.role, 'queue.mutate')) tabs.push({ label: 'Overview', href: '/ipd' });
  if (can(session.role, 'ipd.record')) tabs.push({ label: 'Ward', href: '/ipd/ward' });
  if (can(session.role, 'ipd.dischargeReady')) tabs.push({ label: 'My patients', href: '/ipd/my-patients' });
  if (can(session.role, 'ipd.configure')) tabs.push({ label: 'Set up', href: '/settings/ipd' });

  return (
    <div className="space-y-4">
      <div className="-mx-3.5 -mt-3.5 border-b border-brand-200 bg-brand-50/70 px-3.5 pt-2.5 sm:-mx-6 sm:px-6 lg:-mt-6 lg:pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white shadow-xs">
              <BedIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-base font-bold leading-tight text-ink-900">IPD</p>
              <p className="truncate text-xs text-ink-600">{session.hospitalName}</p>
            </div>
          </div>
          {can(session.role, 'ipd.admit') && !session.readOnly ? (
            <Link href="/ipd/new">
              <Button variant="primary" className="h-11 gap-1.5">
                <PlusIcon className="size-4" />
                <span className="hidden sm:inline">New admission</span>
                <span className="sm:hidden">Admit</span>
              </Button>
            </Link>
          ) : null}
        </div>
        {tabs.length > 1 ? (
          <div className="mt-2">
            <SectionTabs tabs={tabs} />
          </div>
        ) : (
          <div className="h-2.5" />
        )}
      </div>
      {children}
    </div>
  );
}
