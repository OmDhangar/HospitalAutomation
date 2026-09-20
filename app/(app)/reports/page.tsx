import Link from 'next/link';
import {
  CHART_COLORS,
  HourlyLoad,
  Legend,
  TrendStat,
  VolumeTrend,
} from '@/components/charts';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { serviceDateIn } from '@/lib/domain/time';
import { listBranches } from '@/lib/services/auth';
import { getHospital } from '@/lib/services/hospital';
import {
  getDailyTrend,
  getDoctorDayStats,
  getHourlyLoad,
  getMonthlyUsage,
} from '@/lib/services/reports';

export const metadata = { title: 'Reports · OPD Queue' };

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

const WINDOW_DAYS = 30;

export default async function ReportsPage() {
  const session = await requireSession();
  const today = serviceDateIn(session.timezone);

  const [hospital, branches] = await Promise.all([
    getHospital(session.hospitalId),
    listBranches(session.hospitalId),
  ]);

  const [usage, dayStats, trend, hourly] = await Promise.all([
    getMonthlyUsage({ hospitalId: session.hospitalId, planCode: hospital?.planTierCode }),
    getDoctorDayStats({ hospitalId: session.hospitalId, serviceDate: today }),
    getDailyTrend({ hospitalId: session.hospitalId, endDate: today, days: WINDOW_DAYS }),
    getHourlyLoad({
      hospitalId: session.hospitalId,
      timezone: session.timezone,
      endDate: today,
      days: WINDOW_DAYS,
    }),
  ]);

  /**
   * Split the window in half and compare. This is what turns a number into a
   * report: "312 patients" is a fact, "312 patients, up 9%" is something an
   * owner can act on.
   */
  const half = Math.floor(trend.length / 2);
  const recent = trend.slice(half);
  const earlier = trend.slice(0, half);

  const sum = (rows: typeof trend, key: 'completed' | 'noShows') =>
    rows.reduce((total, row) => total + row[key], 0);

  const medianOfWaits = (rows: typeof trend): number | null => {
    const present = rows
      .map((row) => row.medianWaitMinutes)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    if (present.length === 0) return null;
    const mid = Math.floor(present.length / 2);
    return present.length % 2 === 0
      ? Math.round((present[mid - 1] + present[mid]) / 2)
      : present[mid];
  };

  const seenRecent = sum(recent, 'completed');
  const noShowsRecent = sum(recent, 'noShows');
  const attended = seenRecent + noShowsRecent;

  const noShowRate = attended > 0 ? Math.round((noShowsRecent / attended) * 100) : null;
  const earlierAttended = sum(earlier, 'completed') + sum(earlier, 'noShows');
  const noShowRatePrev =
    earlierAttended > 0 ? Math.round((sum(earlier, 'noShows') / earlierAttended) * 100) : null;

  const quota = usage.bill?.includedAppointments ?? null;
  const usedPercent =
    quota && quota > 0
      ? Math.min(100, Math.round((usage.completedAppointments / quota) * 100))
      : null;

  const hasHistory = trend.some((point) => point.completed + point.noShows > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Reports</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Last {WINDOW_DAYS} days · to {today}
          </p>
        </div>
        {branches[0] ? (
          <Link href={`/display/${branches[0].id}`} target="_blank">
            <Button>Open waiting-room display</Button>
          </Link>
        ) : null}
      </div>

      {!hasHistory ? (
        <Card>
          <EmptyState
            title="No consultations recorded yet"
            hint="Trends appear here once patients start moving through the queue."
          />
        </Card>
      ) : (
        <>
          {/* Each figure carries its own comparison, so no number is orphaned. */}
          <Card>
            <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 lg:grid-cols-4 [&>*]:border-ink-200">
              <TrendStat
                label="Patients seen"
                value={seenRecent}
                previous={sum(earlier, 'completed')}
              />
              <TrendStat
                label="No-show rate"
                value={noShowRate}
                previous={noShowRatePrev}
                suffix="%"
                higherIsBetter={false}
              />
              <TrendStat
                label="Median wait"
                value={medianOfWaits(recent)}
                previous={medianOfWaits(earlier)}
                suffix="m"
                higherIsBetter={false}
              />
              <TrendStat
                label="Busiest day"
                value={Math.max(...trend.map((point) => point.completed))}
                previous={null}
                hint="Most patients seen in one day"
              />
            </dl>
          </Card>

          <div className="grid items-start gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <Card>
                <CardHeader
                  title="Daily volume"
                  hint={`${WINDOW_DAYS} days`}
                  action={
                    <Legend
                      items={[
                        { color: CHART_COLORS.primary, label: 'Seen' },
                        { color: CHART_COLORS.negative, label: 'No-show' },
                      ]}
                    />
                  }
                />
                <div className="p-5">
                  <VolumeTrend data={trend} />
                </div>
              </Card>
            </div>

            <Card>
              <CardHeader title="When patients arrive" hint="Across the period" />
              <div className="p-5">
                <HourlyLoad data={hourly} />
              </div>
            </Card>
          </div>
        </>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-3">
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
                    {dayStats.map((row) => {
                      const seen = row.completed;
                      const busiest = Math.max(...dayStats.map((d) => d.completed), 1);
                      return (
                        <tr key={row.doctorId}>
                          <td className="px-5 py-3 font-medium text-ink-900">
                            {row.doctorName}
                          </td>
                          <td className="px-5 py-3 text-right">
                            {/* An inline bar turns a column of numbers into a
                                comparison the eye makes without arithmetic. */}
                            <div className="flex items-center justify-end gap-2">
                              <span
                                className="h-1.5 rounded-full bg-brand-600/70"
                                style={{ width: `${(seen / busiest) * 48}px` }}
                              />
                              <span className="numeric w-6 text-ink-900">{seen}</span>
                            </div>
                          </td>
                          <td
                            className={cn(
                              'numeric px-5 py-3 text-right',
                              row.noShows > 0 ? 'text-rose-700' : 'text-ink-400',
                            )}
                          >
                            {row.noShows}
                          </td>
                          <td className="numeric px-5 py-3 text-right text-ink-700">
                            {row.medianWaitMinutes === null
                              ? '—'
                              : `${row.medianWaitMinutes}m`}
                          </td>
                          <td className="numeric px-5 py-3 text-right text-ink-700">
                            {row.medianConsultMinutes === null
                              ? '—'
                              : `${row.medianConsultMinutes}m`}
                          </td>
                        </tr>
                      );
                    })}
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
