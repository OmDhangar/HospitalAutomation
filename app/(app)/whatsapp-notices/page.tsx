import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { Card, Button, Stat, EmptyState } from '@/components/ui';
import { listNoticeCampaigns } from '@/lib/services/whatsapp-notices';
import { getAccountCapacity } from '@/lib/services/notice-capacity';

export const metadata = {
  title: 'WhatsApp Notices | Hospital Admin',
  description: 'Manage priority-based WhatsApp bulk notices and hospital closure announcements.',
};

export default async function WhatsAppNoticesPage() {
  const session = await requireSession();

  if (session.role !== 'owner' && session.role !== 'receptionist') {
    redirect('/dashboard');
  }

  const [campaigns, capacityResult] = await Promise.all([
    listNoticeCampaigns({
      hospitalId: session.hospitalId,
      actor: session,
    }).catch((): Awaited<ReturnType<typeof listNoticeCampaigns>> => []),
    getAccountCapacity(session.hospitalId).catch(() => null),
  ]);

  const totalSentAll = campaigns.reduce((acc: number, c) => acc + (c.sentCount || 0), 0);
  const totalDeliveredAll = campaigns.reduce((acc: number, c) => acc + (c.deliveredCount || 0), 0);

  return (
    <div className="space-y-6 max-w-6xl mx-auto py-4">
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-ink-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">WhatsApp Notices</h1>
          <p className="mt-1 text-sm text-ink-600">
            Send approved, priority-based WhatsApp announcements and emergency closure notices to active patients.
          </p>
        </div>
        <Link href="/whatsapp-notices/new">
          <Button variant="primary" size="lg" className="font-semibold shadow-sm">
            + Create Notice
          </Button>
        </Link>
      </div>

      {/* Account Capacity & Delivery Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <Stat
            label="Available WhatsApp Capacity"
            value={capacityResult?.availableCapacity ?? '—'}
            hint={
              capacityResult
                ? `Meta Tier: ${capacityResult.tierLimit} msgs/24h (Buffer: ${capacityResult.safetyBuffer})`
                : 'WhatsApp Account Capacity'
            }
            tone={
              capacityResult && capacityResult.availableCapacity < 100
                ? 'warn'
                : 'brand'
            }
          />
        </Card>

        <Card>
          <Stat
            label="Total Notices Sent"
            value={totalSentAll}
            hint={`${totalDeliveredAll} confirmed delivered to handsets`}
            tone="default"
          />
        </Card>

        <Card>
          <Stat
            label="Total Campaigns"
            value={campaigns.length}
            hint="Recorded hospital announcements"
            tone="default"
          />
        </Card>
      </div>

      {/* Notice History Table */}
      <Card className="overflow-hidden">
        <div className="p-4 border-b border-ink-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">Recent Notices</h2>
            <p className="text-xs text-ink-500">
              Audit log of created and dispatched hospital notices.
            </p>
          </div>
        </div>

        {campaigns.length === 0 ? (
          <EmptyState
            title="No WhatsApp notices created yet"
            hint="Create a hospital closure notice to notify affected and recently active patients."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-ink-50 text-ink-600 font-medium border-b border-ink-200">
                <tr>
                  <th className="py-3 px-4">Title / Type</th>
                  <th className="py-3 px-4">Affected Date</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Target</th>
                  <th className="py-3 px-4">Delivered / Failed</th>
                  <th className="py-3 px-4">Created</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 text-ink-800">
                {campaigns.map((c) => (
                  <tr key={c.id} className="hover:bg-ink-50/50">
                    <td className="py-3 px-4">
                      <p className="font-semibold text-ink-900">{c.title}</p>
                      <span className="text-[10px] text-ink-500 font-mono">
                        {c.noticeType.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-medium text-ink-700">
                      {c.closureEndDate && c.closureEndDate !== c.closureDate
                        ? `${c.closureDate} – ${c.closureEndDate}`
                        : (c.closureDate || '—')}
                      {c.closureDuration ? (
                        <span className="block text-[10px] text-ink-400">
                          {c.closureDuration}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                          c.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                            : c.status === 'processing'
                            ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200 animate-pulse'
                            : c.status === 'cancelled'
                            ? 'bg-ink-100 text-ink-600 ring-1 ring-ink-200'
                            : 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono font-medium">
                      {c.totalTargetRecipients}
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-emerald-700 font-medium">
                        {c.deliveredCount} del
                      </span>
                      {c.failedCount > 0 && (
                        <span className="ml-1 text-rose-600 font-medium">
                          / {c.failedCount} fail
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-ink-500">
                      {new Date(c.createdAt).toLocaleDateString('en-IN', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Link
                        href={`/whatsapp-notices/${c.id}`}
                        className="text-xs font-semibold text-brand-600 hover:text-brand-800"
                      >
                        View Tracker →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
