import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, cn } from '@/components/ui';
import { CheckIcon } from '@/components/icons';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import { depositAlertSettingsFrom } from '@/lib/domain/discharge-bill';
import { can } from '@/lib/domain/permissions';
import { listDepositAlerts } from '@/lib/services/deposit-alerts';
import { saveDepositAlertSettingsAction } from './actions';

export const metadata = { title: 'Deposits · IPD' };

/**
 * Deposit alerts (IPD sheets plan B2, D-DEP): patients in a bed whose charges
 * have used up most of their deposit, or who owe more than the limit — for
 * the desk to ask for more before the bill grows. Read on demand.
 */
export default async function DepositsPage({ searchParams }: PageProps<'/ipd/deposits'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'deposit_alert');
  if (!can(session.role, 'ipd.depositAlerts')) notFound();
  const query = await searchParams;
  const settings = depositAlertSettingsFrom(states.get('deposit_alert')?.settings);
  const alerts = await listDepositAlerts({ hospitalId: session.hospitalId, branchId: session.branchId, settings });
  const canSet = can(session.role, 'ipd.configure') && !session.readOnly;

  return (
    <div className="space-y-4">
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      <div>
        <h1 className="text-xl font-bold text-ink-900">Deposit alerts</h1>
        <p className="text-sm text-ink-600">
          Patients in a bed whose charges have used {settings.usedPct}% or more of what they paid, or who owe more than{' '}
          {formatRupees(settings.balancePaise)}.
        </p>
      </div>
      <Card>
        <CardHeader title="Ask for more deposit" hint={`${alerts.length} patient${alerts.length === 1 ? '' : 's'}`} />
        {alerts.length === 0 ? (
          <p className="flex items-center gap-2 px-4 pb-4 text-sm text-emerald-800 sm:px-5">
            <CheckIcon className="size-4" />
            Every patient’s deposit covers their charges.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {alerts.map((a) => (
              <li key={a.admissionId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm sm:px-5">
                <span className="min-w-0">
                  <Link href={`/ipd/admissions/${a.admissionId}`} className="font-semibold text-ink-900 hover:underline">
                    {a.patientName}
                  </Link>
                  <span className="text-ink-500"> · {a.bed ?? 'IPD'}</span>
                  <span className="block text-ink-700">
                    Charges {formatRupees(a.totalPaise)} · paid {formatRupees(a.paidPaise)}
                    {a.usedPct !== null ? ` · ${a.usedPct}% used` : ' · no deposit'}
                  </span>
                </span>
                <span className={cn('rounded-full px-2.5 py-1 text-xs font-bold', a.reason === 'owed' ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-900')}>
                  {a.balancePaise > 0 ? `Owes ${formatRupees(a.balancePaise)}` : `${formatRupees(-a.balancePaise)} left`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {canSet ? (
        <Card>
          <CardHeader title="When to alert" hint="D-DEP: 80% and ₹5,000 to start" />
          <form action={saveDepositAlertSettingsAction} className="flex flex-wrap items-end gap-3 px-4 pb-4 sm:px-5">
            <label className="block text-sm font-medium text-ink-700">
              Deposit used (%)
              <input name="usedPct" type="number" min={50} max={100} defaultValue={settings.usedPct} className="mt-1 block h-11 w-28 rounded-lg border-0 px-3 text-sm ring-1 ring-inset ring-ink-300" />
            </label>
            <label className="block text-sm font-medium text-ink-700">
              Or owed more than (₹)
              <input name="balanceRupees" inputMode="numeric" defaultValue={settings.balancePaise / 100} className="mt-1 block h-11 w-36 rounded-lg border-0 px-3 text-sm ring-1 ring-inset ring-ink-300" />
            </label>
            <Button type="submit" variant="secondary" className="h-11">
              Save
            </Button>
          </form>
        </Card>
      ) : (
        <p className="text-xs text-ink-500">The owner sets when this alert comes up.</p>
      )}
    </div>
  );
}
