import { Card, EmptyState } from '@/components/ui';
import { type SectionTab } from '@/components/ipd/section-tabs';
import { IpdHubHeader } from '@/components/ipd/shell/ipd-hub-header';
import { getModuleStatesForRequest } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { moduleAllows } from '@/lib/modules/registry';

/**
 * The IPD section: streamlined ultra-compact header strip (h-10) for hub views,
 * auto-bypassed when rendering patient charts or bedside screens to maximize screen real estate.
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
  // Risk-class stock (plan B4a), once the owner has switched it on.
  if (can(session.role, 'stock.view') && moduleAllows(await getModuleStatesForRequest(session.hospitalId), 'stock', 'read')) {
    tabs.push({ label: 'Stock', href: '/ipd/stock' });
  }
  if (can(session.role, 'ipd.dueQuality') && moduleAllows(await getModuleStatesForRequest(session.hospitalId), 'mar', 'read')) {
    tabs.push({ label: 'Dose timing', href: '/ipd/quality' });
  }
  // Deposit alerts (B2), for the desk.
  if (can(session.role, 'ipd.depositAlerts') && moduleAllows(await getModuleStatesForRequest(session.hospitalId), 'deposit_alert', 'read')) {
    tabs.push({ label: 'Deposits', href: '/ipd/deposits' });
  }
  if (can(session.role, 'ipd.configure')) tabs.push({ label: 'Set up', href: '/settings/ipd' });

  return (
    <div className="space-y-3">
      <IpdHubHeader
        tabs={tabs}
        canAdmit={can(session.role, 'ipd.admit') && !session.readOnly}
      />
      {children}
    </div>
  );
}
