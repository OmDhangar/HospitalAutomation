import { cn } from '@/components/ui';
import type { AuditEventGroup } from '@/lib/domain/audit';
import { ActivityCategoryIcon } from './activity-category-icon';

const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.signout': 'Signed out',
  'auth.password_reset': 'Password reset issued',
  'auth.password_change': 'Password changed',
  'session.start': 'Session started',
  'session.end': 'Session ended',
  'opd.session.start': 'OPD session started',
  'opd.session.end': 'OPD session ended',
  'billing.payment.recorded': 'Payment recorded',
  'payment.recorded': 'Payment recorded',
  'subscription.renew': 'Subscription renewed',
  'subscription.renewed': 'Subscription renewed',
  'subscription.change': 'Plan changed',
  'subscription.extended': 'Expiry extended',
  'subscription.status': 'Subscription status set',
  'subscription.trial': 'Free trial started',
  'subscription.revoked': 'Plan revoked',
  'subscription.restored': 'Plan restored',
  'platform.hospital.suspend': 'Account suspended',
  'platform.hospital.activate': 'Account reactivated',
  'platform.hospital.update': 'Profile updated',
  'support.impersonation': 'Support access started',
};

export function formatActionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const parts = action.split('.');
  const last = parts.length > 1 ? parts.slice(1).join(' ') : action;
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, ' ');
}

export function formatTime(date: Date, timezone?: string): string {
  try {
    return date.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    });
  } catch {
    return date.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
}

export function ActivityEventRow({
  group,
  timezone = 'Asia/Kolkata',
}: {
  group: AuditEventGroup;
  timezone?: string;
}) {
  const label = formatActionLabel(group.action);
  const isTimeRange =
    group.count > 1 &&
    group.firstAt.getTime() !== group.lastAt.getTime() &&
    formatTime(group.firstAt, timezone) !== formatTime(group.lastAt, timezone);

  const timeDisplay = isTimeRange
    ? `${formatTime(group.firstAt, timezone)}–${formatTime(group.lastAt, timezone)}`
    : formatTime(group.firstAt, timezone);

  return (
    <div className="flex items-start gap-3 border-b border-ink-100 px-3 py-2.5 last:border-0 hover:bg-ink-50/50">
      <div className="mt-0.5 shrink-0">
        <ActivityCategoryIcon
          category={group.category}
          destructive={group.isDestructive}
        />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span
            className={cn(
              'font-medium',
              group.isDestructive ? 'text-rose-700' : 'text-ink-900',
            )}
          >
            {label}
          </span>
          {group.count > 1 && (
            <span className="font-semibold text-brand-700"> ×{group.count}</span>
          )}{' '}
          <span className="text-ink-400">—</span>{' '}
          <span className="text-ink-600">{group.actorName ?? 'system'}</span>
        </p>

        <p className="numeric mt-0.5 text-xs text-ink-500">{timeDisplay}</p>
      </div>
    </div>
  );
}
