import Link from 'next/link';
import { getSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getPlanAccess } from '@/lib/services/subscriptions';

/**
 * Non-blocking, role-aware streaming alert banner for the App Shell.
 *
 * Appears below the header across the application. Only hospital owners and
 * doctors receive alerts; receptionists and nurses are never disturbed during
 * daily operations.
 */
export async function PlanStatusBanner() {
  const session = await getSession();
  if (!session || session.isPlatformAdmin) return null;

  if (!can(session.role, 'subscription.notice')) return null;

  const now = new Date();
  const access = await getPlanAccess(session.hospitalId, now);

  if (access.state === 'open') return null;

  const isOwner = can(session.role, 'hospital.configure');
  const day = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: session.timezone,
      day: 'numeric',
      month: 'short',
    }).format(date);

  if (access.state === 'grace') {
    return (
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 shadow-2xs">
        <div className="mx-auto flex max-w-[1600px] flex-col sm:flex-row items-center justify-between gap-2">
          <p className="font-medium text-xs sm:text-sm">
            Hospital plan ended on {day(access.endedAt)}. Full access continues until {day(access.locksAt)}.
          </p>
          {isOwner ? (
            <Link
              href="/subscription"
              className="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700 shrink-0"
            >
              Renew Plan
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  if (access.state === 'soft_locked') {
    if (!isOwner) {
      // Quiet, non-disruptive indicator for doctors
      return (
        <div className="border-b border-ink-200 bg-ink-50 px-4 py-1.5 text-xs text-ink-600">
          <div className="mx-auto flex max-w-[1600px] items-center justify-between">
            <span>Clinical Care Active (Standard Features Mode)</span>
          </div>
        </div>
      );
    }

    return (
      <div className="border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-900 shadow-2xs">
        <div className="mx-auto flex max-w-[1600px] flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-rose-600 shrink-0" />
            <p className="font-medium text-xs sm:text-sm">
              Plan overdue. Clinical care (OPD & IPD) remains fully active. Online booking, campaigns, and exports are paused.
            </p>
          </div>
          <Link
            href="/subscription"
            className="rounded-md bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 shrink-0"
          >
            Renew Plan & Restore Services
          </Link>
        </div>
      </div>
    );
  }

  if (access.state === 'revoked') {
    if (!isOwner) {
      return (
        <div className="border-b border-ink-200 bg-ink-50 px-4 py-1.5 text-xs text-ink-600">
          <div className="mx-auto flex max-w-[1600px] items-center justify-between">
            <span>Clinical Care Safe Harbor Active</span>
          </div>
        </div>
      );
    }

    return (
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 shadow-2xs">
        <div className="mx-auto flex max-w-[1600px] flex-col sm:flex-row items-center justify-between gap-2">
          <p className="font-medium text-xs sm:text-sm">
            Hospital plan is paused by QuriioHQ. Patient care remains active. Please contact your QuriioHQ representative.
          </p>
          <Link
            href="/subscription"
            className="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700 shrink-0"
          >
            View Subscription Details
          </Link>
        </div>
      </div>
    );
  }

  return null;
}
