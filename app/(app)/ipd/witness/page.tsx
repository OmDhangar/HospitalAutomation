import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { Alert, Button, Card, CardHeader, EmptyState } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { ROUTES, type Route } from '@/lib/domain/mar';
import { can } from '@/lib/domain/permissions';
import { formatTimeIn } from '@/lib/domain/time';
import { listMyWitnessRequests } from '@/lib/services/mar';
import { decideWitnessAction } from './actions';

export const metadata = { title: 'Witness · IPD' };

/**
 * Doses someone has asked me to witness (IPD sheets plan §7.2, D-WITNESS
 * (b)). Each closes after 10 minutes; check the patient, drug, dose and time
 * before approving. Approving is done here, in my own session — never by
 * typing my PIN on someone else's phone.
 */
export default async function WitnessPage({ searchParams }: PageProps<'/ipd/witness'>) {
  const session = await requireSession();
  await requireModule(session, 'mar');
  if (!can(session.role, 'ipd.witness')) notFound();
  const query = await searchParams;
  const requests = await listMyWitnessRequests({ hospitalId: session.hospitalId, userId: session.userId });
  const writable = !session.readOnly;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <AutoRefresh seconds={20} />
      <div>
        <h1 className="text-xl font-bold text-ink-900">Witness doses</h1>
        <p className="text-sm text-ink-600">A colleague gave a risk-class dose and named you as witness. Check it, then approve or decline.</p>
      </div>
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      <Card>
        <CardHeader title="Waiting for you" hint={`${requests.length}`} />
        {requests.length === 0 ? (
          <EmptyState title="Nothing to witness" hint="Requests close 10 minutes after they are sent." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {requests.map((r) => (
              <li key={r.id} className="space-y-2 px-4 py-4 sm:px-5">
                <p className="text-base font-semibold text-ink-900">
                  {r.patientName} <span className="text-sm font-normal text-ink-500">· {r.bed ?? 'IPD'}</span>
                </p>
                <p className="text-sm text-ink-800">
                  <strong>{r.description}</strong>
                  {r.dose ? ` · ${r.dose}` : ''}
                  {r.route ? ` · ${ROUTES[r.route as Route] ?? r.route}` : ''} · given {formatTimeIn(session.timezone, r.occurredAt)} by {r.actorName}
                </p>
                <p className="text-xs text-ink-500">Closes at {formatTimeIn(session.timezone, r.expiresAt)}</p>
                {writable ? (
                  <div className="flex flex-wrap gap-2">
                    <form action={decideWitnessAction}>
                      <input type="hidden" name="requestId" value={r.id} />
                      <input type="hidden" name="decision" value="approve" />
                      <Button type="submit" variant="primary" className="h-11">
                        I witnessed this dose
                      </Button>
                    </form>
                    <form action={decideWitnessAction}>
                      <input type="hidden" name="requestId" value={r.id} />
                      <input type="hidden" name="decision" value="decline" />
                      <Button type="submit" variant="secondary" className="h-11">
                        Decline
                      </Button>
                    </form>
                    <Link href={`/ipd/admissions/${r.admissionId}/treatment`} className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand-700">
                      Open the card
                    </Link>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
