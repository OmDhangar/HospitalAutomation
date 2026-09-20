import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Stat,
  cn,
} from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import {
  MESSAGE_RATIO_ALERT,
  MESSAGE_RATIO_BREACH,
  MESSAGE_RATIO_BUDGET,
  type RatioStatus,
} from '@/lib/domain/pricing';
import {
  INTEGRATION_ERROR_CODES,
  integrationErrorMessage,
  type IntegrationErrorCode,
} from '@/lib/domain/whatsapp-integration';
import {
  getPortfolioHealth,
  getRecentFailures,
  resolvePaisePerMessage,
} from '@/lib/services/platform';
import {
  listAllNumbers,
  listHospitalsAwaitingNumber,
  listUnassignedNumbers,
} from '@/lib/services/whatsapp-numbers';
import { assignNumber, refreshHealth, releaseNumber } from './actions';

export const metadata = { title: 'Platform · OPD Queue' };

const rupees = (paise: number) =>
  `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const RATIO_STYLES: Record<RatioStatus, string> = {
  unknown: 'bg-ink-100 text-ink-500 ring-ink-200',
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  alert: 'bg-amber-50 text-amber-900 ring-amber-200',
  breach: 'bg-rose-50 text-rose-800 ring-rose-200',
};

export default async function AdminPage({ searchParams }: PageProps<'/admin'>) {
  const session = await requireSession();
  const params = await searchParams;

  if (!session.isPlatformAdmin) {
    return (
      <Card>
        <EmptyState
          title="Not available"
          hint="This page is for platform operators, not hospital staff."
        />
      </Card>
    );
  }

  const [portfolio, failures, numbers, rate, awaiting, inventory] = await Promise.all([
    getPortfolioHealth(),
    getRecentFailures(),
    listAllNumbers(),
    resolvePaisePerMessage(),
    listHospitalsAwaitingNumber(),
    listUnassignedNumbers(),
  ]);

  const totals = portfolio.reduce(
    (acc, row) => ({
      appointments: acc.appointments + row.completedAppointments,
      messages: acc.messages + row.messagesSent,
      revenue: acc.revenue + (row.monthlyPricePaise ?? 0),
      messagingCost: acc.messagingCost + row.messagingCostPaise,
    }),
    { appointments: 0, messages: 0, revenue: 0, messagingCost: 0 },
  );

  const portfolioRatio =
    totals.appointments > 0 ? totals.messages / totals.appointments : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">Platform</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {portfolio.length} active {portfolio.length === 1 ? 'hospital' : 'hospitals'} · this
          month
        </p>
      </div>

      <AdminNotices params={params} />

      <Card>
        <CardHeader
          title="WhatsApp onboarding"
          hint="Hospitals paying for WhatsApp that cannot yet send anything"
        />
        {awaiting.length === 0 ? (
          <EmptyState
            title="Every hospital has a number"
            hint="Nothing is waiting on onboarding."
          />
        ) : (
          <>
            <ul className="divide-y divide-ink-200">
              {awaiting.map((hospital) => (
                <li key={hospital.id} className="px-5 py-3">
                  <p className="text-sm font-medium text-ink-900">{hospital.name}</p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    No sender number assigned
                  </p>
                </li>
              ))}
            </ul>

            <form
              action={assignNumber}
              className="space-y-4 border-t border-ink-200 bg-ink-50 p-5"
            >
              <Field
                label="Hospital"
                hint="The number is verified against our WABA before it is attached."
              >
                <select
                  name="hospitalId"
                  required
                  className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900"
                >
                  <option value="">Select a hospital…</option>
                  {awaiting.map((hospital) => (
                    <option key={hospital.id} value={hospital.id}>
                      {hospital.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Phone number id"
                hint={
                  inventory.length > 0
                    ? `Unassigned inventory: ${inventory
                        .map((n) => n.displayPhoneNumber ?? n.phoneNumberId)
                        .join(', ')}`
                    : 'Meta’s numeric id for the number, from WhatsApp → API Setup.'
                }
              >
                <Input name="phoneNumberId" placeholder="123456789012345" required />
              </Field>
              <Button type="submit" variant="primary">
                Assign number
              </Button>
            </form>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Portfolio"
          hint={`Budget is ${MESSAGE_RATIO_BUDGET.toFixed(1)} messages per completed appointment`}
        />
        <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 sm:grid-cols-4 [&>*]:border-ink-200">
          <Stat label="MRR" value={rupees(totals.revenue)} tone="brand" />
          <Stat
            label="Messaging cost"
            value={rupees(totals.messagingCost)}
            hint={
              rate.source === 'invoice'
                ? `at ₹${(rate.paise / 100).toFixed(4)}/msg, from ${rate.month} invoice`
                : `estimated at ₹${(rate.paise / 100).toFixed(4)}/msg — record an invoice`
            }
          />
          <Stat label="Appointments" value={totals.appointments.toLocaleString('en-IN')} />
          <Stat
            label="Messages / appt"
            value={portfolioRatio === null ? '—' : portfolioRatio.toFixed(2)}
            tone={
              portfolioRatio !== null && portfolioRatio >= MESSAGE_RATIO_ALERT
                ? 'warn'
                : 'default'
            }
            hint={`alert at ${MESSAGE_RATIO_ALERT}, breaker at ${MESSAGE_RATIO_BREACH}`}
          />
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="By hospital"
          hint="The ratio is the margin canary — watch it before anything else"
        />
        {portfolio.length === 0 ? (
          <EmptyState title="No active hospitals" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2.5 font-medium">Hospital</th>
                  <th className="px-5 py-2.5 font-medium">Plan</th>
                  <th className="px-5 py-2.5 text-right font-medium">Appts</th>
                  <th className="px-5 py-2.5 text-right font-medium">Messages</th>
                  <th className="px-5 py-2.5 text-right font-medium">Per appt</th>
                  <th className="px-5 py-2.5 text-right font-medium">Contribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {portfolio.map((row) => {
                  const overQuota =
                    row.includedAppointments !== null &&
                    row.completedAppointments > row.includedAppointments;

                  return (
                    <tr key={row.hospitalId}>
                      <td className="px-5 py-3 font-medium text-ink-900">{row.name}</td>
                      <td className="px-5 py-3 text-ink-600">
                        <span className="capitalize">
                          {row.planCode?.replace('_', ' ') ?? '—'}
                        </span>
                        {row.recommendedTierCode &&
                        row.recommendedTierCode !== row.planCode ? (
                          <span
                            className="ml-1.5 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium capitalize text-amber-900 ring-1 ring-inset ring-amber-200"
                            title="Their volume fits a different tier"
                          >
                            → {row.recommendedTierCode.replace('_', ' ')}
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric px-5 py-3 text-right text-ink-700">
                        {row.completedAppointments.toLocaleString('en-IN')}
                        {row.includedAppointments ? (
                          <span
                            className={cn(
                              'ml-1 text-xs',
                              overQuota ? 'text-amber-700' : 'text-ink-400',
                            )}
                          >
                            /{row.includedAppointments.toLocaleString('en-IN')}
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric px-5 py-3 text-right text-ink-700">
                        {row.messagesSent.toLocaleString('en-IN')}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span
                          className={cn(
                            'numeric inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
                            RATIO_STYLES[row.status],
                          )}
                        >
                          {row.ratio === null ? '—' : row.ratio.toFixed(2)}
                        </span>
                      </td>
                      <td className="numeric px-5 py-3 text-right font-medium text-ink-900">
                        {row.contributionPaise === null
                          ? '—'
                          : rupees(row.contributionPaise)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Sender numbers"
          hint="One number per hospital, all on our WhatsApp Business Account"
        />
        {numbers.length === 0 ? (
          <EmptyState
            title="No numbers yet"
            hint="Assign one per hospital under its WhatsApp settings."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2.5 font-medium">Hospital</th>
                  <th className="px-5 py-2.5 font-medium">Patients see</th>
                  <th className="px-5 py-2.5 font-medium">Number</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Quality</th>
                  <th className="px-5 py-2.5 font-medium">Tier</th>
                  <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {numbers.map((number) => (
                  <tr key={number.id}>
                    <td className="px-5 py-3 font-medium text-ink-900">
                      {number.hospitalName ?? (
                        <span className="text-ink-400">Unassigned</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-ink-700">
                      {number.verifiedName ?? <span className="text-ink-400">—</span>}
                    </td>
                    <td className="numeric px-5 py-3 text-ink-600">
                      {number.displayPhoneNumber ?? number.phoneNumberId}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                          number.status === 'registered'
                            ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                            : number.status === 'pending'
                              ? 'bg-ink-100 text-ink-600 ring-ink-200'
                              : 'bg-rose-50 text-rose-800 ring-rose-200',
                        )}
                      >
                        {number.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'text-xs font-medium',
                          number.qualityRating === 'GREEN'
                            ? 'text-emerald-700'
                            : number.qualityRating === 'YELLOW'
                              ? 'text-amber-700'
                              : number.qualityRating === 'RED'
                                ? 'text-rose-700'
                                : 'text-ink-400',
                        )}
                      >
                        {number.qualityRating ?? '—'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500">
                      {number.messagingTier ?? '—'}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <form action={refreshHealth}>
                          <input
                            type="hidden"
                            name="phoneNumberId"
                            value={number.phoneNumberId}
                          />
                          <button
                            type="submit"
                            className="text-xs font-medium text-ink-600 underline-offset-2 hover:underline"
                            title="Ask Meta for the current quality rating and tier"
                          >
                            Refresh
                          </button>
                        </form>
                        {number.hospitalId ? (
                          <form action={releaseNumber} className="flex items-center gap-1.5">
                            <input
                              type="hidden"
                              name="phoneNumberId"
                              value={number.phoneNumberId}
                            />
                            <input
                              name="confirm"
                              placeholder="RELEASE"
                              autoComplete="off"
                              aria-label={`Type RELEASE to return ${
                                number.displayPhoneNumber ?? number.phoneNumberId
                              } to inventory`}
                              className="w-24 rounded border border-ink-300 px-1.5 py-0.5 text-xs"
                            />
                            <button
                              type="submit"
                              className="text-xs font-medium text-rose-700 underline-offset-2 hover:underline"
                            >
                              Release
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-ink-200 px-5 py-3 text-xs leading-relaxed text-ink-500">
          Quality is scored per number, but Meta&rsquo;s throughput limit applies across
          the whole business portfolio — one hospital whose patients block messages
          can slow sending for every other hospital. That shared fate is the reason
          the message budget is kept low and consent is enforced.
        </p>
      </Card>

      <Card>
        <CardHeader
          title="Delivery problems"
          hint="Failed after retries, or dropped by the circuit breaker"
        />
        {failures.length === 0 ? (
          <EmptyState title="Nothing failing" hint="Every queued message was delivered." />
        ) : (
          <ul className="divide-y divide-ink-200">
            {failures.map((failure) => (
              <li key={failure.id} className="px-5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-ink-900">{failure.hospitalName}</p>
                  <p className="text-xs text-ink-400">
                    {failure.createdAt.toLocaleString('en-IN')}
                  </p>
                </div>
                <p className="mt-0.5 text-xs text-ink-500">
                  {failure.milestone} · {failure.attempts} attempts
                </p>
                {failure.failedReason ? (
                  <p className="mt-1 text-xs text-rose-700">{failure.failedReason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Outcomes from the platform actions.
 *
 * Error codes are matched against the known list rather than printed, so a
 * crafted query string cannot render arbitrary text on an admin page.
 */
function AdminNotices({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const error = typeof params.error === 'string' ? params.error : null;
  const known = INTEGRATION_ERROR_CODES.find((code) => code === error);

  return (
    <>
      {params.assigned ? (
        <Alert tone="warn">Number assigned and verified against our WABA.</Alert>
      ) : null}
      {params.refreshed ? <Alert tone="warn">Health refreshed from Meta.</Alert> : null}
      {params.released ? (
        <Alert tone="warn">Number returned to unassigned inventory.</Alert>
      ) : null}
      {known ? (
        <Alert tone="error">
          {integrationErrorMessage(known as IntegrationErrorCode)}
        </Alert>
      ) : null}
      {error === 'CONFIRM' ? (
        <Alert tone="error">
          Type RELEASE exactly to confirm. Nothing has been changed.
        </Alert>
      ) : null}
      {error === 'PERMISSION_DENIED' && !known ? (
        <Alert tone="error">Not permitted.</Alert>
      ) : null}
    </>
  );
}
