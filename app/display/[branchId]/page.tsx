import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { requireSession } from '@/lib/auth/session';
import { formatTimeIn } from '@/lib/domain/time';
import { listBranches } from '@/lib/services/auth';
import { getBranchSnapshots } from '@/lib/services/queue';

export const metadata = { title: 'Waiting room display' };
export const dynamic = 'force-dynamic';

/**
 * The waiting-room screen.
 *
 * Token numbers only — never patient names. A room full of strangers does not
 * need to know who is being seen, and the number is all anyone is looking for.
 *
 * Signed in as staff rather than public: the TV is a hospital device, and a
 * public URL listing a branch's live queue is an unnecessary thing to expose.
 */
export default async function DisplayPage({ params }: PageProps<'/display/[branchId]'>) {
  const session = await requireSession();
  const { branchId } = await params;

  const branches = await listBranches(session.hospitalId);
  const branch = branches.find((b) => b.id === branchId);
  if (!branch) notFound();

  const now = new Date();
  const snapshots = await getBranchSnapshots({
    hospitalId: session.hospitalId,
    branchId,
    timezone: session.timezone,
    now,
  });

  return (
    <main className="min-h-dvh bg-ink-900 px-8 py-7 text-white">
      <AutoRefresh seconds={15} />

      <header className="mb-8 flex items-baseline justify-between border-b border-white/10 pb-5">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{session.hospitalName}</h1>
          <p className="mt-1 text-lg text-white/50">{branch.name}</p>
        </div>
        <p className="numeric text-3xl font-semibold text-white/70">
          {formatTimeIn(session.timezone, now)}
        </p>
      </header>

      {snapshots.length === 0 ? (
        <p className="mt-24 text-center text-3xl text-white/40">No doctors in session</p>
      ) : (
        <div
          className={
            snapshots.length <= 2
              ? 'grid gap-6 md:grid-cols-2'
              : snapshots.length <= 4
                ? 'grid gap-6 md:grid-cols-2'
                : 'grid gap-5 md:grid-cols-3'
          }
        >
          {snapshots.map((snapshot) => (
            <section
              key={snapshot.doctorId}
              className="rounded-3xl bg-white/5 p-8 ring-1 ring-white/10"
            >
              <h2 className="truncate text-2xl font-semibold text-white/80">
                {snapshot.doctorName}
              </h2>

              {snapshot.paused ? (
                <p className="mt-8 text-4xl font-bold text-amber-300">On a break</p>
              ) : snapshot.currentToken === null ? (
                // A dash at display size reads as a stray rule, not as "nothing
                // yet". Words are clearer from across a room.
                <p className="mt-8 text-4xl font-semibold text-white/40">Not started</p>
              ) : (
                <p
                  className="numeric mt-4 font-bold leading-none text-brand-300"
                  style={{ fontSize: 'clamp(4rem, 12vw, 9rem)' }}
                >
                  {snapshot.currentToken}
                </p>
              )}

              <dl className="mt-6 flex gap-8 border-t border-white/10 pt-5 text-white/60">
                <div>
                  <dt className="text-base">Waiting</dt>
                  <dd className="numeric text-3xl font-semibold text-white">
                    {snapshot.waitingCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-base">Seen today</dt>
                  <dd className="numeric text-3xl font-semibold text-white">
                    {snapshot.completedCount}
                  </dd>
                </div>
              </dl>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
