import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '@/components/auto-refresh';
import { cn } from '@/components/ui';
import { formatTimeIn, formatWindowIn } from '@/lib/domain/time';
import { isLocale, LOCALE_NAMES, LOCALES, t, type Locale } from '@/lib/i18n/patient';
import { getPublicQueueView } from '@/lib/services/queue';
import { cancelAppointment } from './actions';

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
    // Acknowledges the patient's own action when they are the one who just
    // took it, rather than telling them a token "has been cancelled" as if it
    // were news.
    const justCancelled = query.cancel === 'done';
    return (
      <Shell locale={locale} token={token}>
        <Message
          title={justCancelled ? s.cancelDone : s.cancelled}
          hint={justCancelled ? s.cancelDoneHint : s.expiredHint}
          tone="muted"
        />
        <TokenCard label={s.yourToken} token={view.tokenNumber} muted />
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

      {/**
       * Status, estimate and what is being served are one card, not three.
       *
       * They were stacked separately, which pushed the cancel control to
       * roughly 680px on a 375x812 handset — below the fold on every phone
       * this product targets, so the one action a patient came to take needed
       * a scroll to find. They are also a single thought: "where am I, and
       * when". Grouping them costs nothing in clarity and buys the whole
       * screen back.
       */}
      {isTurn ? (
        <Message title={s.yourTurn} hint={s.yourTurnHint} tone="call" />
      ) : isInConsult ? (
        <Message title={s.withDoctor} tone="done" />
      ) : view.paused ? (
        <Message title={s.paused} hint={s.pausedHint} tone="warn" />
      ) : (
        <AheadHero
          ahead={view.patientsAhead ?? 0}
          strings={s}
          doctorName={view.doctorName}
          eta={
            view.eta
              ? formatWindowIn(view.timezone, view.eta.windowStart, view.eta.windowEnd)
              : null
          }
          currentToken={view.currentToken}
        />
      )}

      {/**
       * Token and appointment time, side by side.
       *
       * Stacked as a full-width token card above a separate tile grid, these
       * two facts cost 176px and put the cancel control 43px below the fold on
       * a 360x640 handset — the shape of the budget Android this product is
       * most often opened on. The doctor's name moved into the hero, which is
       * where the patient is already reading.
       */}
      <div className={cn('grid gap-3', view.scheduledSlotAt ? 'grid-cols-2' : 'grid-cols-1')}>
        <TokenCard label={s.yourToken} token={view.tokenNumber} />
        {view.scheduledSlotAt ? (
          <Tile
            label={s.appointmentTime}
            value={formatTimeIn(view.timezone, view.scheduledSlotAt)}
          />
        ) : null}
      </div>

      {query.cancel === 'late' ? (
        <Message title={s.cancelTooLate} hint={s.cancelTooLateHint} tone="warn" />
      ) : null}

      {view.cancellable ? (
        <CancelBlock
          token={token}
          locale={locale}
          strings={s}
          confirming={query.cancel === 'confirm'}
        />
      ) : null}

      {/* Advisory, so it sits below the action rather than in front of it. */}
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

/**
 * The patient's own cancel control.
 *
 * Two steps, and the destructive one is never the first thing on screen. This
 * page auto-refreshes every 45 seconds on a phone that is probably in a
 * pocket, so a single red button sitting under a thumb would eventually be
 * pressed by accident — and a cancelled appointment cannot be undone from
 * here.
 *
 * The confirmation is a link, not JavaScript. The whole page is a server
 * component precisely so it works on the cheap Android handsets this product
 * is aimed at; adding a client bundle for one confirm dialog would be a poor
 * trade, and `window.confirm` is not translatable.
 */
function CancelBlock({
  token,
  locale,
  strings,
  confirming,
}: {
  token: string;
  locale: Locale;
  strings: (typeof t)[Locale];
  confirming: boolean;
}) {
  const langParam = `&lang=${locale}`;

  if (!confirming) {
    return (
      <div className="rounded-2xl border border-ink-200 bg-white p-4 text-center">
        <p className="text-base leading-relaxed text-ink-600">{strings.cancelPrompt}</p>
        <Link
          href={`/q/${token}?cancel=confirm${langParam}`}
          // Outlined, not filled. At this step it is one option among the
          // things on the page, and a solid red block would read as the
          // primary action on a page whose purpose is to show a queue.
          className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl border-2 border-rose-300 bg-white px-5 text-base font-semibold text-rose-700 active:bg-rose-50"
        >
          {strings.cancelAction}
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-rose-300 bg-rose-50 p-4 text-center">
      {/**
       * The heading and the two buttons, and nothing else.
       *
       * This panel used to repeat `cancelPrompt` — the sentence the patient
       * had just read and acted on by tapping through. Three lines of restated
       * reasoning pushed "No, keep it" 57px below the fold on a 360x640
       * handset, which meant the way out of a destructive confirmation needed
       * a scroll while the destructive button sat in view. Removing it is both
       * shorter and better: at this point the question is yes or no.
       */}
      <p className="text-lg font-semibold text-rose-900">{strings.cancelAction}?</p>

      <form action={cancelAppointment} className="mt-4">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="lang" value={locale} />
        <button
          type="submit"
          // Solid red only once the patient has already said they mean it.
          // Min height 48px: this is tapped with a thumb, often one-handed.
          className="min-h-12 w-full rounded-xl bg-rose-600 px-5 text-base font-bold text-white active:bg-rose-800"
        >
          {strings.cancelConfirm}
        </button>
      </form>

      <Link
        href={`/q/${token}?lang=${locale}`}
        className="mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-white px-5 text-base font-semibold text-ink-700 active:bg-ink-100"
      >
        {strings.cancelKeep}
      </Link>
    </div>
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
      className={cn('mx-auto min-h-dvh max-w-md px-4 pb-8 pt-4', locale !== 'en' && 'font-deva')}
    >
      <nav className="mb-4 flex justify-center gap-1.5" aria-label="Language">
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
      <div className="space-y-3">{children}</div>
    </main>
  );
}

/**
 * The hero is "how many people are in front of you", not a clock time, because
 * it is the one number that is always literally true and that a patient can
 * verify by looking around the room.
 */
/**
 * Where the patient is in the queue, when they can expect to be seen, and
 * which token is in the room — in one card.
 *
 * Padding is p-6 rather than p-8, and the count is text-6xl rather than 7xl.
 * Both were sized for a card that had the screen to itself; carrying three
 * facts they would run the page past the fold again, and 60px of digit is
 * still readable at arm's length.
 */
function AheadHero({
  ahead,
  strings,
  doctorName,
  eta,
  currentToken,
}: {
  ahead: number;
  strings: (typeof t)[Locale];
  doctorName: string;
  /** Pre-formatted window, or null when no estimate can be trusted. */
  eta: string | null;
  currentToken: number | null;
}) {
  const next = ahead === 0;

  return (
    <div
      className={cn(
        'rounded-2xl p-5 text-center',
        next ? 'bg-brand-600 text-white' : 'bg-white ring-1 ring-ink-200',
      )}
    >
      {/* Named here rather than in its own tile: the patient is already
          reading this card, and a doctor's name is reference, not an answer. */}
      <p className={cn('mb-2 text-sm font-medium', next ? 'text-white/80' : 'text-ink-500')}>
        {doctorName}
      </p>

      {next ? (
        <p className="text-2xl font-bold leading-snug">{strings.youAreNext}</p>
      ) : (
        <>
          <p className="numeric text-6xl font-bold leading-none text-brand-700">{ahead}</p>
          <p className="mt-2 text-lg font-medium leading-snug text-ink-600">
            {strings.peopleAhead}
          </p>
        </>
      )}

      {eta ? (
        <div
          className={cn(
            'mt-4 border-t pt-4',
            next ? 'border-white/25' : 'border-ink-200',
          )}
        >
          <p
            className={cn(
              'text-sm font-medium',
              next ? 'text-white/80' : 'text-ink-500',
            )}
          >
            {strings.estimatedTime}
          </p>
          <p
            className={cn(
              'numeric mt-0.5 text-2xl font-bold',
              next ? 'text-white' : 'text-ink-900',
            )}
          >
            {eta}
          </p>
          {/* The hedge is not decoration. An estimate presented as a promise is
              how this page stops being trusted. Smaller now, but still there. */}
          <p
            className={cn(
              'mt-1.5 text-xs leading-relaxed',
              next ? 'text-white/70' : 'text-ink-500',
            )}
          >
            {strings.estimateHint}
          </p>
        </div>
      ) : null}

      <p
        className={cn(
          'mt-3 text-sm',
          next ? 'text-white/80' : 'text-ink-500',
        )}
      >
        {strings.nowServing}{' '}
        <span className="numeric font-semibold">
          {currentToken !== null ? currentToken : '—'}
        </span>
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
        'flex flex-col items-center justify-center rounded-2xl px-4 py-3 text-center',
        muted ? 'bg-ink-100' : 'bg-ink-900',
      )}
    >
      <span className={cn('text-sm font-medium', muted ? 'text-ink-500' : 'text-ink-300')}>
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
