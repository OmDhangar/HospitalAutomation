'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, cn } from '@/components/ui';
import { CheckIcon, PlusIcon, UndoIcon, WifiOffIcon, XIcon } from '@/components/icons';
import { UNDO_WINDOW_MS } from '@/lib/domain/care-entry';
import {
  BACK_HOURS,
  CONSCIOUSNESS_LABELS,
  FRONT_HOURS,
  INTAKE_COLUMNS,
  OUTPUT_COLUMNS,
  SHIFTS,
  VITAL_COLUMNS,
  hourLabel,
  readingSummary,
  type Consciousness,
  type IoTotal,
  type ShiftKey,
  type TprEntryInput,
  type VitalCell,
  type VitalKey,
  vitalCell,
} from '@/lib/domain/tpr';
import { OUTBOX_EVENT } from './outbox-core';
import { TprEntrySheet, type LastValues } from './tpr-entry-sheet';
import { pendingReadings, queueReadings, sendReadings, type TprOutboxEntry } from './tpr-outbox';

/**
 * The T.P.R. chart of one chart day (IPD sheets plan B1). On a phone it is a
 * list by the paper's hours; from a tablet up it is the paper grid itself —
 * hours down the side (front 8 am–10 pm, back 11 pm–7 am), the paper's
 * columns across, what was given in the Treatment column, and intake/output
 * totalled per shift and for the 24 hours.
 *
 * Readings are never edited. The nurse's own reading can be undone for two
 * minutes; after that anyone who charts can Correct it, with a reason, and it
 * stays visible struck through.
 */

export type ChartReading = {
  id: string;
  observedAt: string;
  hour: number;
  recordedByName: string | null;
  channel: 'personal' | 'ward_device' | null;
  late: boolean;
  undoUntil: string | null;
  pulse: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  spo2: number | null;
  tempFTenths: number | null;
  bslMgDl: number | null;
  respRate: number | null;
  abdGirthCm: number | null;
  onOxygen: boolean | null;
  consciousness: Consciousness | null;
  drainMl: number | null;
  urineMl: number | null;
  rtAspirateMl: number | null;
  oralMl: number | null;
  ivMl: number | null;
  note: string | null;
};

export type ChartVoided = {
  id: string;
  observedAt: string;
  voidReason: string | null;
  summary: string;
};
export type ChartTreatment = {
  id: string;
  occurredAt: string;
  hour: number;
  description: string;
  quantity: number;
};

type Confirmation =
  | { kind: 'saved'; entryId: string; text: string; undoUntil: number }
  | { kind: 'queued'; text: string }
  | { kind: 'info'; text: string };

const newClientId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const bytes = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Paper column order, with the short labels the table header uses. */
const VITAL_ORDER = VITAL_COLUMNS.map((column) => [column.key, column.label] as const);
const vitalCells = (r: ChartReading) =>
  Object.fromEntries(VITAL_COLUMNS.map((column) => [column.key, vitalCell(r, column.key)])) as Record<VitalKey, VitalCell | null>;

export function TprChart({
  admissionId,
  patientLabel,
  timezone,
  canChart,
  readings,
  voided,
  treatment,
  totals,
  last,
  showHistory = false,
}: {
  admissionId: string;
  patientLabel: string;
  timezone: string;
  /** May this person add readings here now (permission, module on for the ward, patient in a bed, today's sheet)? */
  canChart: boolean;
  readings: ChartReading[];
  voided: ChartVoided[];
  treatment: ChartTreatment[];
  totals: { byShift: Record<ShiftKey, IoTotal>; day: IoTotal };
  last: LastValues | null;
  /** The owner sees a History link on each reading: who wrote it, how and when (evidence log). */
  showHistory?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [correcting, setCorrecting] = useState<ChartReading | null>(null);
  const [waiting, setWaiting] = useState<TprOutboxEntry[]>([]);
  const [now, setNow] = useState(0);

  const time = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: timezone,
      }),
    [timezone],
  );

  const loadWaiting = useCallback(async () => {
    try {
      const list = (await pendingReadings()).filter((entry) => entry.admissionId === admissionId);
      setWaiting(list);
      // The outbox has sent what was waiting: say so instead of "will sync".
      if (list.length === 0) {
        setConfirmation((c) => (c?.kind === 'queued' ? { kind: 'info', text: `Sent · ${c.text}` } : c));
      }
    } catch {
      setWaiting([]);
    }
  }, [admissionId]);

  useEffect(() => {
    const first = setTimeout(() => {
      setNow(Date.now());
      void loadWaiting();
    }, 0);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // A reading from the outbox reached the server (or was queued): show the chart as it now stands.
    const changed = () => {
      void loadWaiting();
      if (navigator.onLine) router.refresh();
    };
    window.addEventListener(OUTBOX_EVENT, changed);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
      window.removeEventListener(OUTBOX_EVENT, changed);
    };
  }, [loadWaiting, router]);

  const save = async (reading: Omit<TprEntryInput, 'clientId' | 'admissionId' | 'observedAt'>, minutesAgo: number) => {
    if (saving) return;
    setSaving(true);
    const observedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const text = `${readingSummary(reading)} · ${time.format(new Date(observedAt))}`;
    const entry: TprOutboxEntry = {
      ...reading,
      clientId: newClientId(),
      admissionId,
      observedAt,
      label: text,
      patientName: patientLabel,
      queuedAt: new Date().toISOString(),
    };
    const outcome = await sendReadings([entry]);
    if (outcome.kind === 'sent') {
      const result = outcome.results[0];
      if (result?.ok) {
        setConfirmation({
          kind: 'saved',
          entryId: result.entryId,
          text,
          undoUntil: Date.now() + UNDO_WINDOW_MS,
        });
        setOpen(false);
        router.refresh();
      } else {
        // Refused (discharged, module off…): keep the sheet open so nothing typed is lost.
        setConfirmation({
          kind: 'info',
          text: result?.error ?? 'Not saved. Try again.',
        });
      }
    } else {
      // No connection, or locked: keep it on the phone; it goes later with the same id.
      await queueReadings([entry]);
      setConfirmation({ kind: 'queued', text });
      setOpen(false);
      void loadWaiting();
    }
    setSaving(false);
  };

  const undo = async (entryId: string) => {
    try {
      const response = await fetch('/api/ipd/tpr/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryId }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setConfirmation({
        kind: 'info',
        text: response.ok ? 'Undone — removed from the chart.' : (body.error ?? 'Could not undo.'),
      });
      if (response.ok) router.refresh();
    } catch {
      setConfirmation({
        kind: 'info',
        text: 'No connection. Undo needs the network.',
      });
    }
  };

  const correct = async (entryId: string, reason: string) => {
    try {
      const response = await fetch('/api/ipd/tpr/void', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryId, reason }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (response.ok) {
        setCorrecting(null);
        setConfirmation({
          kind: 'info',
          text: 'Struck through. Add the right reading if there is one.',
        });
        router.refresh();
      } else {
        setConfirmation({
          kind: 'info',
          text: body.error ?? 'Could not correct.',
        });
      }
    } catch {
      setConfirmation({
        kind: 'info',
        text: 'No connection. Correcting needs the network.',
      });
    }
  };

  const byHour = useMemo(() => {
    const map = new Map<number, { readings: ChartReading[]; given: ChartTreatment[] }>();
    const slot = (hour: number) => {
      let s = map.get(hour);
      if (!s) map.set(hour, (s = { readings: [], given: [] }));
      return s;
    };
    for (const r of readings) slot(r.hour).readings.push(r);
    for (const g of treatment) slot(g.hour).given.push(g);
    return map;
  }, [readings, treatment]);

  const undoable = (r: ChartReading) => r.undoUntil !== null && new Date(r.undoUntil).getTime() > now;

  return (
    <div className="space-y-4 pb-28">

      {waiting.length > 0 ? (
        <section className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
          <p className="text-sm font-semibold text-amber-950">
            {waiting.length} reading{waiting.length === 1 ? '' : 's'} waiting on this phone to be sent
          </p>
          <ul className="mt-1 space-y-0.5 text-sm text-amber-900">
            {waiting.map((entry) => (
              <li key={entry.clientId}>{entry.label}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {readings.length === 0 && treatment.length === 0 ? (
        <p className="rounded-xl bg-white px-4 py-6 text-center text-ink-500 ring-1 ring-ink-200 md:hidden">
          No readings on this sheet yet.
        </p>
      ) : null}

      {/* Phone: the paper's hours as a list. */}
      {readings.length > 0 || treatment.length > 0 ? (
        <ol className="space-y-3 md:hidden">
          {[...FRONT_HOURS, ...BACK_HOURS]
            .filter((hour) => byHour.has(hour))
            .map((hour) => {
              const slot = byHour.get(hour)!;
              return (
                <li key={hour} className="rounded-xl bg-white ring-1 ring-ink-200">
                  <p className="border-b border-ink-100 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-ink-500">
                    {hourLabel(hour)}
                  </p>
                  <ul className="divide-y divide-ink-100">
                    {slot.readings.map((r) => (
                      <li key={r.id} className="px-4 py-3">
                        <ReadingLine reading={r} />
                        <p className="numeric mt-1 text-sm text-ink-500">
                          {time.format(new Date(r.observedAt))} · {r.recordedByName ?? 'Staff'}
                          {r.late ? <span className="ml-1 font-semibold text-amber-800">· late entry</span> : null}
                        </p>
                        {canChart ? (
                          <div className="mt-1 flex gap-2">
                            {undoable(r) ? (
                              <button
                                type="button"
                                onClick={() => void undo(r.id)}
                                className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm font-semibold text-brand-700 hover:bg-brand-50"
                              >
                                <UndoIcon className="size-4" />
                                Undo
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setCorrecting(r)}
                                className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-ink-600 hover:bg-ink-50"
                              >
                                Correct
                              </button>
                            )}
                            {showHistory ? <HistoryLink id={r.id} large /> : null}
                          </div>
                        ) : showHistory ? (
                          <div className="mt-1">
                            <HistoryLink id={r.id} large />
                          </div>
                        ) : null}
                      </li>
                    ))}
                    {slot.given.length > 0 ? (
                      <li className="px-4 py-2 text-sm text-ink-700">
                        <span className="font-semibold text-ink-500">Treatment: </span>
                        {slot.given.map((g) => `${g.description} × ${g.quantity}`).join(', ')}
                      </li>
                    ) : null}
                  </ul>
                </li>
              );
            })}
        </ol>
      ) : null}

      {/* Tablet and desktop: the paper grid. */}
      <div className="hidden overflow-x-auto rounded-xl bg-white ring-1 ring-ink-200 md:block">
        <table className="w-full min-w-[50rem] border-collapse text-sm">
          <thead>
            <tr className="bg-ink-50 text-xs uppercase tracking-wide text-ink-600">
              <th rowSpan={2} className="sticky left-0 z-10 border-b border-r border-ink-200 bg-ink-50 px-2 py-2 text-left">
                Time
              </th>
              {VITAL_ORDER.map(([key, label]) => (
                <th key={key} rowSpan={2} className="border-b border-r border-ink-200 px-2 py-2">
                  {label}
                </th>
              ))}
              <th colSpan={3} className="border-b border-r border-ink-200 px-2 py-1">
                Output (ml)
              </th>
              <th colSpan={2} className="border-b border-r border-ink-200 px-2 py-1">
                Intake (ml)
              </th>
              <th rowSpan={2} className="border-b border-ink-200 px-2 py-2 text-left">
                Treatment
              </th>
            </tr>
            <tr className="bg-ink-50 text-[11px] uppercase tracking-wide text-ink-500">
              {[...OUTPUT_COLUMNS, ...INTAKE_COLUMNS].map((column) => (
                <th key={column.key} className="border-b border-r border-ink-200 px-2 py-1 font-semibold">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...FRONT_HOURS, ...BACK_HOURS].map((hour) => {
              const slot = byHour.get(hour);
              const rows = slot && slot.readings.length > 0 ? slot.readings : [null];
              const shiftEnd = SHIFTS.find((s) => (s.toHour + 23) % 24 === hour);
              return (
                <Fragment key={hour}>
                  {hour === BACK_HOURS[0] ? (
                    <tr>
                      <td
                        colSpan={14}
                        className="bg-ink-100 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink-600"
                      >
                        Back of the sheet
                      </td>
                    </tr>
                  ) : null}
                  {rows.map((r, i) => (
                    <tr key={r?.id ?? `${hour}-empty`} className="border-b border-ink-100 align-top hover:bg-ink-50/50">
                      <td className="numeric sticky left-0 z-10 whitespace-nowrap border-r border-ink-200 bg-white px-2 py-1.5 text-ink-600">
                        {i === 0 ? <span className="font-semibold text-ink-800">{hourLabel(hour)}</span> : null}
                        {r ? (
                          <span className="block text-xs text-ink-500">
                            {time.format(new Date(r.observedAt))}
                            {r.late ? ' · late' : ''}
                          </span>
                        ) : null}
                      </td>
                      {VITAL_ORDER.map(([key]) => {
                        const cell = r ? vitalCells(r)[key] : null;
                        return (
                          <td
                            key={key}
                            className={cn(
                              'numeric border-r border-ink-200 px-2 py-1.5 text-center',
                              cell?.flag && 'bg-rose-50 font-semibold text-rose-800',
                            )}
                          >
                            {cell ? (
                              <>
                                {cell.text}
                                {cell.flag ? (
                                  <span className="ml-0.5 text-[10px] font-bold">{cell.flag === 'high' ? 'H' : 'L'}</span>
                                ) : null}
                              </>
                            ) : null}
                          </td>
                        );
                      })}
                      {[...OUTPUT_COLUMNS, ...INTAKE_COLUMNS].map((column) => (
                        <td key={column.key} className="numeric border-r border-ink-200 px-2 py-1.5 text-center">
                          {r?.[column.key] ?? ''}
                        </td>
                      ))}
                      <td className="px-2 py-1.5 text-ink-700">
                        {i === 0 && slot ? slot.given.map((g) => `${g.description} × ${g.quantity}`).join(', ') : null}
                        {r?.note ? <span className="block text-xs italic text-ink-500">{r.note}</span> : null}
                        {r && (r.onOxygen || r.consciousness) ? (
                          <span className="block text-xs text-ink-500">
                            {[r.onOxygen ? 'On O₂' : null, r.consciousness ? `Consciousness ${r.consciousness}` : null]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        ) : null}
                        {r && canChart ? (
                          undoable(r) ? (
                            <button
                              type="button"
                              onClick={() => void undo(r.id)}
                              className="mt-0.5 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-brand-700 hover:underline"
                            >
                              <UndoIcon className="size-3.5" />
                              Undo
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setCorrecting(r)}
                              className="mt-0.5 inline-flex min-h-8 items-center text-xs font-semibold text-ink-500 hover:text-ink-800 hover:underline"
                            >
                              Correct
                            </button>
                          )
                        ) : null}
                        {r && showHistory ? <HistoryLink id={r.id} /> : null}
                      </td>
                    </tr>
                  ))}
                  {shiftEnd ? (
                    <tr className="border-b border-ink-200 bg-brand-50/60 text-xs">
                      <td colSpan={8} className="border-r border-ink-200 px-2 py-1 text-right font-semibold text-ink-700">
                        Shift {shiftEnd.label}
                      </td>
                      <td colSpan={6} className="numeric px-2 py-1 font-semibold text-ink-800">
                        <IoLine total={totals.byShift[shiftEnd.key]} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-ink-100 text-sm">
              <td colSpan={8} className="border-r border-ink-200 px-2 py-2 text-right font-bold text-ink-800">
                24 hours
              </td>
              <td colSpan={6} className="numeric px-2 py-2 font-bold text-ink-900">
                <IoLine total={totals.day} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Totals on the phone. */}
      <section className="rounded-xl bg-white ring-1 ring-ink-200 md:hidden" aria-labelledby="io-heading">
        <h2
          id="io-heading"
          className="border-b border-ink-100 px-4 py-2 text-sm font-semibold uppercase tracking-wide text-ink-500"
        >
          Intake and output
        </h2>
        <dl className="divide-y divide-ink-100 text-sm">
          {SHIFTS.map((shift) => (
            <div key={shift.key} className="flex justify-between gap-3 px-4 py-2">
              <dt className="text-ink-600">{shift.label}</dt>
              <dd className="numeric text-right text-ink-900">
                <IoLine total={totals.byShift[shift.key]} />
              </dd>
            </div>
          ))}
          <div className="flex justify-between gap-3 px-4 py-2 font-bold">
            <dt className="text-ink-800">24 hours</dt>
            <dd className="numeric text-right text-ink-900">
              <IoLine total={totals.day} />
            </dd>
          </div>
        </dl>
      </section>

      {voided.length > 0 ? (
        <details className="rounded-xl bg-white ring-1 ring-ink-200">
          <summary className="min-h-12 cursor-pointer px-4 py-3 text-sm font-semibold text-ink-700">
            Corrected readings ({voided.length})
          </summary>
          <ul className="divide-y divide-ink-100 border-t border-ink-100 text-sm">
            {voided.map((v) => (
              <li key={v.id} className="px-4 py-2">
                <p className="text-ink-500 line-through">
                  {time.format(new Date(v.observedAt))} · {v.summary}
                </p>
                <p className="text-ink-600">Reason: {v.voidReason}</p>
                {showHistory ? <HistoryLink id={v.id} /> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canChart || confirmation ? (
        <div className="fixed inset-x-3 bottom-3 z-30 mx-auto max-w-xl space-y-2 mb-[env(safe-area-inset-bottom)]">
          {confirmation ? (
            <ConfirmationBar
              confirmation={confirmation}
              now={now}
              onUndo={(id) => void undo(id)}
              onClose={() => setConfirmation(null)}
            />
          ) : null}
          {canChart ? (
            <Button type="button" variant="primary" size="xl" className="w-full shadow-lg" onClick={() => setOpen(true)}>
              <PlusIcon className="size-5" />
              Add reading
            </Button>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <TprEntrySheet
          patientLabel={patientLabel}
          last={last}
          saving={saving}
          onSave={(r, m) => void save(r, m)}
          onClose={() => setOpen(false)}
        />
      ) : null}

      {correcting ? (
        <CorrectSheet
          reading={correcting}
          timeText={time.format(new Date(correcting.observedAt))}
          onCorrect={(reason) => correct(correcting.id, reason)}
          onClose={() => setCorrecting(null)}
        />
      ) : null}
    </div>
  );
}

function HistoryLink({ id, large = false }: { id: string; large?: boolean }) {
  return (
    <Link
      href={`/accountability/record/chart_entry/${id}`}
      className={cn(
        'font-semibold text-ink-500 hover:text-brand-800 hover:underline',
        large ? 'inline-flex min-h-11 items-center rounded-lg px-3 text-sm' : 'ml-2 inline-flex min-h-8 items-center text-xs',
      )}
    >
      History
    </Link>
  );
}

function ReadingLine({ reading }: { reading: ChartReading }) {
  const cells = vitalCells(reading);
  const fluids = [...OUTPUT_COLUMNS, ...INTAKE_COLUMNS].filter((c) => reading[c.key] !== null);
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-base">
        {VITAL_ORDER.filter(([key]) => cells[key]).map(([key, label]) => {
          const cell = cells[key]!;
          return (
            <span key={key} className={cn('numeric', cell.flag ? 'font-bold text-rose-800' : 'text-ink-900')}>
              <span className="text-sm font-normal text-ink-500">{label} </span>
              {cell.text}
              {cell.flag ? <span className="ml-0.5 text-xs">{cell.flag === 'high' ? 'High' : 'Low'}</span> : null}
            </span>
          );
        })}
      </p>
      {fluids.length > 0 ? (
        <p className="numeric text-sm text-ink-700">{fluids.map((c) => `${c.label} ${reading[c.key]} ml`).join(' · ')}</p>
      ) : null}
      {reading.onOxygen || reading.consciousness ? (
        <p className="text-sm text-ink-600">
          {[reading.onOxygen ? 'On oxygen' : null, reading.consciousness ? CONSCIOUSNESS_LABELS[reading.consciousness] : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {reading.note ? <p className="text-sm italic text-ink-600">{reading.note}</p> : null}
    </div>
  );
}

function IoLine({ total }: { total: IoTotal }) {
  const sign = total.balanceMl > 0 ? '+' : '';
  return (
    <>
      In {total.intakeMl} · Out {total.outputMl} · Balance {sign}
      {total.balanceMl} ml
    </>
  );
}

const CORRECT_REASONS = ['Typing mistake', 'Wrong patient', 'Wrong time', 'Duplicate'] as const;

function CorrectSheet({
  reading,
  timeText,
  onCorrect,
  onClose,
}: {
  reading: ChartReading;
  timeText: string;
  onCorrect: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="correct-title"
    >
      <button type="button" aria-label="Close" className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p id="correct-title" className="text-xl font-bold text-ink-900">
              Correct this reading
            </p>
            <p className="text-sm text-ink-500">
              {timeText} · {readingSummary(reading)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-3 text-ink-500 hover:bg-ink-100" aria-label="Close">
            <XIcon className="size-5" />
          </button>
        </div>
        <p className="mt-2 text-sm text-ink-600">
          It will be struck through, not deleted, with your name and the reason. Then add the right reading if there is one.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          {CORRECT_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reason === r}
              onClick={() => setReason(r)}
              className={cn(
                'min-h-12 rounded-lg px-2 text-sm font-semibold',
                reason === r ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700',
              )}
            >
              {r}
            </button>
          ))}
        </div>
        <label className="mt-3 block">
          <span className="text-sm font-medium text-ink-700">Or say why</span>
          <input
            value={CORRECT_REASONS.includes(reason as (typeof CORRECT_REASONS)[number]) ? '' : reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            className="mt-1 block h-12 w-full rounded-lg border-0 px-3 text-base ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />
        </label>
        <Button
          type="button"
          variant="primary"
          size="xl"
          className="mt-4 w-full"
          disabled={reason.trim().length < 3}
          isLoading={busy}
          onClick={async () => {
            setBusy(true);
            await onCorrect(reason.trim());
            setBusy(false);
          }}
        >
          Strike through
        </Button>
      </div>
    </div>
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
  const secondsLeft = confirmation.kind === 'saved' ? Math.max(0, Math.ceil((confirmation.undoUntil - now) / 1000)) : 0;
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-white shadow-lg',
        confirmation.kind === 'saved' ? 'bg-emerald-700' : confirmation.kind === 'queued' ? 'bg-amber-600' : 'bg-ink-800',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {confirmation.kind === 'saved' ? <CheckIcon className="size-5 shrink-0" /> : null}
        {confirmation.kind === 'queued' ? <WifiOffIcon className="size-5 shrink-0" /> : null}
        <p className="min-w-0 text-sm font-semibold">
          {confirmation.kind === 'saved' ? `Saved · ${confirmation.text}` : null}
          {confirmation.kind === 'queued' ? `Saved on this phone — will sync · ${confirmation.text}` : null}
          {confirmation.kind === 'info' ? confirmation.text : null}
        </p>
      </div>
      {confirmation.kind === 'saved' && secondsLeft > 0 ? (
        <button
          type="button"
          onClick={() => onUndo(confirmation.entryId)}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg bg-white/15 px-3 text-sm font-bold hover:bg-white/25"
        >
          <UndoIcon className="size-4" />
          Undo{' '}
          <span className="numeric font-normal opacity-80">
            {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
          </span>
        </button>
      ) : (
        <button type="button" onClick={onClose} className="shrink-0 rounded-lg p-2 hover:bg-white/15" aria-label="Dismiss">
          <XIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
