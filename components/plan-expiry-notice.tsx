import { ExpiryBanner } from '@/components/expiry-banner';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { daysUntilExpiry, renewalNoticeBucket } from '@/lib/domain/subscription';
import { getCurrentSubscription, getPlanAccess } from '@/lib/services/subscriptions';

/**
 * The plan-renewal strip. Shown on the dashboard only — not on the IPD
 * screens, settings or anywhere a renewal is beside the point — to the owner
 * and doctors only, and only in the last 15 days (renewalNoticeBucket) or
 * once the plan has lapsed.
 *
 * Its own async component so the caller can stream it behind Suspense: the
 * subscription lookup never delays the queue.
 */
export async function PlanExpiryNotice() {
  const session = await getSession();
  if (!session || !can(session.role, 'subscription.notice')) return null;

  const now = new Date();
  const subscription = await getCurrentSubscription(session.hospitalId);
  if (!subscription) {
    // Lapsed and in its grace days: no current term, but the lock is coming.
    const access = await getPlanAccess(session.hospitalId, now);
    if (access.state !== 'grace') return null;
    return (
      <ExpiryBanner
        bucket="expired"
        daysRemaining={null}
        canRenew={can(session.role, 'hospital.configure')}
        locksAt={access.locksAt}
        timezone={session.timezone}
      />
    );
  }

  return (
    <ExpiryBanner
      bucket={renewalNoticeBucket(subscription.endsAt, now)}
      daysRemaining={daysUntilExpiry(subscription.endsAt, now)}
      canRenew={can(session.role, 'hospital.configure')}
    />
  );
}
