import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Alert, Card, CardHeader, EmptyState } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { SERVICE_POINT_KINDS } from '@/lib/domain/test-orders';
import { myServicePoints } from '@/lib/services/test-orders';

export const metadata = { title: 'Tests' };

/**
 * Tests (IPD sheets plan C4a): the labs and rooms this person works. Someone
 * on one lab's staff goes straight to its list; the owner sees every lab and
 * the Today screen.
 */
export default async function TestsHomePage({ searchParams }: PageProps<'/tests'>) {
  const session = await requireSession();
  await requireModule(session, 'test_follow_up');
  if (!can(session.role, 'tests.work')) notFound();
  const query = await searchParams;
  const isOwner = session.role === 'owner';
  const points = await myServicePoints({ hospitalId: session.hospitalId, userId: session.userId, isOwner });
  if (!isOwner && points.length === 1 && !query.error && !query.saved) redirect(`/tests/${points[0].id}`);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Tests</h1>
        <p className="text-sm text-ink-600">Patients sent for a test, by lab or room.</p>
      </div>
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      {can(session.role, 'tests.oversee') ? (
        <Link
          href="/tests/today"
          className="flex min-h-14 items-center justify-between rounded-xl bg-brand-600 px-5 text-base font-semibold text-white shadow-xs hover:bg-brand-700"
        >
          Today: every lab, every person, pending tests <span aria-hidden>→</span>
        </Link>
      ) : null}
      <Card>
        <CardHeader title={isOwner ? 'Labs and rooms' : 'Your labs and rooms'} />
        {points.length === 0 ? (
          <EmptyState
            title={isOwner ? 'No lab or room yet' : 'You are not on any lab’s staff'}
            hint={isOwner ? 'Add them under Settings → Tests and labs.' : 'The owner adds you under Settings → Tests and labs.'}
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {points.map((p) => (
              <li key={p.id}>
                <Link href={`/tests/${p.id}`} className="flex min-h-14 items-center justify-between px-5 text-sm hover:bg-ink-50">
                  <span>
                    <strong className="text-ink-900">{p.name}</strong> <span className="text-ink-500">· {SERVICE_POINT_KINDS[p.kind]}</span>
                  </span>
                  <span aria-hidden className="text-ink-400">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
