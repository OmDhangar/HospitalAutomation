import { notFound } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  cn,
} from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { supportLabel } from '@/lib/domain/entitlements';
import {
  LAPSE_GRACE_DAYS,
  SUBSCRIPTION_STATUSES,
  TRIAL_MAX_DAYS,
  TRIAL_MIN_DAYS,
  type PlanAccess,
} from '@/lib/domain/subscription';
import { getAccountDetail } from '@/lib/services/platform-accounts';
import { listAssignableTiers } from '@/lib/services/custom-plans';
import { activeRevokeReason, getPlanAccess } from '@/lib/services/subscriptions';
import { getBindingView } from '@/lib/services/whatsapp-byo';
import {
  BackLink,
  ConfirmWord,
  DefinitionRow,
  EntitlementMeter,
  StandingPill,
  TermLabel,
  UsageMeter,
  dateTime,
  rupees,
  shortDate,
} from '../../ui';
import {
  addStaffAction,
  changePlanAction,
  extendTermAction,
  renewTermAction,
  restorePlanAction,
  revokePlanAction,
  setHospitalActiveAction,
  setMembershipActiveAction,
  setSubscriptionStatusAction,
  setUserActiveAction,
  startImpersonationAction,
  startTrialAction,
  updateProfileAction,
} from './actions';
import { AccountHeader } from './components/account-header';
import { AccountKpiStrip } from './components/account-kpi-strip';
import { PlanSummaryCard } from './components/plan-summary-card';
import { PlanActionsCard } from './components/plan-actions-card';
import { EntitlementsCard } from './components/entitlements-card';
import { UsageThisPeriodCard } from './components/usage-card';
import { WhatsAppStatusCard } from './components/whatsapp-status-card';
import { LoginsTable } from './components/logins-table';

export const metadata = { title: 'Account · Platform' };

/** The capability axes a tier can withhold, in the order the rate card lists them. */
const FEATURES = [
  { key: 'hasDisplayBoard', label: 'Display board' },
  { key: 'hasOwnerReport', label: 'Owner report' },
  { key: 'hasAdvancedReports', label: 'Advanced reports' },
  { key: 'hasDataExport', label: 'Data export' },
  { key: 'hasAuditLog', label: 'Audit log' },
] as const;

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ' +
  'ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

export default async function AccountDetailPage({
  params,
  searchParams,
}: PageProps<'/admin/hospitals/[hospitalId]'>) {
  await requirePlatformAdmin();
  const { hospitalId } = await params;
  const query = await searchParams;

  const [detail, tiers, binding, access, revokeReason] = await Promise.all([
    getAccountDetail(hospitalId),
    listAssignableTiers().catch(() => []),
    getBindingView(hospitalId).catch(() => null),
    getPlanAccess(hospitalId),
    activeRevokeReason(hospitalId),
  ]);

  if (!detail) notFound();
  const { account } = detail;

  const currentTerm = detail.subscriptionHistory.find((row) => row.supersededAt === null);
  const owners = detail.users.filter(
    (user) => user.role === 'owner' && user.membershipActive && user.userActive,
  );

  return (
    <div className="space-y-5">
      <AccountHeader
        account={account}
        branches={detail.branches}
        canImpersonate={true}
      />

      <Notices query={query} />

      <AccountKpiStrip
        account={account}
        currentTerm={currentTerm}
        dailyCapacity={detail.dailyCapacity}
        whatsapp={detail.whatsapp}
        binding={binding}
      />

      {/* ---------------------------------------------------------- plan */}

      {/* ---------------------------------------------------------- subscription & capacity */}
      <div className="grid gap-5 lg:grid-cols-12 lg:items-start">
        <div className="lg:col-span-7 space-y-5">
          <PlanSummaryCard account={account} currentTerm={currentTerm} access={access} />
          <PlanActionsCard
            hospitalId={account.hospitalId}
            currentTerm={currentTerm}
            endsAtIso={account.term.endsAt?.toISOString().slice(0, 10)}
            tiers={tiers}
          />
        </div>
        <div className="lg:col-span-5">
          <EntitlementsCard
            entitlements={account.entitlements}
            features={detail.features}
          />
        </div>

        <div className="lg:col-span-7">
          <UsageThisPeriodCard
            period={detail.period}
            appointments={detail.appointments}
            messages={detail.messages}
          />
        </div>
        <div className="lg:col-span-5">
          <WhatsAppStatusCard
            hospitalId={account.hospitalId}
            binding={binding}
            number={detail.whatsapp}
          />
        </div>
      </div>

      {/* --------------------------------------------------------- users */}
      <LoginsTable hospitalId={account.hospitalId} users={detail.users} />

      {/* ------------------------------------------------- profile & risk */}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" hint="Branches, contact and commercial terms" />
          <form action={updateProfileAction} className="grid gap-3 p-5 sm:grid-cols-2">
            <input type="hidden" name="hospitalId" value={account.hospitalId} />
            <Field label="Hospital name">
              <Input name="name" defaultValue={account.name} className="py-2.5 text-sm" />
            </Field>
            <Field label="Owner WhatsApp" hint="Where the monthly summary goes">
              <Input
                name="ownerPhoneE164"
                defaultValue={account.ownerPhoneE164 ?? ''}
                placeholder="+919876543210"
                className="py-2.5 text-sm"
              />
            </Field>
            <Field label="Timezone">
              <Input name="timezone" defaultValue={account.timezone} className="py-2.5 text-sm" />
            </Field>
            <Field label="Discount %" hint="Founding-customer or negotiated rate">
              <Input
                name="discountPercent"
                type="number"
                min={0}
                max={100}
                className="py-2.5 text-sm"
              />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary">
                Save profile
              </Button>
            </div>
          </form>

          <div className="border-t border-ink-200 px-5 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Branches</p>
            <ul className="mt-1.5 space-y-1">
              {detail.branches.map((branch) => (
                <li key={branch.id} className="text-sm text-ink-700">
                  {branch.name}
                  {branch.active ? null : (
                    <span className="ml-1.5 text-xs text-ink-400">(inactive)</span>
                  )}
                  {branch.address ? (
                    <span className="ml-1.5 text-xs text-ink-400">{branch.address}</span>
                  ) : null}
                </li>
              ))}
              {detail.branches.length === 0 ? (
                <li className="text-sm text-ink-400">None</li>
              ) : null}
            </ul>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={account.active ? 'Suspend this account' : 'Reactivate this account'}
            hint="Switches the hospital itself off, separately from the subscription"
          />
          <form action={setHospitalActiveAction} className="space-y-3 p-5">
            <input type="hidden" name="hospitalId" value={account.hospitalId} />
            <input type="hidden" name="active" value={account.active ? 'false' : 'true'} />
            <Field
              label="Reason"
              hint="Goes in the hospital’s own audit log, where their owner can read it"
            >
              <Input name="reason" required placeholder="Non-payment, 60 days overdue" className="py-2.5 text-sm" />
            </Field>
            {account.active ? (
              <div className="flex items-center gap-2">
                <ConfirmWord word="SUSPEND" name="confirm" />
                <Button type="submit" variant="danger">
                  Suspend account
                </Button>
              </div>
            ) : (
              <Button type="submit" variant="primary">
                Reactivate account
              </Button>
            )}
            <p className="text-xs leading-relaxed text-ink-500">
              Suspending hides the hospital from the portfolio and from onboarding lists.
              It does not sign their staff out or stop the queue — for that, use{' '}
              <span className="font-medium">Revoke plan</span> in the Subscription card.
            </p>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Revoke or restore plan"
            hint="Locks staff out now and stops online booking. Restorable."
          />
          <div className="p-5">
            {revokeReason !== null ? (
              <form action={restorePlanAction} className="flex flex-wrap items-center justify-between gap-3">
                <input type="hidden" name="hospitalId" value={account.hospitalId} />
                <p className="text-sm text-rose-800">
                  <span className="font-semibold">Plan revoked.</span>{' '}
                  {revokeReason ? `Reason: ${revokeReason}. ` : ''}Staff are locked out and online booking is off.
                </p>
                <Button type="submit" variant="primary">
                  Restore plan
                </Button>
              </form>
            ) : (
              <form action={revokePlanAction} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="hospitalId" value={account.hospitalId} />
                <Field label="Revoke plan" hint="Locks staff out now and stops online booking. Restorable.">
                  <Input name="reason" required placeholder="Reason, e.g. unpaid" className="w-64 py-2.5 text-sm" />
                </Field>
                <div className="flex items-center gap-2 pb-0.5">
                  <ConfirmWord word="REVOKE" name="confirm" />
                  <Button type="submit" variant="danger" disabled={!currentTerm}>
                    Revoke plan
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Card>
      </div>

      {/* --------------------------------------------------- money & log */}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Payments" hint="Newest first" />
          {detail.payments.length === 0 ? (
            <EmptyState title="No payments recorded" />
          ) : (
            <ul className="divide-y divide-ink-200">
              {detail.payments.map((payment) => (
                <li key={payment.id} className="flex items-baseline justify-between gap-3 px-5 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-900">
                      <span className="capitalize">{payment.purpose.replace(/_/g, ' ')}</span>
                      <span
                        className={cn(
                          'ml-2 text-xs font-medium',
                          payment.status === 'paid'
                            ? 'text-emerald-700'
                            : payment.status === 'failed'
                              ? 'text-rose-700'
                              : 'text-ink-500',
                        )}
                      >
                        {payment.status}
                      </span>
                    </p>
                    <p className="text-xs text-ink-400">
                      {dateTime(payment.paidAt ?? payment.createdAt)}
                      {payment.failureReason ? ` · ${payment.failureReason}` : ''}
                    </p>
                  </div>
                  <span className="numeric shrink-0 text-sm font-medium text-ink-900">
                    {rupees(payment.amountPaise + payment.taxPaise)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" hint="This hospital’s audit log, including our access" />
          {detail.audit.length === 0 ? (
            <EmptyState title="Nothing logged yet" />
          ) : (
            <ul className="divide-y divide-ink-200">
              {detail.audit.map((entry) => (
                <li key={entry.id} className="px-5 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p
                      className={cn(
                        'text-sm',
                        entry.action.startsWith('support.') || entry.action.startsWith('platform.')
                          ? 'font-medium text-violet-800'
                          : 'text-ink-800',
                      )}
                    >
                      {entry.action}
                    </p>
                    <p className="shrink-0 text-xs text-ink-400">{dateTime(entry.createdAt)}</p>
                  </div>
                  <p className="text-xs text-ink-500">{entry.actorName ?? 'system'}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Subscription history" hint="Every term, newest first" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="px-5 py-2.5 font-medium">Tier</th>
                <th className="px-5 py-2.5 font-medium">Cycle</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 text-right font-medium">Price</th>
                <th className="px-5 py-2.5 font-medium">Term</th>
                <th className="px-5 py-2.5 font-medium">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200">
              {detail.subscriptionHistory.map((row) => (
                <tr key={row.id} className={cn(row.supersededAt === null && 'bg-brand-50/40')}>
                  <td className="px-5 py-2.5 capitalize text-ink-900">
                    {row.planTierCode.replace(/_/g, ' ')}
                  </td>
                  <td className="px-5 py-2.5 text-ink-600">{row.billingCycle}</td>
                  <td className="px-5 py-2.5 capitalize text-ink-600">{row.status}</td>
                  <td className="numeric px-5 py-2.5 text-right text-ink-900">
                    {rupees(row.pricePaise)}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-ink-600">
                    {shortDate(row.startsAt)} – {shortDate(row.endsAt)}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-ink-500">{row.changeReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/**
 * Outcomes, matched against a known list rather than printed.
 *
 * Same reasoning as the existing platform notices: a query string is editable
 * by whoever is looking at it, so nothing from it reaches the page as text.
 */
const DONE_MESSAGES: Record<string, string> = {
  suspended: 'Account suspended. Its staff can still sign in — set the subscription to suspended too if that was the intent.',
  activated: 'Account reactivated.',
  profile: 'Profile saved.',
  plan: 'Plan changed. A new term has been opened.',
  status: 'Subscription status set.',
  extended: 'Expiry extended on the same tier and price.',
  renewed: 'Renewed for one more term.',
  user_activated: 'Login enabled.',
  user_deactivated: 'Login disabled and every session ended.',
  access_restored: 'Access to this hospital restored.',
  access_revoked: 'Access to this hospital revoked and sessions ended.',
  staff_added:
    'Login created. Nobody can use it yet: issue a temporary password from the staff list below.',
  waba_bound: 'WhatsApp credentials sealed and stored. Point Meta at the callback URL shown below.',
  custom_plan: 'Bespoke plan created and applied. It is hidden from public pricing.',
  trial: 'Free trial started. It ends by itself; the owner then renews at the tier’s price.',
  revoked: 'Plan revoked. Staff are locked out at their next page load and online booking is off.',
  restored: 'Plan restored. Staff can use QuriioHQ again.',
};

const ERROR_MESSAGES: Record<string, string> = {
  CONFIRM: 'Type SUSPEND exactly to confirm. Nothing was changed.',
  CONFIRM_REVOKE: 'Type REVOKE exactly to confirm. Nothing was changed.',
  INVALID_TRIAL_DAYS: `A trial is ${TRIAL_MIN_DAYS} to ${TRIAL_MAX_DAYS} whole days. Nothing was changed.`,
  NOTHING_TO_REVOKE: 'This hospital has no current plan to revoke.',
  NOTHING_TO_RESTORE: 'There is no revoke to undo.',
  REASON_REQUIRED: 'A reason is required — it goes in the hospital’s audit log.',
  INVALID_INPUT: 'Something was missing or malformed. Nothing was changed.',
  UNKNOWN_TIER: 'That plan tier does not exist.',
  NO_SUBSCRIPTION: 'There is no subscription to renew. Assign a plan first.',
  LAST_OWNER: 'That is the only active owner. Add another before removing this one.',
  MEMBERSHIP_NOT_FOUND: 'That user is not a member of this hospital.',
  USER_NOT_FOUND: 'That user no longer exists.',
  HOSPITAL_NOT_FOUND: 'That hospital no longer exists.',
  PLAN_LIMIT: 'The plan’s staff-login limit is reached. Upgrade the tier first.',
  EMAIL_IN_USE:
    'That email already has a login. Each login belongs to one hospital — use a different email.',
  NOT_PLATFORM_ADMIN: 'Not permitted.',
  INVALID_PHONE_NUMBER_ID: 'That phone number ID does not look like one of Meta’s.',
  NUMBER_TAKEN: 'That phone number ID is already bound to another hospital.',
  MISSING_FIELD: 'Every WhatsApp field except the three optional ones is required.',
  NO_ENCRYPTION_KEY:
    'WHATSAPP_ENCRYPTION_KEY is not set on this server, so credentials cannot be sealed.',
};

function Notices({ query }: { query: Record<string, string | string[] | undefined> }) {
  const done = typeof query.done === 'string' ? DONE_MESSAGES[query.done] : undefined;
  const error = typeof query.error === 'string' ? ERROR_MESSAGES[query.error] : undefined;

  if (!done && !error) return null;

  return (
    <div className="space-y-2">
      {done ? <Alert tone="success">{done}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
    </div>
  );
}

/** What the plan means for the hospital's staff right now. */
function AccessNote({ access }: { access: PlanAccess }) {
  if (access.state === 'open') return null;
  if (access.state === 'grace') {
    return (
      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
        Lapsed · locks {shortDate(access.locksAt)}
      </span>
    );
  }
  return (
    <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">
      Staff locked out ({access.reason})
    </span>
  );
}
