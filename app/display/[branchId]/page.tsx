import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { requireSession } from '@/lib/auth/session';
import { formatTimeIn } from '@/lib/domain/time';
import { isLocale, t, type Locale } from '@/lib/i18n/patient';
import { listBranches } from '@/lib/services/auth';
import { getBranchSnapshots } from '@/lib/services/queue';
import { DisplayAudioNotifier } from './display-audio';

export const metadata = { title: 'Waiting Room Display · Live OPD' };
export const dynamic = 'force-dynamic';

/**
 * The waiting-room TV display.
 *
 * Designed for 10-foot viewing distance on clinic monitors and wall-mounted TVs:
 * - High-contrast vibrant tokens and status cards
 * - Shows current patient name + token
 * - Shows next waiting patient for preparedness
 * - Instant language toggle (English / मराठी)
 * - Automatic chime announcement when new tokens are called
 */
export default async function DisplayPage({
  params,
  searchParams,
}: PageProps<'/display/[branchId]'>) {
  const session = await requireSession();
  const { branchId } = await params;
  const query = await searchParams;

  const branches = await listBranches(session.hospitalId);
  const branch = branches.find((b) => b.id === branchId);
  if (!branch) notFound();

  const locale: Locale = isLocale(query?.lang) ? query.lang : 'mr';
  const s = t[locale];

  const now = new Date();
  const snapshots = await getBranchSnapshots({
    hospitalId: session.hospitalId,
    branchId,
    timezone: session.timezone,
    now,
  });

  const servingState = snapshots.map((snap) => ({
    doctorId: snap.doctorId,
    doctorName: snap.doctorName,
    tokenNumber: snap.currentToken ?? null,
    patientName: snap.currentPatientName ?? null,
    status: snap.currentToken ? 'CALLED' : null,
  }));

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-6 sm:px-10 sm:py-8 text-white flex flex-col justify-between selection:bg-emerald-500 selection:text-white">
      <AutoRefresh seconds={10} />

      {/* Top Navigation / Hospital Branding Bar */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div className="flex items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 font-black text-white text-xl shadow-lg shadow-emerald-950/50 ring-1 ring-white/20">
            +
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white flex items-center gap-3">
              {session.hospitalName}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-bold text-emerald-400 ring-1 ring-inset ring-emerald-500/30">
                <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
                LIVE
              </span>
            </h1>
            <p className="mt-0.5 text-sm sm:text-base font-medium text-slate-400">
              {branch.name} · {s.displayTitle}
            </p>
          </div>
        </div>

        {/* Right Header: Audio Alert Toggle, Language Toggle, & Clock */}
        <div className="flex flex-wrap items-center gap-3 sm:gap-5">
          <DisplayAudioNotifier servingState={servingState} />

          <div className="flex items-center rounded-xl bg-white/5 p-1 ring-1 ring-white/10">
            <Link
              href={`/display/${branchId}?lang=en`}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                locale === 'en'
                  ? 'bg-emerald-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              English
            </Link>
            <Link
              href={`/display/${branchId}?lang=mr`}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                locale === 'mr'
                  ? 'bg-emerald-500 text-slate-950 shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              मराठी
            </Link>
          </div>

          <div className="text-right">
            <p className="numeric text-2xl sm:text-3xl font-black tracking-wider text-emerald-400">
              {formatTimeIn(session.timezone, now)}
            </p>
          </div>
        </div>
      </header>

      {/* Main Doctor Queue Grid */}
      {snapshots.length === 0 ? (
        <div className="my-auto flex flex-col items-center justify-center py-24 text-center">
          <div className="size-20 rounded-3xl bg-white/5 flex items-center justify-center text-3xl mb-4 ring-1 ring-white/10">
            🩺
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-slate-400">{s.displayNoDoctors}</p>
        </div>
      ) : (
        <div
          className={
            snapshots.length === 1
              ? 'grid gap-6 max-w-4xl mx-auto w-full'
              : snapshots.length === 2
                ? 'grid gap-6 md:grid-cols-2'
                : snapshots.length <= 4
                  ? 'grid gap-6 md:grid-cols-2 lg:grid-cols-2'
                  : 'grid gap-5 md:grid-cols-3'
          }
        >
          {snapshots.map((snapshot) => (
            <section
              key={snapshot.doctorId}
              className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-slate-900/90 to-slate-900/60 p-6 sm:p-8 ring-1 ring-white/15 shadow-2xl backdrop-blur-xl flex flex-col justify-between"
            >
              {/* Doctor Header Banner */}
              <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
                <div className="min-w-0">
                  <span className="text-xs font-bold tracking-wider text-emerald-400 uppercase">
                    {s.doctor}
                  </span>
                  <h2 className="truncate text-xl sm:text-2xl font-bold text-white mt-0.5">
                    {snapshot.doctorName}
                  </h2>
                </div>

                {snapshot.paused ? (
                  <span className="rounded-xl bg-amber-400/20 px-3 py-1 text-xs font-bold text-amber-300 ring-1 ring-amber-400/30">
                    ⏸ {s.displayOnBreak}
                  </span>
                ) : snapshot.currentToken !== null ? (
                  <span className="rounded-xl bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300 ring-1 ring-emerald-400/30 flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-400 animate-ping" />
                    {s.nowServing}
                  </span>
                ) : null}
              </div>

              {/* Central Token & Patient Display */}
              <div className="py-6 sm:py-8 text-center">
                {snapshot.paused ? (
                  <div className="py-4">
                    <p className="text-3xl sm:text-4xl font-black text-amber-300">
                      {s.displayOnBreak}
                    </p>
                    {snapshot.breakStartedAt ? (
                      <p className="mt-2 text-base font-semibold text-amber-200/80">
                        {s.pausedSince} {formatTimeIn(session.timezone, snapshot.breakStartedAt)}
                      </p>
                    ) : null}
                    {snapshot.pausedReason ? (
                      <p className="mt-2 text-sm text-amber-200/70">{snapshot.pausedReason}</p>
                    ) : null}
                  </div>
                ) : snapshot.currentToken === null ? (
                  <div className="py-4">
                    <p className="text-3xl sm:text-4xl font-bold text-slate-500">
                      {s.displayNotStarted}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center">
                    <span className="text-xs sm:text-sm font-bold tracking-widest text-emerald-400 uppercase">
                      {s.yourToken}
                    </span>
                    <p
                      className="numeric font-black leading-none text-white tracking-tight drop-shadow-[0_0_35px_rgba(16,185,129,0.35)] mt-1"
                      style={{ fontSize: 'clamp(4.5rem, 11vw, 8.5rem)' }}
                    >
                      {snapshot.currentToken}
                    </p>
                    {snapshot.currentPatientName ? (
                      <div className="mt-3 inline-flex items-center gap-2 rounded-2xl bg-white/10 px-4 py-1.5 text-base sm:text-lg font-bold text-slate-100 ring-1 ring-white/15">
                        <span>👤</span>
                        <span className="truncate max-w-[280px]">{snapshot.currentPatientName}</span>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {/* Next Patient Bar */}
              {snapshot.nextPatient && !snapshot.paused ? (
                <div className="mb-5 flex items-center justify-between rounded-2xl bg-emerald-950/60 p-3.5 ring-1 ring-emerald-500/30 text-emerald-200">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 shrink-0">
                      {s.displayNextPatient}:
                    </span>
                    <span className="font-bold text-white text-base truncate">
                      {snapshot.nextPatient.patientName}
                    </span>
                  </div>
                  <span className="numeric font-black text-emerald-300 bg-emerald-500/20 px-2.5 py-0.5 rounded-lg text-sm shrink-0">
                    #{snapshot.nextPatient.tokenNumber}
                  </span>
                </div>
              ) : null}

              {/* Footer Stats */}
              <dl className="grid grid-cols-2 gap-4 border-t border-white/10 pt-4 text-slate-400">
                <div className="flex flex-col items-center sm:items-start">
                  <dt className="text-xs sm:text-sm font-medium">{s.displayWaiting}</dt>
                  <dd className="numeric text-2xl sm:text-3xl font-black text-white mt-0.5">
                    {snapshot.waitingCount}
                  </dd>
                </div>
                <div className="flex flex-col items-center sm:items-end">
                  <dt className="text-xs sm:text-sm font-medium">{s.displaySeenToday}</dt>
                  <dd className="numeric text-2xl sm:text-3xl font-black text-slate-200 mt-0.5">
                    {snapshot.completedCount}
                  </dd>
                </div>
              </dl>
            </section>
          ))}
        </div>
      )}

      {/* Footer Branding */}
      <footer className="mt-8 flex items-center justify-between border-t border-white/10 pt-4 text-xs font-medium text-slate-500">
        <p>Qurio QueueCare™ · Real-time OPD Display System</p>
        <p>Auto-refreshing every 10 seconds</p>
      </footer>
    </main>
  );
}

