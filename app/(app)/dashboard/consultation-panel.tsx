'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import {
  openConsultationDynamic,
  patientHistoryDynamic,
  repeatLastPrescriptionDynamic,
  saveConsultationDraftDynamic,
  saveConsultationDynamic,
} from './consultation-actions';
import { useRegisterConsultationGate } from '@/components/clinical/consultation-gate';
import { MedicinePicker } from '@/components/clinical/medicine-picker';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, Input, cn } from '@/components/ui';
import {
  DURATION_PRESETS,
  FREQUENCY_PRESETS,
  INSTRUCTION_PRESETS,
  isEmptyConsultation,
  type ConsultationDraft,
  type DraftLine,
} from '@/lib/domain/consultation';
import type { ConsultationView, HistoryVisit } from '@/lib/services/consultations';

/**
 * The doctor's consultation screen for the patient in the room: diagnosis,
 * notes and prescription on one card, under Now Serving.
 *
 * How it keeps the doctor's work safe:
 *   - Every edit is autosaved as a draft (1.5 s after typing stops). A draft is
 *     scratch space on the server, not part of the record, so closing the tab
 *     or switching to a tablet loses nothing.
 *   - Save writes the record. "Complete & Call Next" saves first, through the
 *     consultation gate, and does not advance the queue if saving fails.
 *   - After Save the record is shown read-only. Revise reopens it; saving a
 *     revision supersedes the earlier prescription rather than editing it.
 *
 * The panel loads its data itself when the patient changes and never reads it
 * from the page's props again, so the dashboard's 10-second auto-refresh can
 * never overwrite what the doctor is typing.
 *
 * No prices appear anywhere here, by design: this is clinical documentation.
 */

const EMPTY: ConsultationDraft = { diagnosis: '', notes: '', items: [], advice: '', followUpOn: null };
const AUTOSAVE_MS = 1500;

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'error'; message: string }
  | { kind: 'conflict' };

const toDraft = (saved: NonNullable<ConsultationView['saved']>): ConsultationDraft => ({
  diagnosis: saved.diagnosis,
  notes: saved.notes,
  items: saved.items,
  advice: saved.advice,
  followUpOn: saved.followUpOn,
});

/** Local calendar date as YYYY-MM-DD, `days` from today. */
const dateFromToday = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
};

const formatDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export function ConsultationPanel({
  appointmentId,
  isEmergency = false,
}: {
  appointmentId: string;
  isEmergency?: boolean;
}) {
  const toast = useToast();
  const [view, setView] = useState<ConsultationView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<ConsultationDraft>(EMPTY);
  const [mode, setMode] = useState<'editing' | 'saved'>('editing');
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [editCount, setEditCount] = useState(0);
  const [history, setHistory] = useState<HistoryVisit[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isSaving, startSaving] = useTransition();
  const [isFetching, startFetching] = useTransition();

  // Refs hold what callbacks need to see immediately, without waiting for a
  // re-render: the latest text, the draft version, and whether anything has
  // changed since the record was last saved.
  const formRef = useRef<ConsultationDraft>(EMPTY);
  const versionRef = useRef<number | null>(null);
  const unsavedRef = useRef(false);
  const inFlightRef = useRef(false);
  const againRef = useRef(false);

  const encounterId = view?.encounterId ?? null;
  const canWrite = view?.canWrite ?? false;

  const load = useCallback(async () => {
    const res = await openConsultationDynamic({ appointmentId });
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    const next = res.view;
    const content = next.draft?.content ?? (next.saved ? toDraft(next.saved) : EMPTY);
    formRef.current = content;
    versionRef.current = next.draft?.version ?? null;
    // A leftover draft is unsaved work from an earlier sitting.
    unsavedRef.current = next.draft !== null;
    setView(next);
    setForm(content);
    setMode(next.saved && !next.draft ? 'saved' : 'editing');
    setLoadError(null);
  }, [appointmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One code path for every edit, so the ref and the autosave never miss one. */
  const update = (recipe: (current: ConsultationDraft) => ConsultationDraft) => {
    const next = recipe(formRef.current);
    formRef.current = next;
    unsavedRef.current = true;
    setForm(next);
    setEditCount((n) => n + 1);
  };

  /**
   * Writes the draft. Never two at once: an edit that arrives while a save is
   * in flight marks "again", and the save that finishes starts the next one
   * with the newest text and the version it just got back.
   */
  const persistDraft = useCallback(
    async function persist(): Promise<void> {
      if (!encounterId) return;
      if (inFlightRef.current) {
        againRef.current = true;
        return;
      }
      inFlightRef.current = true;
      againRef.current = false;
      setSaveState({ kind: 'saving' });
      const res = await saveConsultationDraftDynamic({
        encounterId,
        content: formRef.current,
        expectedVersion: versionRef.current,
      });
      inFlightRef.current = false;
      if (res.ok) {
        versionRef.current = res.version;
        setSaveState({ kind: 'saved', at: new Date() });
        if (againRef.current) await persist();
      } else if (res.conflict) {
        setSaveState({ kind: 'conflict' });
      } else {
        setSaveState({ kind: 'error', message: res.error });
      }
    },
    [encounterId],
  );

  useEffect(() => {
    if (!canWrite || mode !== 'editing' || editCount === 0) return;
    const timer = setTimeout(() => void persistDraft(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [editCount, canWrite, mode, persistDraft]);

  /**
   * Writes the consultation into the patient's record. With `print`, a tab is
   * opened in the same click — browsers block tabs opened after an await —
   * and pointed at the printable prescription once it exists.
   */
  const commit = useCallback(
    async (print: boolean): Promise<boolean> => {
      if (!encounterId) return false;
      const printTab = print ? window.open('about:blank', '_blank') : null;
      const f = formRef.current;
      setSaveState({ kind: 'saving' });
      const res = await saveConsultationDynamic({
        encounterId,
        input: {
          diagnosis: f.diagnosis,
          notes: f.notes,
          advice: f.advice,
          followUpOn: f.followUpOn,
          // The label is display-only; the server snapshots names from the catalogue.
          items: f.items.map((item) => ({
            medicineId: item.medicineId,
            dose: item.dose,
            frequency: item.frequency,
            durationDays: item.durationDays,
            instructions: item.instructions,
          })),
        },
      });
      if (!res.ok) {
        printTab?.close();
        setSaveState({ kind: 'error', message: res.error });
        toast.error('Consultation not saved', res.error);
        return false;
      }
      unsavedRef.current = false;
      versionRef.current = null;
      if (printTab) {
        if (res.prescriptionId) printTab.location.href = `/print/prescription/${res.prescriptionId}`;
        else {
          printTab.close();
          toast.info('Nothing to print', 'This visit has no prescription.');
        }
      }
      toast.success('Consultation saved');
      await load();
      return true;
    },
    [encounterId, load, toast],
  );

  /** Run by "Complete & Call Next": save anything unsaved, or say why not. */
  const gate = useCallback(async () => {
    if (!canWrite || !unsavedRef.current) return true;
    // Cleared everything while revising: keep the saved record as it was.
    if (isEmptyConsultation(formRef.current)) return true;
    return commit(false);
  }, [canWrite, commit]);
  useRegisterConsultationGate(gate);

  /* ------------------------------------------------------------ editing */

  const addLine = (line: DraftLine) => {
    if (formRef.current.items.some((item) => item.medicineId === line.medicineId)) {
      toast.info('Already added', `${line.medicineLabel} is already on this prescription.`);
      return;
    }
    update((f) => ({ ...f, items: [...f.items, line] }));
  };

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    update((f) => ({ ...f, items: f.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) }));

  const removeLine = (index: number) =>
    update((f) => ({ ...f, items: f.items.filter((_, i) => i !== index) }));

  const repeatLast = () => {
    if (!encounterId) return;
    startFetching(async () => {
      const res = await repeatLastPrescriptionDynamic({ encounterId });
      if (!res.ok) return toast.error('Could not repeat', res.error);
      if (!res.last) return toast.info('No earlier prescription', 'This patient has none on record.');
      const existing = new Set(formRef.current.items.map((item) => item.medicineId));
      const fresh = res.last.items.filter((item) => !existing.has(item.medicineId));
      update((f) => ({ ...f, items: [...f.items, ...fresh] }));
      toast.success(
        `Copied ${fresh.length} medicine${fresh.length === 1 ? '' : 's'}`,
        res.last.skipped.length
          ? `Left out, no longer offered: ${res.last.skipped.join(', ')}`
          : `From ${formatDate(res.last.fromDate)}, ${res.last.doctorName}. Check the doses.`,
      );
    });
  };

  const toggleHistory = () => {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    if (!opening || history || !encounterId) return;
    startFetching(async () => {
      const res = await patientHistoryDynamic({ encounterId });
      if (res.ok) setHistory(res.visits);
      else toast.error('Could not load earlier visits', res.error);
    });
  };

  /* ------------------------------------------------------------ render */

  if (loadError) {
    return (
      <Card>
        <CardHeader title="Consultation" />
        <div className="p-4 text-sm text-rose-800 sm:p-6">
          {loadError}{' '}
          <button type="button" onClick={() => void load()} className="font-semibold underline">
            Try again
          </button>
        </div>
      </Card>
    );
  }

  if (!view) {
    return (
      <Card>
        <CardHeader title="Consultation" hint="Loading…" />
        <div className="h-40 animate-pulse bg-ink-50" />
      </Card>
    );
  }

  const patientLine = [
    view.patient.name,
    view.patient.age ? `${view.patient.age}y` : null,
    view.patient.gender,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card>
      <CardHeader
        title="Consultation"
        hint={patientLine}
        action={
          <div className="flex items-center gap-3">
            <SaveIndicator state={saveState} onReload={() => void load()} />
            {view.hasEarlierVisits ? (
              <Button type="button" size="sm" variant="secondary" onClick={toggleHistory}>
                {historyOpen ? 'Hide earlier visits' : 'Earlier visits'}
              </Button>
            ) : null}
          </div>
        }
      />

      {isEmergency ? (
        <div className="flex items-center justify-between gap-3 border-y border-red-300 bg-red-600 px-4 py-3 text-white sm:px-6 shadow-inner animate-pulse">
          <div className="flex items-center gap-2.5">
            <span className="flex size-3 rounded-full bg-white shadow-sm" />
            <span className="text-sm font-black tracking-wider uppercase">
              🚨 EMERGENCY ADMISSION — PRIORITY CLINICAL ATTENTION
            </span>
          </div>
          <span className="rounded-md bg-white/20 px-2 py-0.5 text-xs font-bold tracking-wide uppercase">
            Emergency Case
          </span>
        </div>
      ) : null}

      {historyOpen ? <HistoryList visits={history} loading={isFetching && !history} /> : null}

      {!canWrite ? (
        <div className="space-y-4 p-4 sm:p-6">
          <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-300">
            {view.cannotWriteReason}
          </p>
          {view.saved ? <SavedSummary saved={view.saved} /> : null}
        </div>
      ) : mode === 'saved' && view.saved ? (
        <div className="space-y-4 p-4 sm:p-6">
          <SavedSummary saved={view.saved} />
          <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-4">
            {view.saved.prescriptionId ? (
              <a
                href={`/print/prescription/${view.saved.prescriptionId}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Print prescription
              </a>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => setMode('editing')}>
              Revise
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5 p-4 sm:p-6">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-700">Diagnosis</span>
            <Input
              value={form.diagnosis}
              onChange={(e) => update((f) => ({ ...f, diagnosis: e.target.value }))}
              placeholder="e.g. Viral fever"
              maxLength={300}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-700">Notes</span>
            <textarea
              value={form.notes}
              onChange={(e) => update((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
              maxLength={4000}
              placeholder="Complaints, findings"
              className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-600"
            />
          </label>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink-700">Prescription</span>
              {view.hasEarlierVisits ? (
                <Button type="button" size="sm" variant="ghost" onClick={repeatLast} isLoading={isFetching}>
                  ↻ Repeat last prescription
                </Button>
              ) : null}
            </div>

            {form.items.length > 0 ? (
              <ol className="space-y-2">
                {form.items.map((line, index) => (
                  <PrescriptionLineEditor
                    key={line.medicineId}
                    line={line}
                    onChange={(patch) => setLine(index, patch)}
                    onRemove={() => removeLine(index)}
                  />
                ))}
              </ol>
            ) : null}

            <MedicinePicker
              canQuickAdd
              onPick={(medicine) =>
                addLine({
                  medicineId: medicine.id,
                  medicineLabel: medicine.label,
                  dose: '',
                  frequency: '',
                  durationDays: null,
                  instructions: '',
                })
              }
            />

            {view.frequent.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-ink-500">Frequent:</span>
                {view.frequent.map((line) => (
                  <button
                    key={line.medicineId}
                    type="button"
                    onClick={() => addLine(line)}
                    title={`${line.dose} · ${line.frequency}${line.durationDays ? ` · ${line.durationDays} days` : ''}`}
                    className="rounded-full bg-ink-100 px-3 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-brand-50 hover:text-brand-900"
                  >
                    + {line.medicineLabel}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink-700">Advice</span>
              <textarea
                value={form.advice}
                onChange={(e) => update((f) => ({ ...f, advice: e.target.value }))}
                rows={2}
                maxLength={1000}
                placeholder="Plenty of fluids, rest"
                className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-600"
              />
            </label>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-ink-700">Follow-up</span>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: '3 days', days: 3 },
                  { label: '1 week', days: 7 },
                  { label: '2 weeks', days: 14 },
                  { label: '1 month', days: 30 },
                ].map((option) => {
                  const value = dateFromToday(option.days);
                  return (
                    <button
                      key={option.days}
                      type="button"
                      onClick={() => update((f) => ({ ...f, followUpOn: value }))}
                      className={cn(
                        'rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition-colors',
                        form.followUpOn === value
                          ? 'bg-brand-600 text-white ring-brand-600'
                          : 'bg-ink-50 text-ink-700 ring-ink-200 hover:bg-ink-100',
                      )}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  type="date"
                  aria-label="Follow-up date"
                  value={form.followUpOn ?? ''}
                  onChange={(e) => update((f) => ({ ...f, followUpOn: e.target.value || null }))}
                  className="max-w-44"
                />
                {form.followUpOn ? (
                  <button
                    type="button"
                    onClick={() => update((f) => ({ ...f, followUpOn: null }))}
                    className="text-xs text-ink-500 underline"
                  >
                    No follow-up
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-ink-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-ink-500">
              Saved automatically as you type. &ldquo;Complete&rdquo; saves it to the patient&apos;s record.
            </p>
            <div className="flex gap-2">
              {view.saved ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    formRef.current = toDraft(view.saved!);
                    unsavedRef.current = false;
                    setForm(formRef.current);
                    setMode('saved');
                  }}
                >
                  Cancel revision
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                isLoading={isSaving}
                onClick={() => startSaving(async () => void (await commit(false)))}
              >
                Save
              </Button>
              <Button
                type="button"
                variant="primary"
                isLoading={isSaving}
                onClick={() => startSaving(async () => void (await commit(true)))}
              >
                Save &amp; print
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- pieces */

function PrescriptionLineEditor({
  line,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const isPresetFrequency = FREQUENCY_PRESETS.some((p) => p.value === line.frequency);
  const isPresetDuration =
    line.durationDays === null || (DURATION_PRESETS as readonly number[]).includes(line.durationDays);

  return (
    <li className="rounded-lg bg-ink-50/70 p-3 ring-1 ring-inset ring-ink-200">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-ink-900">{line.medicineLabel}</p>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${line.medicineLabel}`}
          className="rounded p-1 text-ink-400 hover:bg-ink-200 hover:text-ink-800"
        >
          ✕
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Input
          aria-label="Dose"
          value={line.dose}
          onChange={(e) => onChange({ dose: e.target.value })}
          placeholder="Dose, e.g. 1 tab"
          maxLength={60}
          autoFocus={line.dose === ''}
        />
        <select
          aria-label="How often"
          value={line.frequency}
          onChange={(e) => onChange({ frequency: e.target.value })}
          className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-600"
        >
          <option value="">How often?</option>
          {!isPresetFrequency && line.frequency ? <option value={line.frequency}>{line.frequency}</option> : null}
          {FREQUENCY_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.value} ({preset.hint})
            </option>
          ))}
        </select>
        <select
          aria-label="For how many days"
          value={line.durationDays ?? ''}
          onChange={(e) => onChange({ durationDays: e.target.value ? Number(e.target.value) : null })}
          className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-600"
        >
          <option value="">Days?</option>
          {!isPresetDuration ? <option value={line.durationDays!}>{line.durationDays} days</option> : null}
          {DURATION_PRESETS.map((days) => (
            <option key={days} value={days}>
              {days} days
            </option>
          ))}
        </select>
        <Input
          aria-label="Instructions"
          value={line.instructions}
          onChange={(e) => onChange({ instructions: e.target.value })}
          placeholder="e.g. After food"
          list="instruction-presets"
          maxLength={200}
        />
      </div>
      <datalist id="instruction-presets">
        {INSTRUCTION_PRESETS.map((preset) => (
          <option key={preset} value={preset} />
        ))}
      </datalist>
    </li>
  );
}

function SavedSummary({ saved }: { saved: NonNullable<ConsultationView['saved']> }) {
  return (
    <dl className="space-y-3 text-sm">
      {saved.diagnosis ? (
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">Diagnosis</dt>
          <dd className="text-ink-900">{saved.diagnosis}</dd>
        </div>
      ) : null}
      {saved.notes ? (
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">Notes</dt>
          <dd className="whitespace-pre-line text-ink-800">{saved.notes}</dd>
        </div>
      ) : null}
      {saved.items.length > 0 ? (
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">Prescription</dt>
          <dd>
            <ul className="mt-1 space-y-1">
              {saved.items.map((item) => (
                <li key={item.medicineId} className="text-ink-900">
                  <span className="font-medium">{item.medicineLabel}</span>
                  <span className="text-ink-600">
                    {' '}
                    — {item.dose}, {item.frequency}
                    {item.durationDays ? `, ${item.durationDays} days` : ''}
                    {item.instructions ? `, ${item.instructions}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
      {saved.advice ? (
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">Advice</dt>
          <dd className="whitespace-pre-line text-ink-800">{saved.advice}</dd>
        </div>
      ) : null}
      {saved.followUpOn ? (
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">Follow-up</dt>
          <dd className="text-ink-900">{formatDate(saved.followUpOn)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function HistoryList({ visits, loading }: { visits: HistoryVisit[] | null; loading: boolean }) {
  if (loading || !visits) {
    return <div className="border-b border-ink-200 p-4 text-sm text-ink-500 sm:px-6">Loading earlier visits…</div>;
  }
  if (visits.length === 0) {
    return <div className="border-b border-ink-200 p-4 text-sm text-ink-500 sm:px-6">No earlier visits recorded.</div>;
  }
  return (
    <ol className="max-h-80 divide-y divide-ink-100 overflow-y-auto border-b border-ink-200 bg-ink-50/50">
      {visits.map((visit) => (
        <li key={visit.encounterId} className="space-y-1 px-4 py-3 text-sm sm:px-6">
          <p className="font-semibold text-ink-900">
            {formatDate(visit.date)} <span className="font-normal text-ink-500">· {visit.doctorName}</span>
          </p>
          {visit.diagnosis ? <p className="text-ink-800">Diagnosis: {visit.diagnosis}</p> : null}
          {visit.prescription?.items.length ? (
            <ul className="text-ink-700">
              {visit.prescription.items.map((item, i) => (
                <li key={i}>
                  {item.label} — {item.dose}, {item.frequency}
                  {item.durationDays ? `, ${item.durationDays} days` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {visit.prescription?.followUpOn ? (
            <p className="text-xs text-ink-500">Follow-up {formatDate(visit.prescription.followUpOn)}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function SaveIndicator({ state, onReload }: { state: SaveState; onReload: () => void }) {
  if (state.kind === 'saving') return <span className="text-xs text-ink-500">Saving…</span>;
  if (state.kind === 'saved') {
    return (
      <span className="text-xs text-ink-500">
        Draft saved {state.at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
      </span>
    );
  }
  if (state.kind === 'conflict') {
    return (
      <button type="button" onClick={onReload} className="text-xs font-semibold text-amber-800 underline">
        Changed on another screen — reload
      </button>
    );
  }
  if (state.kind === 'error') {
    return (
      <span className="text-xs font-semibold text-amber-800" title={state.message}>
        Not saved — will retry on next edit
      </span>
    );
  }
  return null;
}
