import Link from 'next/link';
import { Button, Card, CardHeader, EmptyState, Stat } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { serviceDateIn } from '@/lib/domain/time';
import { listBranches } from '@/lib/services/auth';
import { getHospital } from '@/lib/services/hospital';
import { getDoctorDayStats, getMonthlyUsage } from '@/lib/services/reports';

export const metadata = { title: 'Reports · OPD Queue' };

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

export default async function ReportsPage() {
  const session = await requireSession();
  const today = serviceDateIn(session.timezone);

  const [hospital, branches] = await Promise.all([
    getHospital(session.hospitalId),
    listBranches(session.hospitalId),
  ]);

  const [usage, dayStats] = await Promise.all([
    getMonthlyUsage({ hospitalId: session.hospitalId, planCode: hospital?.planTierCode }),
    getDoctorDayStats({ hospitalId: session.hospitalId, serviceDate: today }),
  ]);

  const quota = usage.bill?.includedAppointments ?? null;
  const usedPercent =
    quota && quota > 0
      ? Math.min(100, Math.round((usage.completedAppointments / quota) * 100))
      : null;

  const seenToday = dayStats.reduce((sum, row) => sum + row.completed, 0);
  const noShowsToday = dayStats.reduce((sum, row) => sum + row.noShows, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Reports</h1>
          <p className="mt-0.5 text-sm text-ink-500">{today}</p>
        </div>
        {branches[0] ? (
          <Link href={`/display/${branches[0].id}`} target="_blank">
            <Button>Open waiting-room display</Button>
          </Link>
        ) : null}
      </div>

      <Card>
        <CardHeader title="Today" hint="Across all doctors" />
        <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 sm:grid-cols-4 [&>*]:border-ink-200">
          <Stat label="Patients seen" value={seenToday} tone="brand" />
          <Stat label="No shows" value={noShowsToday} />
          <Stat
            label="Median wait"
            value={medianOf(dayStats.map((d) => d.medianWaitMinutes))}
            hint="from token to call"
          />
          <Stat
            label="Median consult"
            value={medianOf(dayStats.map((d) => d.medianConsultMinutes))}
          />
        </dl>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="By doctor" hint="Today" />
            {dayStats.length === 0 ? (
              <EmptyState title="No doctors yet" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                      <th className="px-5 py-2.5 font-medium">Doctor</th>
                      <th className="px-5 py-2.5 text-right font-medium">Seen</th>
                      <th className="px-5 py-2.5 text-right font-medium">No shows</th>
                      <th className="px-5 py-2.5 text-right font-medium">Med. wait</th>
                      <th className="px-5 py-2.5 text-right font-medium">Med. consult</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-200">
                    {dayStats.map((row) => (
                      <tr key={row.doctorId}>
                        <td className="px-5 py-3 font-medium text-ink-900">
                          {row.doctorName}
                        </td>
                        <td className="numeric px-5 py-3 text-right text-ink-700">
                          {row.completed}
                        </td>
                        <td className="numeric px-5 py-3 text-right text-ink-700">
                          {row.noShows}
                        </td>
                        <td className="numeric px-5 py-3 text-right text-ink-700">
                          {row.medianWaitMinutes === null ? '—' : `${row.medianWaitMinutes}m`}
                        </td>
                        <td className="numeric px-5 py-3 text-right text-ink-700">
                          {row.medianConsultMinutes === null
                            ? '—'
                            : `${row.medianConsultMinutes}m`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader title="This month" hint={usage.periodMonth} />
          <div className="space-y-5 p-5">
            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-600">Appointments</span>
                <span className="numeric text-sm font-semibold text-ink-900">
                  {usage.completedAppointments.toLocaleString('en-IN')}
                  {quota ? ` / ${quota.toLocaleString('en-IN')}` : ''}
                </span>
              </div>
              {usedPercent !== null ? (
                <>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-200">
                    <div
                      className={
                        usedPercent >= 100
                          ? 'h-full rounded-full bg-amber-500'
                          : 'h-full rounded-full bg-brand-600'
                      }
                      style={{ width: `${usedPercent}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink-500">
                    {usedPercent >= 100
                      ? 'Above your included volume. Nothing stops working — we will get in touch about the right plan.'
                      : `${usedPercent}% of your included appointments used.`}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs text-ink-500">No plan assigned yet.</p>
              )}
            </div>

            {usage.bill ? (
              <div className="border-t border-ink-200 pt-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-ink-600">Plan</span>
                  <span className="text-sm font-medium capitalize text-ink-900">
                    {usage.bill.planCode.replace('_', ' ')}
                  </span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between">
                  <span className="text-sm text-ink-600">Monthly</span>
                  <span className="numeric text-sm font-semibold text-ink-900">
                    {rupees(usage.bill.basePaise)}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

function medianOf(values: Array<number | null>): string {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (present.length === 0) return '—';
  const mid = Math.floor(present.length / 2);
  const value =
    present.length % 2 === 0 ? (present[mid - 1] + present[mid]) / 2 : present[mid];
  return `${Math.round(value)}m`;
}
