import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert, Button } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import { homePathFor } from '@/lib/domain/permissions';
import { canConfigureHospital } from '@/lib/services/auth';
import { listPayments, paymentErrorMessage, type PaymentError } from '@/lib/services/payments';
import { getPlanAccess } from '@/lib/services/subscriptions';
import { signOutAction } from '../(app)/dashboard/actions';
import { checkPaymentStatus, renewPlan } from '../(app)/subscription/actions';

export const metadata = { title: 'Plan not active · QuriioHQ' };

const PAYMENT_ERRORS: PaymentError['code'][] = [
  'NOT_CONFIGURED',
  'NO_SUBSCRIPTION',
  'NOT_PERMITTED',
  'GATEWAY_UNAVAILABLE',
  'ALREADY_PAID',
  'PLAN_REVOKED',
];

/**
 * Where a hospital's staff land once its plan is revoked, or has lapsed past
 * its grace days. Every other staff screen redirects here (requireSession).
 * During the grace days it is also where the dashboard's warning points, to
 * renew before the lock.
 *
 * Outside the `(app)` group so it renders without the app shell and cannot
 * loop. A lapsed plan's owner can renew from here; a revoked plan is reopened
 * by QuriioHQ, so there is nothing to buy.
 */
export default async function PlanInactivePage({ searchParams }: PageProps<'/plan-inactive'>) {
  const session = await requireSession({ allowInactivePlan: true });
  const params = await searchParams;
  const access = await getPlanAccess(session.hospitalId);

  // Renewed, restored, or never locked: back to work.
  if (access.state === 'open' || session.isPlatformAdmin) redirect(homePathFor(session.role));

  const lapsed = access.state === 'grace' || access.reason === 'lapsed';
  const isOwner = canConfigureHospital(session.role);
  const canRenew = isOwner && lapsed;
  const pay = typeof params.pay === 'string' ? params.pay : null;
  const openLink =
    canRenew && pay
      ? (await listPayments(session.hospitalId)).find(
          (p) => p.id === pay && p.status === 'created' && p.shortUrl,
        )
      : null;
  const errorCode =
    typeof params.error === 'string' ? PAYMENT_ERRORS.find((code) => code === params.error) : undefined;
  const day = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: session.timezone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  const ended = access.endedAt ? day(access.endedAt) : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-100 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">
            Q
          </div>
          <h1 className="text-xl font-semibold text-ink-900">
            {access.state === 'grace' ? 'Your plan has expired' : 'QuriioHQ is paused'}
          </h1>
          <p className="mt-1 text-sm text-ink-500">{session.hospitalName}</p>
        </div>

        <div className="space-y-4 rounded-xl border border-ink-200 bg-white p-6 shadow-[var(--shadow-raised)]">
          {errorCode ? <Alert tone="error">{paymentErrorMessage(errorCode)}</Alert> : null}
          {params.payment === 'pending' ? (
            <Alert tone="info">
              We have not received the payment yet. If you have paid, check again in a minute.
            </Alert>
          ) : null}

          <p className="text-sm text-ink-700">
            {access.state === 'grace'
              ? `The hospital’s plan ended on ${ended}. Everything keeps working until ${day(access.locksAt)}; after that staff are signed out of the queue, IPD and records until it is renewed.`
              : access.reason === 'lapsed'
                ? `The hospital’s plan ended${ended ? ` on ${ended}` : ''}. The queue, IPD and records open again as soon as it is renewed. Nothing has been deleted.`
                : 'QuriioHQ has stopped this hospital’s plan. Your records are safe and nothing has been deleted. Contact your QuriioHQ representative to restore it.'}
          </p>

          {canRenew ? (
            openLink ? (
              <div className="space-y-3">
                <a
                  href={openLink.shortUrl!}
                  className="flex min-h-12 w-full items-center justify-center rounded-lg bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700"
                >
                  Pay {formatRupees(openLink.totalPaise)}
                </a>
                <form action={checkPaymentStatus}>
                  <input type="hidden" name="paymentId" value={openLink.id} />
                  <input type="hidden" name="back" value="plan-inactive" />
                  <Button type="submit" variant="secondary" className="w-full justify-center">
                    I have paid — check now
                  </Button>
                </form>
              </div>
            ) : (
              <form action={renewPlan}>
                <input type="hidden" name="back" value="plan-inactive" />
                <Button type="submit" variant="primary" size="lg" className="w-full justify-center">
                  Renew plan
                </Button>
              </form>
            )
          ) : lapsed ? (
            <p className="text-sm text-ink-500">Ask the hospital owner to renew the plan.</p>
          ) : null}

          {access.state === 'grace' ? (
            <Link
              href={homePathFor(session.role)}
              className="flex min-h-11 w-full items-center justify-center rounded-lg text-sm font-semibold text-ink-700 ring-1 ring-inset ring-ink-300 hover:bg-ink-50"
            >
              Continue to work
            </Link>
          ) : (
            <form action={signOutAction}>
              <Button type="submit" variant="ghost" className="w-full justify-center">
                Sign out
              </Button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
