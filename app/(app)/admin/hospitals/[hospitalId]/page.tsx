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
import { SUBSCRIPTION_STATUSES } from '@/lib/domain/subscription';
import { getAccountDetail } from '@/lib/services/platform-accounts';
import { listActiveTiers } from '@/lib/services/subscriptions';
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
  setHospitalActiveAction,
  setMembershipActiveAction,
  setSubscriptionStatusAction,
  setUserActiveAction,
  startImpersonationAction,
  updateProfileAction,
} from './actions';
import { PasswordResetForm } from './password-reset';

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

  const [detail, tiers] = await Promise.all([
    getAccountDetail(hospitalId),
    listActiveTiers().catch(() => []),
  ]);

  if (!detail) notFound();
  const { account } = detail;

  const currentTerm = detail.subscriptionHistory.find((row) => row.supersededAt === null);
  const owners = detail.users.filter(
    (user) => user.role === 'owner' && user.membershipActive && user.userActive,
  );

  return (
    <div className="space-y-5">
      <BackLink href="/admin/hospitals">All accounts</BackLink>

      <Notices query={query} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-lg font-bold text-ink-900">{account.name}</h2>
            <StandingPill standing={account.standing} />
            {account.active ? null : (
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs font-semibold text-white">
                Switched off
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-ink-500">
            {account.slug} · {account.timezone} · onboarded {shortDate(account.createdAt)}
          </p>
        </div>

        <form action={startImpersonationAction} className="flex items-end gap-2">
          <input type="hidden" name="hospitalId" value={account.hospitalId} />
          <label className="w-56">
            <span className="mb-1 block text-xs font-medium text-ink-600">
              Support access (read-only, 30 min)
            </span>
            <Input name="reason" required placeholder="Ticket or reason" className="py-2 text-sm" />
          </label>
          <Button type="submit" variant="secondary">
            View as hospital
          </Button>
        </form>
      </div>

      {/* ---------------------------------------------------------- plan */}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Subscription"
            hint={
              detail.period
                ? `Billing period ${shortDate(detail.period.start)} – ${shortDate(detail.period.end)}`
                : 'No plan assigned'
            }
          />

          {currentTerm ? (
            <dl className="divide-y divide-ink-200">
              <DefinitionRow term="Plan">
                <span className="capitalize">
                  {account.planName ?? currentTerm.planTierCode.replace(/_/g, ' ')}
                </span>
                <span className="ml-2 text-xs text-ink-500">{currentTerm.billingCycle}</span>
              </DefinitionRow>
              <DefinitionRow term="Status">
                <span className="capitalize">{currentTerm.status}</span>
              </DefinitionRow>
              <DefinitionRow term="Agreed price">
                {rupees(currentTerm.pricePaise)}
                <span className="ml-1 text-xs text-ink-500">
                  / {currentTerm.billingCycle === 'annual' ? 'year' : 'month'}
                </span>
              </DefinitionRow>
              <DefinitionRow term="Normalised MRR">{rupees(account.mrrPaise)}</DefinitionRow>
              <DefinitionRow term="Term">
                {shortDate(currentTerm.startsAt)} →{' '}
                <TermLabel
                  endsAt={account.term.endsAt}
                  bucket={account.term.bucket}
                  daysRemaining={account.term.daysRemaining}
                />
              </DefinitionRow>
              <DefinitionRow term="Daily capacity">
                {detail.dailyCapacity?.toLocaleString('en-IN') ?? '—'} patients/day
              </DefinitionRow>
            </dl>
          ) : (
            <EmptyState
              title="No subscription"
              hint="This hospital was onboarded but never put on a plan."
            />
          )}

          {/* Plan change */}
          <form
            action={changePlanAction}
            className="grid gap-3 border-t border-ink-200 bg-ink-50/50 p-4 sm:grid-cols-4"
          >
            <input type="hidden" name="hospitalId" value={account.hospitalId} />
            <Field label="Move to tier">
              <select name="tierCode" defaultValue={currentTerm?.planTierCode ?? ''} className={SELECT_CLASS}>
                {tiers.map((tier) => (
                  <option key={tier.code} value={tier.code}>
                    {tier.name} · {rupees(tier.monthlyPricePaise)}/mo
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Cycle">
              <select
                name="billingCycle"
                defaultValue={currentTerm?.billingCycle ?? 'monthly'}
                className={SELECT_CLASS}
              >
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </Field>
            <Field label="Reason" hint="Recorded on the new term">
              <Input name="reason" placeholder="upgrade / negotiated" className="py-2.5 text-sm" />
            </Field>
            <div className="flex items-end">
              <Button type="submit" variant="primary" className="w-full">
                Apply plan
              </Button>
            </div>
            <p className="text-xs text-ink-500 sm:col-span-4">
              A change takes effect immediately and opens a new term. Deferred downgrades
              are not built, so time one for a period boundary rather than mid-month.
            </p>
          </form>

          {/* Term controls */}
          <div className="grid gap-3 border-t border-ink-200 p-4 sm:grid-cols-3">
            <form action={setSubscriptionStatusAction} className="flex items-end gap-2">
              <input type="hidden" name="hospitalId" value={account.hospitalId} />
              <Field label="Set status">
                <select name="status" defaultValue={currentTerm?.status ?? 'active'} className={SELECT_CLASS}>
                  {SUBSCRIPTION_STATUSES.map((status) => (
                    <option key={status} value={status} className="capitalize">
                      {status}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" size="md">
                Set
              </Button>
            </form>

            <form action={extendTermAction} className="flex items-end gap-2">
              <input type="hidden" name="hospitalId" value={account.hospitalId} />
              <Field label="Extend expiry to" hint="Keeps tier, price and cycle">
                <Input
                  type="date"
                  name="endsAt"
                  defaultValue={account.term.endsAt?.toISOString().slice(0, 10)}
                  className="py-2.5 text-sm"
                />
              </Field>
              <Button type="submit" size="md">
                Extend
              </Button>
            </form>

            <form action={renewTermAction} className="flex items-end">
              <input type="hidden" name="hospitalId" value={account.hospitalId} />
              <Button type="submit" size="md" className="w-full" disabled={!currentTerm}>
                Renew one more term
              </Button>
            </form>
          </div>
        </Card>

        {/* ------------------------------------------------ entitlements */}

        <div className="space-y-5">
          <Card>
            <CardHeader title="What the plan allows" hint="Counted live against the agreement" />
            <div className="space-y-4 p-5">
              {account.entitlements.map((axis) => (
                <EntitlementMeter key={axis.kind} axis={axis} />
              ))}
            </div>
            {detail.features ? (
              <div className="border-t border-ink-200 px-5 py-3">
                <p className="text-xs font-medium text-ink-600">
                  {supportLabel(detail.features.supportTier)}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {FEATURES.map(({ key, label }) => (
                    <li
                      key={key}
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs',
                        detail.features![key]
                          ? 'bg-emerald-50 text-emerald-800'
                          : 'bg-ink-100 text-ink-400 line-through',
                      )}
                    >
                      {label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="Usage this period"
              hint={detail.period ? 'Against this hospital’s own term' : 'No term to measure'}
            />
            <div className="space-y-4 p-5">
              <UsageMeter label="Appointments completed" axis={detail.appointments} />
              <UsageMeter label="Messages sent" axis={detail.messages} />
              <p className="text-xs text-ink-400">
                {detail.appointments.used > 0
                  ? `${(detail.messages.used / detail.appointments.used).toFixed(2)} messages per appointment`
                  : 'No completed appointments yet this period.'}
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="WhatsApp" />
            {detail.whatsapp ? (
              <dl className="divide-y divide-ink-200">
                <DefinitionRow term="Number">
                  {detail.whatsapp.displayPhoneNumber ?? detail.whatsapp.phoneNumberId}
                </DefinitionRow>
                <DefinitionRow term="Patients see">
                  {detail.whatsapp.verifiedName ?? '—'}
                </DefinitionRow>
                <DefinitionRow term="Status">
                  <span className="capitalize">{detail.whatsapp.status}</span>
                </DefinitionRow>
                <DefinitionRow term="Quality">
                  {detail.whatsapp.qualityRating ?? '—'}
                </DefinitionRow>
              </dl>
            ) : (
              <EmptyState title="No sender number" hint="Assign one from the WhatsApp tab." />
            )}
          </Card>
        </div>
      </div>

      {/* --------------------------------------------------------- users */}

      <Card>
        <CardHeader
          title="Logins"
          hint={`${detail.users.length} staff · ${owners.length} active ${owners.length === 1 ? 'owner' : 'owners'}`}
        />
        {detail.users.length === 0 ? (
          <EmptyState title="Nobody can sign in" hint="This hospital has no staff accounts." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2.5 font-medium">Person</th>
                  <th className="px-5 py-2.5 font-medium">Role</th>
                  <th className="px-5 py-2.5 font-medium">Last sign-in</th>
                  <th className="px-5 py-2.5 font-medium">State</th>
                  <th className="px-5 py-2.5 font-medium">Password</th>
                  <th className="px-5 py-2.5 text-right font-medium">Access</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200 align-top">
                {detail.users.map((user) => {
                  const locked = !user.userActive || !user.membershipActive;

                  return (
                    <tr key={user.membershipId ?? user.userId}>
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink-900">{user.name}</p>
                        <p className="text-xs text-ink-500">{user.email}</p>
                        {user.branchName ? (
                          <p className="text-xs text-ink-400">{user.branchName}</p>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 capitalize text-ink-700">
                        {user.role ?? '—'}
                        {user.isPlatformAdmin ? (
                          <span className="ml-1.5 rounded bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-800">
                            operator
                          </span>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-xs text-ink-500">
                        {dateTime(user.lastLoginAt)}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                            locked
                              ? 'bg-rose-50 text-rose-800 ring-rose-200'
                              : 'bg-emerald-50 text-emerald-800 ring-emerald-200',
                          )}
                        >
                          {!user.userActive
                            ? 'Login disabled'
                            : !user.membershipActive
                              ? 'No access here'
                              : 'Active'}
                        </span>
                        {user.mustChangePassword ? (
                          <p className="mt-1 text-xs text-amber-700">Must change password</p>
                        ) : null}
                      </td>
                      <td className="px-5 py-3">
                        <PasswordResetForm
                          hospitalId={account.hospitalId}
                          userId={user.userId}
                          userName={user.name}
                        />
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-col items-end gap-2">
                          <form action={setMembershipActiveAction}>
                            <input type="hidden" name="hospitalId" value={account.hospitalId} />
                            <input
                              type="hidden"
                              name="membershipId"
                              value={user.membershipId ?? ''}
                            />
                            <input
                              type="hidden"
                              name="active"
                              value={user.membershipActive ? 'false' : 'true'}
                            />
                            <button
                              type="submit"
                              className="text-xs font-medium text-ink-600 underline-offset-2 hover:underline"
                            >
                              {user.membershipActive
                                ? 'Revoke access here'
                                : 'Restore access here'}
                            </button>
                          </form>
                          <form action={setUserActiveAction}>
                            <input type="hidden" name="hospitalId" value={account.hospitalId} />
                            <input type="hidden" name="userId" value={user.userId} />
                            <input
                              type="hidden"
                              name="active"
                              value={user.userActive ? 'false' : 'true'}
                            />
                            <button
                              type="submit"
                              className={cn(
                                'text-xs font-medium underline-offset-2 hover:underline',
                                user.userActive ? 'text-rose-700' : 'text-emerald-700',
                              )}
                            >
                              {user.userActive ? 'Disable login' : 'Enable login'}
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <form
          action={addStaffAction}
          className="grid gap-3 border-t border-ink-200 bg-ink-50/50 p-4 sm:grid-cols-4"
        >
          <input type="hidden" name="hospitalId" value={account.hospitalId} />
          <Field label="Name">
            <Input name="name" required placeholder="Dr. Anjali Patil" className="py-2.5 text-sm" />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" required placeholder="anjali@hospital.in" className="py-2.5 text-sm" />
          </Field>
          <Field label="Role">
            <select name="role" defaultValue="receptionist" className={SELECT_CLASS}>
              <option value="owner">Owner</option>
              <option value="receptionist">Receptionist</option>
              <option value="doctor">Doctor</option>
            </select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" className="w-full">
              Add login
            </Button>
          </div>
          <p className="text-xs text-ink-500 sm:col-span-4">
            Starts on the default password until reset. Counts against the plan&rsquo;s staff
            limit, which is checked here exactly as it is for the hospital itself.
          </p>
        </form>
      </Card>

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
              It does not sign their staff out or stop the queue — for that, set the
              subscription to <span className="font-medium">suspended</span> as well.
            </p>
          </form>
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
  staff_added: 'Login created on the default password — reset it before handing it over.',
};

const ERROR_MESSAGES: Record<string, string> = {
  CONFIRM: 'Type SUSPEND exactly to confirm. Nothing was changed.',
  REASON_REQUIRED: 'A reason is required — it goes in the hospital’s audit log.',
  INVALID_INPUT: 'Something was missing or malformed. Nothing was changed.',
  UNKNOWN_TIER: 'That plan tier does not exist.',
  NO_SUBSCRIPTION: 'There is no subscription to renew. Assign a plan first.',
  LAST_OWNER: 'That is the only active owner. Add another before removing this one.',
  MEMBERSHIP_NOT_FOUND: 'That user is not a member of this hospital.',
  USER_NOT_FOUND: 'That user no longer exists.',
  HOSPITAL_NOT_FOUND: 'That hospital no longer exists.',
  PLAN_LIMIT: 'The plan’s staff-login limit is reached. Upgrade the tier first.',
  NOT_PLATFORM_ADMIN: 'Not permitted.',
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
