import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { TVControls } from '@/components/display/tv-controls';
import { requireSession } from '@/lib/auth/session';
import { formatTimeIn } from '@/lib/domain/time';
import { listBranches } from '@/lib/services/auth';
import { getBranchSnapshots } from '@/lib/services/queue';

export const metadata = { title: 'Waiting room display · Qurio' };
export const dynamic = 'force-dynamic';

/**
 * The waiting-room screen.
 *
 * Designed specifically for large 1080p, 2K and 4K television screens in hospital
 * waiting corridors. Token numbers only — never patient names for patient privacy.
 *
 * Optimized with generous overscan-safe margins, large clickable TV controls
 * (Fullscreen, Audio Chime, Refresh, Zoom), and high-contrast typography readable
 * from 20+ feet away.
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

  const currentTokens = snapshots.map((s) => ({
    doctorId: s.doctorId,
    doctorName: s.doctorName,
    token: s.currentToken,
  }));

  return (
    <main className="min-h-screen bg-ink-950 text-white px-6 sm:px-10 md:px-14 lg:px-20 2xl:px-28 py-6 sm:py-8 lg:py-10 2xl:py-14 tv-safe-area flex flex-col justify-between selection:bg-brand-500 selection:text-white">
      <AutoRefresh seconds={10} />

      <div>
        {/* TV Header with Safe Margins & Interactive Controls */}
        <header className="mb-8 lg:mb-12 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/15 pb-6">
          <div className="flex items-center gap-4">
            <span className="flex size-12 sm:size-14 shrink-0 items-center justify-center rounded-2xl bg-brand-600 font-extrabold text-xl sm:text-2xl text-white shadow-lg ring-1 ring-brand-400/40">
              Q
            </span>
            <div>
              <h1 className="text-2xl sm:text-4xl lg:text-5xl font-black tracking-tight text-white">
                {session.hospitalName}
              </h1>
              <div className="mt-1 flex items-center gap-3">
                <span className="text-sm sm:text-lg font-medium text-white/60">{branch.name}</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-400/30">
                  <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live OPD Queue
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 sm:gap-6 self-end sm:self-auto">
            <div className="text-right">
              <p className="numeric text-2xl sm:text-4xl font-bold tracking-tight text-white/90">
                {formatTimeIn(session.timezone, now)}
              </p>
              <p className="text-xs sm:text-sm font-medium text-white/50">
                {now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </p>
            </div>

            {/* Interactive TV Controls with Large Click Targets & Shortcuts */}
            <TVControls currentTokens={currentTokens} />
          </div>
        </header>

        {/* Doctor Snapshots Grid */}
        {snapshots.length === 0 ? (
          <div className="my-24 sm:my-36 flex flex-col items-center justify-center text-center">
            <div className="size-20 rounded-full bg-white/5 ring-1 ring-white/10 flex items-center justify-center text-3xl mb-4">
              🩺
            </div>
            <p className="text-3xl sm:text-4xl font-bold text-white/60">No doctors currently in session</p>
            <p className="mt-2 text-base sm:text-lg text-white/40">
              Tokens will appear automatically here once reception or doctors start calling patients.
            </p>
          </div>
        ) : (
          <div
            className={
              snapshots.length === 1
                ? 'max-w-4xl mx-auto'
                : snapshots.length === 2
                  ? 'grid gap-6 lg:gap-8 md:grid-cols-2'
                  : snapshots.length <= 4
                    ? 'grid gap-6 lg:gap-8 md:grid-cols-2 xl:grid-cols-2'
                    : 'grid gap-6 lg:gap-8 md:grid-cols-2 lg:grid-cols-3'
            }
          >
            {snapshots.map((snapshot) => {
              const isServing = snapshot.currentToken !== null && !snapshot.paused;

              return (
                <section
                  key={snapshot.doctorId}
                  className={`relative overflow-hidden rounded-3xl bg-white/[0.06] p-6 sm:p-8 lg:p-10 ring-1 backdrop-blur-sm transition-all duration-200 ${
                    isServing
                      ? 'ring-brand-500/50 bg-gradient-to-br from-white/[0.08] to-brand-950/30 tv-glow-active'
                      : snapshot.paused
                        ? 'ring-amber-500/40 bg-amber-950/20'
                        : 'ring-white/15'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <span className="text-xs sm:text-sm font-bold uppercase tracking-wider text-brand-300/80">
                        Consulting Room
                      </span>
                      <h2 className="truncate text-2xl sm:text-3xl lg:text-4xl font-bold text-white mt-0.5">
                        {snapshot.doctorName}
                      </h2>
                    </div>

                    {isServing ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-500/20 px-3 py-1 text-xs sm:text-sm font-bold text-brand-300 ring-1 ring-brand-400/40 animate-pulse">
                        ● NOW SERVING
                      </span>
                    ) : snapshot.paused ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-xs sm:text-sm font-bold text-amber-300 ring-1 ring-amber-400/40">
                        ON BREAK
                      </span>
                    ) : (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs sm:text-sm font-medium text-white/60 ring-1 ring-white/10">
                        READY
                      </span>
                    )}
                  </div>

                  {/* Token Number Display */}
                  <div className="my-6 sm:my-8 text-center py-4 sm:py-6 rounded-2xl bg-black/30 ring-1 ring-white/10">
                    <p className="text-xs sm:text-sm font-bold uppercase tracking-widest text-white/50 mb-1">
                      Current Token Number
                    </p>
                    {snapshot.paused ? (
                      <p className="text-3xl sm:text-5xl lg:text-6xl font-black text-amber-300 py-2">
                        On a Break
                      </p>
                    ) : snapshot.currentToken === null ? (
                      <p className="text-3xl sm:text-5xl lg:text-6xl font-bold text-white/30 py-2">
                        Not Started
                      </p>
                    ) : (
                      <div className="flex items-baseline justify-center gap-2">
                        <span className="text-2xl sm:text-4xl lg:text-5xl font-bold text-brand-400">#</span>
                        <p
                          className="numeric font-black leading-none text-white tracking-tight drop-shadow-[0_4px_24px_rgba(45,212,191,0.4)]"
                          style={{ fontSize: 'clamp(4.5rem, 11vw, 9.5rem)' }}
                        >
                          {snapshot.currentToken}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Queue Metrics Footer */}
                  <dl className="grid grid-cols-2 gap-4 border-t border-white/15 pt-5 text-white/70">
                    <div className="rounded-xl bg-white/5 px-4 py-3 ring-1 ring-white/10">
                      <dt className="text-xs sm:text-sm font-medium text-white/60">Patients Waiting</dt>
                      <dd className="numeric text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white mt-1">
                        {snapshot.waitingCount}
                      </dd>
                    </div>
                    <div className="rounded-xl bg-white/5 px-4 py-3 ring-1 ring-white/10">
                      <dt className="text-xs sm:text-sm font-medium text-white/60">Seen Today</dt>
                      <dd className="numeric text-2xl sm:text-3xl lg:text-4xl font-extrabold text-emerald-400 mt-1">
                        {snapshot.completedCount}
                      </dd>
                    </div>
                  </dl>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* Television Footer Notice */}
      <footer className="mt-12 pt-6 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between text-xs sm:text-sm text-white/40 gap-3">
        <p>
          Patients: Watch your phone for WhatsApp notification when 2 patients remain ahead.
        </p>
        <p className="numeric">
          Press <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-white/80 font-mono text-xs">F</kbd> for Fullscreen • <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-white/80 font-mono text-xs">S</kbd> for Sound Chime
        </p>
      </footer>
    </main>
  );
}

