'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { quickAddMedicineDynamic } from '@/app/(app)/dashboard/consultation-actions';
import { Button, Input, cn } from '@/components/ui';
import { useToast } from '@/components/toast';
import type { MedicineOption } from '@/lib/services/medicines';

/**
 * Type-to-search for a medicine in the hospital's catalogue.
 *
 * Searches the server as the doctor types (debounced), rather than loading the
 * whole catalogue into the browser. Arrow keys and Enter pick without the
 * mouse. When nothing matches, the doctor can add the medicine on the spot —
 * unpriced, for the owner to price later — so an incomplete catalogue never
 * stands between a doctor and a prescription.
 *
 * The response carries no price: see app/api/medicines/search/route.ts.
 */
export function MedicinePicker({
  onPick,
  canQuickAdd,
  autoFocus = false,
}: {
  onPick: (medicine: MedicineOption) => void;
  canQuickAdd: boolean;
  autoFocus?: boolean;
}) {
  const toast = useToast();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MedicineOption[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<{ name: string; strength: string; form: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;

    // Debounced, and cancelled if the doctor keeps typing, so only the
    // answer to the latest keystroke is ever shown.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/medicines/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { results: MedicineOption[] };
        setResults(body.results);
        setActive(0);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setResults([]);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const pick = (medicine: MedicineOption) => {
    onPick(medicine);
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  };

  const tooShort = query.trim().length < 2;
  const showAddOption = canQuickAdd && !tooShort && !searching;
  // The "add new" row sits after the results in keyboard order.
  const optionCount = results.length + (showAddOption ? 1 : 0);

  const startAdding = () => {
    setAdding({ name: query.trim(), strength: '', form: '' });
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || optionCount === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % optionCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + optionCount) % optionCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active < results.length) pick(results[active]);
      else if (showAddOption) startAdding();
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const submitAdd = () => {
    if (!adding) return;
    startTransition(async () => {
      const res = await quickAddMedicineDynamic(adding);
      if (res.ok) {
        toast.info('Medicine added', `${res.medicine.label} — the owner can set its price later.`);
        setAdding(null);
        pick(res.medicine);
      } else {
        toast.error('Medicine not added', res.error);
      }
    });
  };

  if (adding) {
    return (
      <div className="space-y-2 rounded-lg bg-ink-50 p-3 ring-1 ring-ink-200">
        <p className="text-xs font-semibold text-ink-700">Add a medicine to this hospital&apos;s list</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Input
            aria-label="Medicine name"
            value={adding.name}
            onChange={(e) => setAdding({ ...adding, name: e.target.value })}
            placeholder="Name"
            autoFocus
          />
          <Input
            aria-label="Strength"
            value={adding.strength}
            onChange={(e) => setAdding({ ...adding, strength: e.target.value })}
            placeholder="Strength, e.g. 500 mg"
          />
          <Input
            aria-label="Form"
            value={adding.form}
            onChange={(e) => setAdding({ ...adding, form: e.target.value })}
            placeholder="Form, e.g. tablet"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(null)}>
            Cancel
          </Button>
          <Button type="button" size="sm" variant="primary" isLoading={isPending} onClick={submitAdd}>
            Add and use
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Add a medicine"
        value={query}
        onChange={(e) => {
          const next = e.target.value;
          setQuery(next);
          if (next.trim().length < 2) {
            setResults([]);
            setOpen(false);
          }
        }}
        onKeyDown={onKeyDown}
        onFocus={() => optionCount > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="+ Add medicine — type 2 letters to search"
        autoComplete="off"
        autoFocus={autoFocus}
      />
      {open && optionCount > 0 ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-ink-200"
        >
          {results.map((medicine, index) => (
            <li
              key={medicine.id}
              role="option"
              aria-selected={index === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(medicine);
              }}
              onMouseEnter={() => setActive(index)}
              className={cn(
                'cursor-pointer px-3 py-2 text-sm',
                index === active ? 'bg-brand-50 text-brand-900' : 'text-ink-800',
              )}
            >
              <span className="font-medium">{medicine.label}</span>
              {medicine.genericName ? (
                <span className="ml-2 text-xs text-ink-500">{medicine.genericName}</span>
              ) : null}
            </li>
          ))}
          {showAddOption ? (
            <li
              role="option"
              aria-selected={active === results.length}
              onMouseDown={(e) => {
                e.preventDefault();
                startAdding();
              }}
              onMouseEnter={() => setActive(results.length)}
              className={cn(
                'cursor-pointer border-t border-ink-100 px-3 py-2 text-sm',
                active === results.length ? 'bg-brand-50 text-brand-900' : 'text-ink-600',
              )}
            >
              Not in the list? Add &ldquo;{query.trim()}&rdquo;
            </li>
          ) : null}
        </ul>
      ) : null}
      {searching ? (
        <span className="pointer-events-none absolute right-3 top-3 text-xs text-ink-400">Searching…</span>
      ) : null}
    </div>
  );
}
