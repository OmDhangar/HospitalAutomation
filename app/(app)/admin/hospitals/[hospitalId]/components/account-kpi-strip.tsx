import { cn } from '@/components/ui';
import { KpiTile, TermLabel, rupees } from '../../../ui';
import type { AccountRow } from '@/lib/services/platform-accounts';

export interface AccountKpiStripProps {
  account: AccountRow;
  currentTerm?: {
    planTierCode: string;
    billingCycle: string;
    status: string;
    pricePaise: number;
    startsAt: Date;
    endsAt: Date;
  } | null;
  dailyCapacity?: number | null;
  whatsapp?: {
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    status: string;
    qualityRating: string | null;
  } | null;
  binding?: {
    phoneNumberId: string | null;
    status: string;
  } | null;
}

export function AccountKpiStrip({
  account,
  currentTerm,
  dailyCapacity,
  whatsapp,
  binding,
}: AccountKpiStripProps) {
  // 1. Plan
  const planName = account.planName ?? currentTerm?.planTierCode.replace(/_/g, ' ') ?? 'None';
  const cycle = currentTerm?.billingCycle
    ? currentTerm.billingCycle === 'annual'
      ? 'Annual'
      : 'Monthly'
    : null;
  const planValue = cycle ? `${planName} · ${cycle}` : planName;
  const planHint = currentTerm
    ? currentTerm.status.charAt(0).toUpperCase() + currentTerm.status.slice(1)
    : 'No plan';

  // 2. MRR
  const mrrValue = rupees(account.mrrPaise);
  const mrrHint = currentTerm
    ? `from ${rupees(currentTerm.pricePaise)}/${currentTerm.billingCycle === 'annual' ? 'year' : 'mo'}`
    : 'No subscription';

  // 3. Term ends
  const daysRemaining = account.term.daysRemaining;
  const termTone =
    daysRemaining !== null && daysRemaining < 0
      ? 'danger'
      : daysRemaining !== null && daysRemaining < 30
        ? 'warn'
        : 'default';
  const termValue = (
    <TermLabel
      endsAt={account.term.endsAt}
      bucket={account.term.bucket}
      daysRemaining={account.term.daysRemaining}
    />
  );

  // 4. Capacity today
  const limit = dailyCapacity ?? 0;
  const capacityValue = limit > 0 ? `0 / ${limit.toLocaleString('en-IN')}` : '—';
  const capacityProgress = limit > 0 ? { used: 0, limit } : undefined;

  // 5. WhatsApp
  const phone = whatsapp?.displayPhoneNumber ?? binding?.phoneNumberId ?? 'Not assigned';
  const waStatus = whatsapp?.status ?? binding?.status ?? null;
  const waPill = waStatus ? (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
        waStatus.toLowerCase() === 'live' ||
          waStatus.toLowerCase() === 'connected' ||
          waStatus.toLowerCase() === 'verified'
          ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
          : 'bg-amber-50 text-amber-800 ring-amber-200',
      )}
    >
      {waStatus.charAt(0).toUpperCase() + waStatus.slice(1).toLowerCase()}
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-600 ring-1 ring-inset ring-ink-200">
      Unbound
    </span>
  );

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <KpiTile
        label="PLAN"
        value={<span className="capitalize">{planValue}</span>}
        hint={planHint}
        tone="default"
      />
      <KpiTile
        label="MRR"
        value={mrrValue}
        hint={mrrHint}
        tone="brand"
      />
      <KpiTile
        label="TERM ENDS"
        value={termValue}
        tone={termTone}
      />
      <KpiTile
        label="CAPACITY TODAY"
        value={capacityValue}
        hint="today"
        tone="default"
        progress={capacityProgress}
      />
      <KpiTile
        label="WHATSAPP"
        value={phone}
        tone="default"
        pill={waPill}
      />
    </div>
  );
}
