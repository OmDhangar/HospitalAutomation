'use client';

import { useId, useMemo, useState } from 'react';
import { Button, cn } from '@/components/ui';
import { XIcon } from '@/components/icons';
import { GIVEN_AT_OPTIONS } from '@/lib/domain/care-entry';
import {
  CONSCIOUSNESS_LABELS,
  CONSCIOUSNESS_LEVELS,
  INTAKE_COLUMNS,
  OUTPUT_COLUMNS,
  TprInputError,
  flagOf,
  formatTemperature,
  hasAnyValue,
  parseTemperature,
  type Consciousness,
  type FluidKey,
  type TprEntryInput,
} from '@/lib/domain/tpr';

/**
 * One line of the T.P.R. chart, typed on a phone (IPD sheets plan B1): the
 * fields in the paper's order, a number pad for each, the time it was taken,
 * and one Save. Every field may be left empty; at least one must be filled.
 *
 * The last reading shows as a faint hint in each box, so the nurse sees at a
 * glance whether a value has moved. Values outside the adult range say "High"
 * or "Low" in words as well as colour.
 */

export type LastValues = {
  pulse: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  spo2: number | null;
  tempFTenths: number | null;
  bslMgDl: number | null;
  respRate: number | null;
  abdGirthCm: number | null;
  onOxygen: boolean | null;
};

type Draft = {
  pulse: string;
  bpSystolic: string;
  bpDiastolic: string;
  spo2: string;
  temp: string;
  bsl: string;
  rr: string;
  abdGirth: string;
  fluids: Record<FluidKey, string>;
  onOxygen: boolean | null;
  consciousness: Consciousness | null;
  note: string;
};

const EMPTY: Draft = {
  pulse: '',
  bpSystolic: '',
  bpDiastolic: '',
  spo2: '',
  temp: '',
  bsl: '',
  rr: '',
  abdGirth: '',
  fluids: { drainMl: '', urineMl: '', rtAspirateMl: '', oralMl: '', ivMl: '' },
  onOxygen: null,
  consciousness: null,
  note: '',
};

/** The reading the phone sends, built from the boxes; throws a plain-English error for a slip. */
function toReading(draft: Draft): Omit<TprEntryInput, 'clientId' | 'admissionId' | 'observedAt'> {
  const whole = (raw: string, label: string, min: number, max: number): number | undefined => {
    const text = raw.trim();
    if (text === '') return undefined;
    if (!/^\d{1,4}$/.test(text)) throw new TprInputError(`${label}: type a whole number`);
    const value = Number(text);
    if (value < min || value > max) throw new TprInputError(`${label} ${value} is outside ${min}–${max}. Check it.`);
    return value;
  };
  const reading: Omit<TprEntryInput, 'clientId' | 'admissionId' | 'observedAt'> = {
    pulse: whole(draft.pulse, 'Pulse', 20, 250),
    spo2: whole(draft.spo2, 'SpO2', 40, 100),
    bslMgDl: whole(draft.bsl, 'BSL', 10, 900),
    respRate: whole(draft.rr, 'R.R.', 4, 80),
    abdGirthCm: whole(draft.abdGirth, 'Abd girth', 20, 250),
  };
  const systolic = whole(draft.bpSystolic, 'B.P. (upper)', 40, 300);
  const diastolic = whole(draft.bpDiastolic, 'B.P. (lower)', 20, 200);
  if ((systolic === undefined) !== (diastolic === undefined)) throw new TprInputError('Give both numbers of the B.P.');
  if (systolic !== undefined && diastolic !== undefined) {
    if (systolic <= diastolic) throw new TprInputError('The first B.P. number must be the higher one');
    reading.bpSystolic = systolic;
    reading.bpDiastolic = diastolic;
  }
  const temp = parseTemperature(draft.temp);
  if (temp !== null) reading.tempFTenths = temp;
  for (const column of [...OUTPUT_COLUMNS, ...INTAKE_COLUMNS]) {
    const value = whole(draft.fluids[column.key], `${column.label} (ml)`, 0, 5000);
    if (value !== undefined) reading[column.key] = value;
  }
  if (draft.consciousness) reading.consciousness = draft.consciousness;
  if (draft.note.trim()) reading.note = draft.note.trim();
  // The oxygen tick alone is not a reading: it rides along with a value.
  if (draft.onOxygen !== null && hasAnyValue(reading)) reading.onOxygen = draft.onOxygen;
  for (const key of Object.keys(reading) as (keyof typeof reading)[]) {
    if (reading[key] === undefined) delete reading[key];
  }
  return reading;
}

export function TprEntrySheet({
  patientLabel,
  last,
  saving,
  onSave,
  onClose,
}: {
  patientLabel: string;
  last: LastValues | null;
  saving: boolean;
  onSave: (reading: Omit<TprEntryInput, 'clientId' | 'admissionId' | 'observedAt'>, minutesAgo: number) => void;
  onClose: () => void;
}) {
  // Oxygen carries forward from the last reading (plan §13), shown as such.
  const [draft, setDraft] = useState<Draft>(() => ({
    ...EMPTY,
    onOxygen: last?.onOxygen ?? null,
  }));
  const [minutesAgo, setMinutesAgo] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const [showIo, setShowIo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setError(null);
  };
  const setFluid = (key: FluidKey, value: string) => {
    setDraft((d) => ({ ...d, fluids: { ...d.fluids, [key]: value } }));
    setError(null);
  };

  // Live High/Low beside each box, from what has been typed so far.
  const flags = useMemo(() => {
    const n = (raw: string) => (/^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : null);
    let tempTenths: number | null = null;
    try {
      tempTenths = parseTemperature(draft.temp);
    } catch {
      tempTenths = null;
    }
    return {
      pulse: flagOf('pulse', n(draft.pulse)),
      bp: flagOf('bpSystolic', n(draft.bpSystolic)) ?? flagOf('bpDiastolic', n(draft.bpDiastolic)),
      spo2: flagOf('spo2', n(draft.spo2)),
      temp: flagOf('tempFTenths', tempTenths),
      bsl: flagOf('bslMgDl', n(draft.bsl)),
      rr: flagOf('respRate', n(draft.rr)),
      tempTenths,
    };
  }, [draft]);

  const save = () => {
    try {
      const reading = toReading(draft);
      if (!hasAnyValue(reading)) {
        setError('Type at least one reading');
        return;
      }
      onSave(reading, minutesAgo);
    } catch (err) {
      setError(err instanceof TprInputError ? err.message : 'Check the values');
    }
  };

  const ioFilled = Object.values(draft.fluids).some((v) => v.trim() !== '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button type="button" aria-label="Close" className="absolute inset-0" onClick={onClose} />
      <div className="relative max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={titleId} className="text-xl font-bold text-ink-900">
              T.P.R. reading
            </p>
            <p className="truncate text-sm text-ink-500">{patientLabel}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-3 text-ink-500 hover:bg-ink-100" aria-label="Close">
            <XIcon className="size-5" />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
          <NumberBox
            label="Pulse"
            unit="/min"
            value={draft.pulse}
            onChange={(v) => set('pulse', v)}
            hint={last?.pulse}
            flag={flags.pulse}
          />
          <div>
            <span className="flex items-baseline justify-between text-sm font-medium text-ink-700">
              <span>
                B.P. <span className="font-normal text-ink-400">mmHg</span>
              </span>
              <FlagText flag={flags.bp} />
            </span>
            <div className="mt-1 flex items-center gap-1">
              <input
                aria-label="B.P. upper number"
                inputMode="numeric"
                enterKeyHint="next"
                value={draft.bpSystolic}
                onChange={(e) => set('bpSystolic', e.target.value)}
                placeholder={last?.bpSystolic ? String(last.bpSystolic) : ''}
                className={boxClass(flags.bp)}
              />
              <span className="text-xl text-ink-400" aria-hidden="true">
                /
              </span>
              <input
                aria-label="B.P. lower number"
                inputMode="numeric"
                enterKeyHint="next"
                value={draft.bpDiastolic}
                onChange={(e) => set('bpDiastolic', e.target.value)}
                placeholder={last?.bpDiastolic ? String(last.bpDiastolic) : ''}
                className={boxClass(flags.bp)}
              />
            </div>
          </div>
          <NumberBox
            label="SpO2"
            unit="%"
            value={draft.spo2}
            onChange={(v) => set('spo2', v)}
            hint={last?.spo2}
            flag={flags.spo2}
          />
          <NumberBox
            label="Temp"
            unit="°F"
            decimal
            value={draft.temp}
            onChange={(v) => set('temp', v)}
            hint={last?.tempFTenths ? formatTemperature(last.tempFTenths) : null}
            flag={flags.temp}
            help={
              flags.tempTenths !== null && Number(draft.temp.replace(',', '.')) < 45
                ? `= ${formatTemperature(flags.tempTenths)} °F`
                : undefined
            }
          />
          <NumberBox
            label="BSL"
            unit="mg/dL"
            value={draft.bsl}
            onChange={(v) => set('bsl', v)}
            hint={last?.bslMgDl}
            flag={flags.bsl}
          />
          <NumberBox
            label="R.R."
            unit="/min"
            value={draft.rr}
            onChange={(v) => set('rr', v)}
            hint={last?.respRate}
            flag={flags.rr}
          />
        </div>

        <Disclosure
          open={showMore}
          onToggle={() => setShowMore((v) => !v)}
          label="Abd girth, oxygen, consciousness"
          filled={Boolean(draft.abdGirth || draft.consciousness)}
        >
          <div className="grid grid-cols-2 gap-3">
            <NumberBox
              label="Abd girth"
              unit="cm"
              value={draft.abdGirth}
              onChange={(v) => set('abdGirth', v)}
              hint={last?.abdGirthCm}
              flag={null}
            />
            <div>
              <span className="text-sm font-medium text-ink-700">On oxygen</span>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                {([true, false] as const).map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    aria-pressed={draft.onOxygen === value}
                    onClick={() => set('onOxygen', draft.onOxygen === value ? null : value)}
                    className={cn(
                      'min-h-12 rounded-lg text-sm font-semibold',
                      draft.onOxygen === value ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700',
                    )}
                  >
                    {value ? 'Yes' : 'No'}
                  </button>
                ))}
              </div>
              {last?.onOxygen !== null && last?.onOxygen !== undefined && draft.onOxygen === last.onOxygen ? (
                <p className="mt-1 text-xs text-ink-500">As last time</p>
              ) : null}
            </div>
          </div>
          <fieldset className="mt-3">
            <legend className="mb-1 text-sm font-medium text-ink-700">Consciousness</legend>
            <div className="grid grid-cols-5 gap-1.5">
              {CONSCIOUSNESS_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={draft.consciousness === level}
                  title={CONSCIOUSNESS_LABELS[level]}
                  onClick={() => set('consciousness', draft.consciousness === level ? null : level)}
                  className={cn(
                    'min-h-12 rounded-lg text-base font-bold',
                    draft.consciousness === level ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700',
                  )}
                >
                  {level}
                </button>
              ))}
            </div>
            {draft.consciousness ? (
              <p className="mt-1 text-xs text-ink-600">{CONSCIOUSNESS_LABELS[draft.consciousness]}</p>
            ) : null}
          </fieldset>
        </Disclosure>

        <Disclosure open={showIo} onToggle={() => setShowIo((v) => !v)} label="Intake and output (ml)" filled={ioFilled}>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Output</p>
          <div className="grid grid-cols-3 gap-2">
            {OUTPUT_COLUMNS.map((column) => (
              <NumberBox
                key={column.key}
                label={column.label}
                unit="ml"
                value={draft.fluids[column.key]}
                onChange={(v) => setFluid(column.key, v)}
                hint={null}
                flag={null}
              />
            ))}
          </div>
          <p className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-ink-500">Intake</p>
          <div className="grid grid-cols-3 gap-2">
            {INTAKE_COLUMNS.map((column) => (
              <NumberBox
                key={column.key}
                label={column.label}
                unit="ml"
                value={draft.fluids[column.key]}
                onChange={(v) => setFluid(column.key, v)}
                hint={null}
                flag={null}
              />
            ))}
          </div>
        </Disclosure>

        <label className="mt-3 block">
          <span className="text-sm font-medium text-ink-700">Note (optional)</span>
          <input
            value={draft.note}
            maxLength={200}
            onChange={(e) => set('note', e.target.value)}
            placeholder="e.g. Patient sleeping, fever spike"
            className="mt-1 block h-12 w-full rounded-lg border-0 px-3 text-base ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 focus:outline-none"
          />
        </label>

        <fieldset className="mt-3">
          <legend className="mb-1 text-sm font-medium text-ink-700">Taken at</legend>
          <div className="grid grid-cols-4 gap-1.5">
            {GIVEN_AT_OPTIONS.map((option) => (
              <button
                key={option.minutesAgo}
                type="button"
                aria-pressed={minutesAgo === option.minutesAgo}
                onClick={() => setMinutesAgo(option.minutesAgo)}
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

        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-900 ring-1 ring-rose-200">
            {error}
          </p>
        ) : null}

        <Button type="button" variant="primary" size="xl" className="mt-4 w-full" onClick={save} isLoading={saving}>
          Save reading
        </Button>
      </div>
    </div>
  );
}

const boxClass = (flag: 'low' | 'high' | null) =>
  cn(
    'numeric block h-12 w-full min-w-0 rounded-lg border-0 px-3 text-xl font-semibold text-ink-900 ring-1 ring-inset placeholder:font-normal placeholder:text-ink-300 focus:ring-2 focus:outline-none',
    flag ? 'bg-rose-50 ring-rose-400 focus:ring-rose-600' : 'ring-ink-300 focus:ring-brand-600',
  );

function FlagText({ flag }: { flag: 'low' | 'high' | null }) {
  if (!flag) return null;
  return <span className="text-xs font-bold uppercase text-rose-700">{flag === 'high' ? 'High' : 'Low'}</span>;
}

function NumberBox({
  label,
  unit,
  value,
  onChange,
  hint,
  flag,
  decimal = false,
  help,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  hint: number | string | null | undefined;
  flag: 'low' | 'high' | null;
  decimal?: boolean;
  help?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="flex items-baseline justify-between gap-1 text-sm font-medium text-ink-700">
        <span className="truncate">
          {label} <span className="font-normal text-ink-400">{unit}</span>
        </span>
        <FlagText flag={flag} />
      </span>
      <input
        aria-label={`${label} (${unit})`}
        inputMode={decimal ? 'decimal' : 'numeric'}
        enterKeyHint="next"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint !== null && hint !== undefined ? String(hint) : ''}
        className={cn('mt-1', boxClass(flag))}
      />
      {help ? <span className="mt-0.5 block text-xs text-ink-500">{help}</span> : null}
    </label>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
  filled,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  filled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 rounded-xl ring-1 ring-ink-200">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-12 w-full items-center justify-between px-3 text-left text-sm font-semibold text-ink-800"
      >
        <span>
          {label}
          {filled && !open ? (
            <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-800">filled</span>
          ) : null}
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? <div className="border-t border-ink-100 p-3">{children}</div> : null}
    </div>
  );
}
