import Link from 'next/link';
import { Alert, Card, CardHeader, EmptyState, Input, Stat, cn } from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  DEMO_REQUEST_STATUSES,
  listDemoRequests,
  type DemoRequestStatus,
} from '@/lib/services/demo-requests';
import { dateTime } from '../ui';
import { updateLeadAction } from './actions';

export const metadata = { title: 'Leads · Platform' };

const STATUS_STYLES: Record<DemoRequestStatus, string> = {
  new: 'bg-brand-50 text-brand-800 ring-brand-200',
  contacted: 'bg-ink-100 text-ink-700 ring-ink-200',
  demoed: 'bg-violet-50 text-violet-800 ring-violet-200',
  won: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  lost: 'bg-ink-100 text-ink-400 ring-ink-200',
};

/**
 * The top of the funnel: demo requests from the marketing page.
 *
 * Every lead here ends either on the Onboard tab or at `lost`, which is why
 * the status control sits inline on each row rather than behind a detail page.
 */
export default async function LeadsPage({ searchParams }: PageProps<'/admin/leads'>) {
  await requirePlatformAdmin();
  const params = await searchParams;

  const leads = await listDemoRequests(100);

  const counts = DEMO_REQUEST_STATUSES.reduce<Record<string, number>>(
    (acc, status) => ({ ...acc, [status]: leads.filter((l) => l.status === status).length }),
    {},
  );

  return (
    <div className="space-y-5">
      {params.done ? <Alert tone="success">Lead updated.</Alert> : null}
      {params.error ? <Alert tone="error">Nothing was changed.</Alert> : null}

      <Card>
        <dl className="grid grid-cols-3 divide-x divide-y divide-ink-200 sm:grid-cols-5 [&>*]:border-ink-200">
          {DEMO_REQUEST_STATUSES.map((status) => (
            <Stat
              key={status}
              label={status}
              value={(counts[status] ?? 0).toLocaleString('en-IN')}
              tone={status === 'new' && (counts.new ?? 0) > 0 ? 'warn' : 'default'}
            />
          ))}
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="Demo requests"
          hint="Newest first, from the public pricing page"
          action={
            <Link
              href="/admin/onboard"
              className="text-xs font-medium text-ink-500 hover:text-ink-800"
            >
              Onboard a won lead →
            </Link>
          }
        />
        {leads.length === 0 ? (
          <EmptyState title="No demo requests yet" hint="The marketing form writes here." />
        ) : (
          <ul className="divide-y divide-ink-200">
            {leads.map((lead) => (
              <li key={lead.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">
                      {lead.organisation}
                      <span
                        className={cn(
                          'ml-2 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
                          STATUS_STYLES[lead.status],
                        )}
                      >
                        {lead.status}
                      </span>
                    </p>
                    <p className="mt-0.5 text-sm text-ink-600">
                      {lead.name} · {lead.phoneE164} · {lead.city}
                    </p>
                    <p className="text-xs text-ink-400">
                      {lead.patientsPerDay} patients/day · {dateTime(lead.createdAt)}
                    </p>
                    {lead.notes ? (
                      <p className="mt-1 text-xs italic text-ink-500">{lead.notes}</p>
                    ) : null}
                  </div>

                  <form action={updateLeadAction} className="flex shrink-0 items-end gap-2">
                    <input type="hidden" name="id" value={lead.id} />
                    <label className="w-44">
                      <span className="mb-1 block text-xs font-medium text-ink-600">Note</span>
                      <Input
                        name="notes"
                        defaultValue={lead.notes ?? ''}
                        placeholder="Called, wants Feb"
                        className="py-1.5 text-xs"
                      />
                    </label>
                    <label>
                      <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
                      <select
                        name="status"
                        defaultValue={lead.status}
                        className="h-[34px] rounded-lg border-0 bg-white px-2 text-xs text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none"
                      >
                        {DEMO_REQUEST_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="h-[34px] rounded-lg bg-ink-800 px-3 text-xs font-medium text-white hover:bg-ink-900"
                    >
                      Save
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
