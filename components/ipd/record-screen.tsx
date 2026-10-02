'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, cn } from '@/components/ui';
import { ArrowLeftIcon, CheckIcon, SearchIcon, UndoIcon, WifiOffIcon, XIcon } from '@/components/icons';
import { DUPLICATE_WINDOW_MS, GIVEN_AT_OPTIONS, UNDO_WINDOW_MS } from '@/lib/domain/care-entry';
import { queueEntries, sendEntries, type OutboxEntry } from './outbox';
import { useOnline } from './use-online';

/**
 * The nurse's record screen (IPD plan §5.6): tap an item, tap Save. Two taps
 * for the common case, on a phone, at the bedside.
 *
 * Everything the server needs is decided here except the price, which the
 * server reads itself. If the network is down the entry goes to the phone's
 * outbox and is sent later with the same client id, so it is recorded once.
 */

export type Pick = { ref: { type: 'medicine' | 'charge'; id: string }; label: string; unit: string };

type NewItem = { type: 'new'; kind: 'medicine' | 'consumable' | 'procedure'; name: string };
type Chosen = { item: Pick['ref'] | NewItem; label: string; unit: string };

type TodayEntry = {
  id: string;
  description: string;
  itemKey: string;
  quantity: number;
  occurredAt: string;
  recordedByName: string | null;
  canUndo: boolean;
  undoUntil: string | null;
};

type Confirmation =
  | { kind: 'saved'; entryId: string; text: string; undoUntil: number }
  | { kind: 'queued'; text: string }
  | { kind: 'error'; text: string };

const keyOf = (item: Chosen['item']) => (item.type === 'new' ? `new:${item.kind}:${item.name.toLowerCase()}` : `${item.type}:${item.id}`);

const newClientId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const bytes = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const timeLabel = (iso: string | number | Date) =>
  new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));

export function RecordScreen({
  admissionId,
  patient,
  backHref,
  backLabel,
  recent: initialRecent,
  common,
}: {
  admissionId: string;
  patient: { name: string; ageSex: string; bedLabel: string; wardName: string; day: number | null };
  backHref: string;
  backLabel: string;
  recent: Pick[];
  common: Pick[];
}) {
  const [recent, setRecent] = useState(initialRecent);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Pick[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [minutesAgo, setMinutesAgo] = useState(0);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [today, setToday] = useState<TodayEntry[]>([]);
  const [showToday, setShowToday] = useState(false);
  const online = useOnline();
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);

  const loadToday = useCallback(async () => {
    try {
      const response = await fetch(`/api/ipd/care-entries?admissionId=${admissionId}`, { cache: 'no-store' });
      if (response.ok) setToday(((await response.json()) as { entries: TodayEntry[] }).entries);
    } catch {
      // Offline: keep what is on screen.
    }
  }, [admissionId]);

  useEffect(() => {
    const first = setTimeout(() => void loadToday(), 0);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, [loadToday]);

  // Search as the nurse types, after a short pause.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(`/api/ipd/items/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
        if (response.ok) setResults(((await response.json()) as { results: Pick[] }).results);
      } catch {
        // Aborted or offline; the chips above still work.
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const open = (choice: Chosen) => {
    setChosen(choice);
    setQuantity(1);
    setMinutesAgo(0);
    setConfirmDuplicate(false);
  };

  const duplicate = useMemo(() => {
    if (!chosen || chosen.item.type === 'new') return null;
    const key = keyOf(chosen.item);
    const at = now - minutesAgo * 60_000;
    let nearest: number | null = null;
    for (const entry of today) {
      if (entry.itemKey !== key) continue;
      const gap = Math.abs(at - new Date(entry.occurredAt).getTime());
      if (gap <= DUPLICATE_WINDOW_MS && (nearest === null || gap < nearest)) nearest = gap;
    }
    return nearest === null ? null : Math.round(nearest / 60_000);
  }, [chosen, today, minutesAgo, now]);

  const save = async () => {
    if (!chosen || saving) return;
    if (duplicate !== null && !confirmDuplicate) {
      setConfirmDuplicate(true);
      return;
    }
    setSaving(true);
    const occurredAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const entry: OutboxEntry = {
      clientId: newClientId(),
      admissionId,
      item: chosen.item,
      quantity,
      occurredAt,
      label: chosen.label,
      patientName: patient.name,
      queuedAt: new Date().toISOString(),
    };
    const text = `${chosen.label} × ${quantity} · ${timeLabel(occurredAt)}`;
    const outcome = await sendEntries([entry]);

    if (outcome.kind === 'sent') {
      const result = outcome.results[0];
      if (result?.ok) {
        setConfirmation({ kind: 'saved', entryId: result.entryId, text, undoUntil: Date.now() + UNDO_WINDOW_MS });
        if (chosen.item.type !== 'new') {
          const pick: Pick = { ref: chosen.item, label: chosen.label, unit: chosen.unit };
          setRecent((list) => [pick, ...list.filter((p) => keyOf(p.ref) !== keyOf(pick.ref))].slice(0, 8));
        }
        void loadToday();
      } else {
        setConfirmation({ kind: 'error', text: result?.error ?? 'Not saved. Try again.' });
      }
    } else {
      // No connection (or signed out): keep it on the phone; it goes later.
      await queueEntries([entry]);
      setConfirmation({ kind: 'queued', text });
    }
    setSaving(false);
    setChosen(null);
    setQuery('');
    setResults(null);
  };

  const undo = async (entryId: string) => {
    try {
      const response = await fetch('/api/ipd/care-entries/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryId }),
      });
      if (response.ok) {
        setConfirmation({ kind: 'error', text: 'Undone — removed from the record.' });
        void loadToday();
      } else {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setConfirmation({ kind: 'error', text: body.error ?? 'Could not undo. Ask the desk.' });
      }
    } catch {
      setConfirmation({ kind: 'error', text: 'No connection. Undo needs the network; ask the desk.' });
    }
  };

  const typed = query.trim();
  const showAddNew = typed.length >= 2 && results !== null && results.length === 0 && !searching;

  return (
    <div className="mx-auto max-w-xl space-y-4 pb-40 text-base">
      <div className="sticky top-14 z-30 -mx-3.5 border-b border-ink-200 bg-white px-3.5 py-2 shadow-xs sm:mx-0 sm:rounded-xl sm:border">
        <div className="flex items-center justify-between gap-2">
          <Link href={backHref} className="inline-flex min-h-12 items-center gap-1.5 pr-3 font-medium text-ink-600">
            <ArrowLeftIcon className="size-5" />
            {backLabel}
          </Link>
          <span className="numeric rounded-lg bg-brand-600 px-3 py-1.5 text-lg font-bold text-white">
            Bed {patient.bedLabel}
          </span>
        </div>
        <p className="mt-1 text-xl font-bold uppercase leading-tight tracking-wide text-ink-900 sm:text-2xl">{patient.name}</p>
        <p className="text-sm text-ink-600">
          {[patient.ageSex || null, patient.wardName, patient.day ? `Day ${patient.day}` : null].filter(Boolean).join(' · ')}
        </p>
      </div>

      {!online ? (
        <p className="flex items-center gap-2 rounded-xl bg-amber-100 px-4 py-3 text-sm font-medium text-amber-950">
          <WifiOffIcon className="size-5 shrink-0" />
          No connection. Keep recording — entries are saved on this phone and sent later.
        </p>
      ) : null}

      {recent.length > 0 ? (
        <section aria-labelledby="recent-heading">
          <h2 id="recent-heading" className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">
            Given recently
          </h2>
          <Chips picks={recent} onPick={(p) => open({ item: p.ref, label: p.label, unit: p.unit })} tone="brand" />
        </section>
      ) : null}

      {common.length > 0 ? (
        <section aria-labelledby="common-heading">
          <h2 id="common-heading" className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">
            Common in this ward
          </h2>
          <Chips picks={common} onPick={(p) => open({ item: p.ref, label: p.label, unit: p.unit })} />
        </section>
      ) : null}

      <section aria-label="Search all items" className="space-y-2">
        <label className="relative block">
          <span className="sr-only">Search all items</span>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-ink-400" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value.trim().length < 2) setResults(null);
            }}
            placeholder="Search all items…"
            autoComplete="off"
            className="block h-12 w-full rounded-xl border-0 bg-white pl-10 pr-3 text-base text-ink-900 ring-1 ring-inset ring-ink-300 placeholder:text-ink-400 focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />
        </label>
        {searching ? <p className="text-sm text-ink-500">Searching…</p> : null}
        {results && results.length > 0 ? (
          <Chips picks={results} onPick={(p) => open({ item: p.ref, label: p.label, unit: p.unit })} />
        ) : null}
        {showAddNew ? (
          <div className="rounded-xl bg-white p-3 ring-1 ring-ink-200">
            <p className="text-sm text-ink-700">
              “{typed}” is not in the list. Add it as a new item — the owner sets its price later.
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(['medicine', 'consumable', 'procedure'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => open({ item: { type: 'new', kind, name: typed }, label: typed, unit: 'unit' })}
                  className="min-h-12 rounded-lg bg-ink-100 px-2 text-sm font-semibold capitalize text-ink-800 hover:bg-ink-200"
                >
                  {kind}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl bg-white ring-1 ring-ink-200">
        <button
          type="button"
          onClick={() => setShowToday((v) => !v)}
          aria-expanded={showToday}
          className="flex min-h-12 w-full items-center justify-between px-4 text-left font-semibold text-ink-800"
        >
          Today: {today.length} item{today.length === 1 ? '' : 's'} recorded
          <span aria-hidden="true">{showToday ? '▾' : '▸'}</span>
        </button>
        {showToday ? (
          today.length === 0 ? (
            <p className="border-t border-ink-100 px-4 py-3 text-sm text-ink-500">Nothing yet today.</p>
          ) : (
            <ul className="divide-y divide-ink-100 border-t border-ink-100">
              {today.map((entry) => {
                const undoable = entry.undoUntil !== null && new Date(entry.undoUntil).getTime() > now;
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-base text-ink-900">
                        {entry.description} <span className="numeric text-ink-500">× {entry.quantity}</span>
                      </p>
                      <p className="numeric text-sm text-ink-500">
                        {timeLabel(entry.occurredAt)} · {entry.recordedByName ?? 'Staff'}
                      </p>
                    </div>
                    {undoable ? (
                      <button
                        type="button"
                        onClick={() => void undo(entry.id)}
                        className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-brand-700 hover:bg-brand-50"
                      >
                        <UndoIcon className="size-4" />
                        Undo
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </section>

      {confirmation ? (
        <ConfirmationBar
          confirmation={confirmation}
          now={now}
          onUndo={(id) => void undo(id)}
          onClose={() => setConfirmation(null)}
        />
      ) : null}

      {chosen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
          <button type="button" aria-label="Close" className="absolute inset-0" onClick={() => setChosen(null)} />
          <div className="relative w-full max-w-xl rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-bottom-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p id="sheet-title" className="text-xl font-bold text-ink-900">
                  {chosen.label}
                </p>
                <p className="text-sm text-ink-500">
                  For {patient.name} · Bed {patient.bedLabel}
                  {chosen.item.type === 'new' ? ' · new item' : ''}
                </p>
              </div>
              <button type="button" onClick={() => setChosen(null)} className="rounded-lg p-3 text-ink-500 hover:bg-ink-100" aria-label="Close">
                <XIcon className="size-5" />
              </button>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <span className="font-medium text-ink-700">How many{chosen.unit !== 'unit' ? ` (${chosen.unit})` : ''}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="One less"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="size-12 rounded-xl bg-ink-100 text-2xl font-bold text-ink-800 disabled:opacity-40"
                  disabled={quantity <= 1}
                >
                  −
                </button>
                <span className="numeric w-12 text-center text-2xl font-bold text-ink-900" aria-live="polite">
                  {quantity}
                </span>
                <button
                  type="button"
                  aria-label="One more"
                  onClick={() => setQuantity((q) => Math.min(999, q + 1))}
                  className="size-12 rounded-xl bg-ink-100 text-2xl font-bold text-ink-800"
                >
                  +
                </button>
              </div>
            </div>

            <fieldset className="mt-4">
              <legend className="mb-2 font-medium text-ink-700">Given at</legend>
              <div className="grid grid-cols-4 gap-1.5">
                {GIVEN_AT_OPTIONS.map((option) => (
                  <button
                    key={option.minutesAgo}
                    type="button"
                    aria-pressed={minutesAgo === option.minutesAgo}
                    onClick={() => {
                      setMinutesAgo(option.minutesAgo);
                      setConfirmDuplicate(false);
                    }}
                    className={cn(
                      'min-h-12 rounded-lg px-1 text-sm font-semibold',
                      minutesAgo === option.minutesAgo ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <Button
              type="button"
              variant="primary"
              size="xl"
              className={cn('mt-5 w-full', duplicate !== null && !confirmDuplicate && 'bg-amber-600 hover:bg-amber-700')}
              onClick={() => void save()}
              isLoading={saving}
            >
              {duplicate !== null && !confirmDuplicate
                ? `Add again? (given ${duplicate} min ago)`
                : duplicate !== null
                  ? 'Yes, add again'
                  : 'Save'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Chips({ picks, onPick, tone = 'plain' }: { picks: Pick[]; onPick: (pick: Pick) => void; tone?: 'brand' | 'plain' }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {picks.map((pick) => (
        <li key={`${pick.ref.type}:${pick.ref.id}`}>
          <button
            type="button"
            onClick={() => onPick(pick)}
            className={cn(
              'min-h-12 rounded-xl px-4 text-left text-base font-semibold ring-1 ring-inset active:scale-[0.98]',
              tone === 'brand'
                ? 'bg-brand-50 text-brand-900 ring-brand-300 hover:bg-brand-100'
                : 'bg-white text-ink-800 ring-ink-300 hover:bg-ink-50',
            )}
          >
            {pick.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ConfirmationBar({
  confirmation,
  now,
  onUndo,
  onClose,
}: {
  confirmation: Confirmation;
  now: number;
  onUndo: (entryId: string) => void;
  onClose: () => void;
}) {
  const secondsLeft =
    confirmation.kind === 'saved' ? Math.max(0, Math.ceil((confirmation.undoUntil - now) / 1000)) : 0;
  return (
    <div
      role="status"
      className={cn(
        'fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-xl px-4 py-3 text-white shadow-lg',
        'mb-[env(safe-area-inset-bottom)]',
        confirmation.kind === 'saved' ? 'bg-emerald-700' : confirmation.kind === 'queued' ? 'bg-amber-600' : 'bg-ink-800',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {confirmation.kind === 'saved' ? (
          <CheckIcon className="size-5 shrink-0" />
        ) : confirmation.kind === 'queued' ? (
          <WifiOffIcon className="size-5 shrink-0" />
        ) : null}
        <p className="min-w-0 text-sm font-semibold">
          {confirmation.kind === 'saved' ? `Saved · ${confirmation.text}` : null}
          {confirmation.kind === 'queued' ? `Saved on this phone — will sync · ${confirmation.text}` : null}
          {confirmation.kind === 'error' ? confirmation.text : null}
        </p>
      </div>
      {confirmation.kind === 'saved' && secondsLeft > 0 ? (
        <button
          type="button"
          onClick={() => onUndo(confirmation.entryId)}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg bg-white/15 px-3 text-sm font-bold hover:bg-white/25"
        >
          <UndoIcon className="size-4" />
          Undo <span className="numeric font-normal opacity-80">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</span>
        </button>
      ) : (
        <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-2 hover:bg-white/15" aria-label="Dismiss">
          <XIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
