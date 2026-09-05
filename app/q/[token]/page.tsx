import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '@/components/auto-refresh';
import { cn } from '@/components/ui';
import { formatTimeIn, formatWindowIn } from '@/lib/domain/time';
import { isLocale, LOCALE_NAMES, LOCALES, t, type Locale } from '@/lib/i18n/patient';
import { getPublicQueueView } from '@/lib/services/queue';

export const metadata = { title: 'Your queue' };
export const dynamic = 'force-dynamic';

export default async function PatientQueuePage({
  params,
  searchParams,
}: PageProps<'/q/[token]'>) {
  const { token } = await params;
  const query = await searchParams;
  const view = await getPublicQueueView(token);

  // The language the patient booked in, unless they have deliberately switched.
  const locale: Locale = isLocale(query.lang) ? query.lang : (view?.locale ?? 'en');
  const s = t[locale];

  if (!view) {
    return (
      <Shell locale={locale} token={token}>
        <Message title={s.notFound} hint={s.notFoundHint} tone="muted" />
      </Shell>
    );
  }

  if (view.expired) {
    return (
      <Shell locale={locale} token={token}>
        <Message title={s.expired} hint={s.expiredHint} tone="muted" />
      </Shell>
    );
  }

  if (view.status === 'CANCELLED' || view.status === 'NO_SHOW') {
    return (
      <Shell locale={locale} token={token}>
        <Message title={s.cancelled} hint={s.expiredHint} tone="muted" />
      </Shell>
    );
  }

  if (view.status === 'COMPLETED') {
    return (
      <Shell locale={locale} token={token}>
        <Message title={s.completed} hint={s.completedHint} tone="done" />
        <TokenCard label={s.yourToken} token={view.tokenNumber} muted />
      </Shell>
    );
  }

  const isTurn = view.status === 'CALLED';
  const isInConsult = view.status === 'IN_CONSULTATION';

  return (
    <Shell locale={locale} token={token}>
      {/* Poll gently. The queue does not move faster than this, and these are
          metered mobile connections. */}
      <AutoRefresh seconds={view.paused ? 180 : 45} />

      {isTurn ? (
        <Message title={s.yourTurn} hint={s.yourTurnHint} tone="call" />
      ) : isInConsult ? (
        <Message title={s.withDoctor} tone="done" />
      ) : view.paused ? (
        <Message title={s.paused} hint={s.pausedHint} tone="warn" />
      ) : (
        <AheadHero ahead={view.patientsAhead ?? 0} strings={s} />
      )}

      <TokenCard label={s.yourToken} token={view.tokenNumber} />

      <dl className="grid grid-cols-2 gap-3">
        <Tile
          label={s.nowServing}
          value={view.currentToken !== null ? String(view.currentToken) : '—'}
        />
        <Tile label={s.doctor} value={view.doctorName} small />
      </dl>

      {view.eta && !isTurn && !isInConsult && !view.paused ? (
        <div className="rounded-2xl border border-ink-200 bg-white p-5 text-center">
          <p className="text-sm font-medium text-ink-500">{s.estimatedTime}</p>
          <p className="numeric mt-1 text-3xl font-bold text-ink-900">
            {formatWindowIn(view.timezone, view.eta.windowStart, view.eta.windowEnd)}
          </p>
          {/* The hedge is not decoration. An estimate presented as a promise is
              how this page stops being trusted. */}
          <p className="mt-2 text-sm leading-relaxed text-ink-500">{s.estimateHint}</p>
        </div>
      ) : null}

      {!isTurn && !isInConsult && !view.paused ? (
        <p className="px-2 text-center text-base leading-relaxed text-ink-600">
          {s.leaveHint}
        </p>
      ) : null}

      <p className="pb-2 text-center text-sm text-ink-400">
        {s.updated} {formatTimeIn(view.timezone, view.lastUpdatedAt)}
      </p>
    </Shell>
  );
}

/* -------------------------------------------------------------- fragments */

function Shell({
  children,
  locale,
  token,
}: {
  children: ReactNode;
  locale: Locale;
  token: string;
}) {
  return (
    <main
      lang={locale}
      className={cn('mx-auto min-h-dvh max-w-md px-4 pb-8 pt-5', locale !== 'en' && 'font-deva')}
    >
      <nav className="mb-5 flex justify-center gap-1.5" aria-label="Language">
        {LOCALES.map((code) => (
          <Link
            key={code}
            href={`/q/${token}?lang=${code}`}
            replace
            className={cn(
              'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              code === locale
                ? 'bg-ink-900 text-white'
                : 'bg-white text-ink-600 ring-1 ring-inset ring-ink-200',
            )}
          >
            {LOCALE_NAMES[code]}
          </Link>
        ))}
      </nav>
      <div className="space-y-4">{children}</div>
    </main>
  );
}

/**
 * The hero is "how many people are in front of you", not a clock time, because
 * it is the one number that is always literally true and that a patient can
 * verify by looking around the room.
 */
function AheadHero({
  ahead,
  strings,
}: {
  ahead: number;
  strings: (typeof t)[Locale];
}) {
  if (ahead === 0) {
    return (
      <div className="rounded-2xl bg-brand-600 p-8 text-center text-white">
        <p className="text-2xl font-bold leading-snug">{strings.youAreNext}</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white p-8 text-center ring-1 ring-ink-200">
      <p className="numeric text-7xl font-bold leading-none text-brand-700">{ahead}</p>
      <p className="mt-3 text-lg font-medium leading-snug text-ink-600">
        {strings.peopleAhead}
      </p>
    </div>
  );
}

function TokenCard({
  label,
  token,
  muted = false,
}: {
  label: string;
  token: number;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-2xl px-6 py-5',
        muted ? 'bg-ink-100' : 'bg-ink-900',
      )}
    >
      <span className={cn('text-base font-medium', muted ? 'text-ink-500' : 'text-ink-300')}>
        {label}
      </span>
      <span
        className={cn('numeric text-4xl font-bold', muted ? 'text-ink-500' : 'text-white')}
      >
        {token}
      </span>
    </div>
  );
}

function Tile({
  label,
  value,
  small = false,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-ink-200 bg-white px-4 py-4 text-center">
      <dt className="text-sm font-medium text-ink-500">{label}</dt>
      <dd
        className={cn(
          'mt-1 font-bold text-ink-900',
          small ? 'text-lg leading-snug' : 'numeric text-3xl',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Message({
  title,
  hint,
  tone,
}: {
  title: string;
  hint?: string;
  tone: 'call' | 'warn' | 'done' | 'muted';
}) {
  const tones = {
    call: 'bg-brand-600 text-white',
    warn: 'bg-amber-100 text-amber-900 ring-1 ring-amber-200',
    done: 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200',
    muted: 'bg-white text-ink-700 ring-1 ring-ink-200',
  } as const;

  return (
    <div className={cn('rounded-2xl p-8 text-center', tones[tone])}>
      <p className="text-2xl font-bold leading-snug">{title}</p>
      {hint ? <p className="mt-2 text-base leading-relaxed opacity-90">{hint}</p> : null}
    </div>
  );
}
