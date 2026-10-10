import { z } from 'zod';
import { MAX_BATCH } from '@/lib/domain/care-entry';
import { serviceDateIn, zonedTimeToUtc } from '@/lib/domain/time';

/**
 * The nursing T.P.R. chart (IPD sheets plan, phase B1). Pure.
 *
 * The paper chart is one A4 sheet per day: rows are the hours from 8 am on
 * the front to 7 am on the back, columns are Pulse, B.P., SpO2, Temp, BSL,
 * R.R., Abd girth, Output (drain, urine, RT aspirate), Intake (oral, IV
 * fluid) and Treatment. The screen and the print keep that order and those
 * words, so a nurse finds everything where her pen would have put it.
 *
 * A chart day runs 8 am to 8 am, as the paper does: a reading at 7:30 am
 * belongs to the sheet started the morning before.
 */

export const TPR_TEMPLATE = { key: 'general_tpr', version: 1 } as const;

/* ------------------------------------------------------------- the columns */

export type VitalKey = 'pulse' | 'bp' | 'spo2' | 'temp' | 'bsl' | 'rr' | 'abdGirth';
export type FluidKey = 'drainMl' | 'urineMl' | 'rtAspirateMl' | 'oralMl' | 'ivMl';

/** Paper column order. */
export const VITAL_COLUMNS: readonly { key: VitalKey; label: string; unit: string }[] = [
  { key: 'pulse', label: 'Pulse', unit: '/min' },
  { key: 'bp', label: 'B.P.', unit: 'mmHg' },
  { key: 'spo2', label: 'SpO2', unit: '%' },
  { key: 'temp', label: 'Temp', unit: '°F' },
  { key: 'bsl', label: 'BSL', unit: 'mg/dL' },
  { key: 'rr', label: 'R.R.', unit: '/min' },
  { key: 'abdGirth', label: 'Abd girth', unit: 'cm' },
];

export const OUTPUT_COLUMNS: readonly { key: FluidKey; label: string }[] = [
  { key: 'drainMl', label: 'Drain' },
  { key: 'urineMl', label: 'Urine' },
  { key: 'rtAspirateMl', label: 'RT aspirate' },
];

export const INTAKE_COLUMNS: readonly { key: FluidKey; label: string }[] = [
  { key: 'oralMl', label: 'Oral' },
  { key: 'ivMl', label: 'IV fluid' },
];

export const CONSCIOUSNESS_LEVELS = ['A', 'C', 'V', 'P', 'U'] as const;
export type Consciousness = (typeof CONSCIOUSNESS_LEVELS)[number];
export const CONSCIOUSNESS_LABELS: Record<Consciousness, string> = {
  A: 'Alert',
  C: 'New confusion',
  V: 'Responds to voice',
  P: 'Responds to pain',
  U: 'Unresponsive',
};

/* ------------------------------------------------------------- typed input */

export class TprInputError extends Error {}

/**
 * Temperature as the nurse types it: "98.6" or "100" in °F, or "37.2" in °C
 * (anything under 45 is read as °C and converted), stored as °F × 10.
 */
export function parseTemperature(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (text === '') return null;
  if (!/^\d{2,3}(\.\d)?$/.test(text)) throw new TprInputError('Type the temperature like 98.6 (°F) or 37.0 (°C)');
  const value = Number(text);
  const fahrenheit = value < 45 ? value * 1.8 + 32 : value;
  const tenths = Math.round(fahrenheit * 10);
  if (tenths < 900 || tenths > 1100) throw new TprInputError('That temperature is outside 90–110 °F. Check it.');
  return tenths;
}

export const formatTemperature = (tenths: number): string => (tenths / 10).toFixed(1);

/** "120/80" (also "120 80" or "120-80"). */
export function parseBloodPressure(raw: string): { systolic: number; diastolic: number } | null {
  const text = raw.trim();
  if (text === '') return null;
  const match = /^(\d{2,3})\s*[/\s-]\s*(\d{2,3})$/.exec(text);
  if (!match) throw new TprInputError('Type the B.P. like 120/80');
  const systolic = Number(match[1]);
  const diastolic = Number(match[2]);
  if (systolic < 40 || systolic > 300 || diastolic < 20 || diastolic > 200 || systolic <= diastolic) {
    throw new TprInputError('That B.P. does not look right. Check it.');
  }
  return { systolic, diastolic };
}

const LIMITS = {
  pulse: [20, 250],
  spo2: [40, 100],
  bslMgDl: [10, 900],
  respRate: [4, 80],
  abdGirthCm: [20, 250],
  ml: [0, 5000],
} as const;

const int = (min: number, max: number) => z.number().int().min(min).max(max).optional();
const uuid = z.string().uuid();

/** One reading as the phone sends it: numbers already parsed on the device. Strict: no extra fields. */
export const tprEntrySchema = z
  .strictObject({
    clientId: uuid,
    admissionId: uuid,
    observedAt: z.iso.datetime({ offset: true }),
    pulse: int(...LIMITS.pulse),
    bpSystolic: int(40, 300),
    bpDiastolic: int(20, 200),
    spo2: int(...LIMITS.spo2),
    tempFTenths: int(900, 1100),
    bslMgDl: int(...LIMITS.bslMgDl),
    respRate: int(...LIMITS.respRate),
    abdGirthCm: int(...LIMITS.abdGirthCm),
    onOxygen: z.boolean().optional(),
    consciousness: z.enum(CONSCIOUSNESS_LEVELS).optional(),
    drainMl: int(...LIMITS.ml),
    urineMl: int(...LIMITS.ml),
    rtAspirateMl: int(...LIMITS.ml),
    oralMl: int(...LIMITS.ml),
    ivMl: int(...LIMITS.ml),
    note: z
      .string()
      .max(400)
      .transform((value) => value.trim().replace(/\s+/g, ' '))
      .pipe(z.string().max(200))
      .optional(),
  })
  .refine((entry) => (entry.bpSystolic === undefined) === (entry.bpDiastolic === undefined), {
    message: 'Give both numbers of the B.P.',
  })
  .refine((entry) => entry.bpSystolic === undefined || entry.bpSystolic > entry.bpDiastolic!, {
    message: 'The first B.P. number must be the higher one',
  })
  .refine((entry) => hasAnyValue(entry), { message: 'Type at least one reading' });

export type TprEntryInput = z.infer<typeof tprEntrySchema>;

export function hasAnyValue(entry: Partial<Record<string, unknown>>): boolean {
  return (
    [
      'pulse', 'bpSystolic', 'spo2', 'tempFTenths', 'bslMgDl', 'respRate', 'abdGirthCm', 'onOxygen',
      'consciousness', 'drainMl', 'urineMl', 'rtAspirateMl', 'oralMl', 'ivMl',
    ].some((key) => entry[key] !== undefined && entry[key] !== null) ||
    (typeof entry.note === 'string' && entry.note.trim() !== '')
  );
}

export const tprBatchSchema = z.strictObject({ entries: z.array(tprEntrySchema).min(1).max(MAX_BATCH) });

export function parseTprBatch(raw: unknown): { ok: true; entries: TprEntryInput[] } | { ok: false; error: string } {
  const parsed = tprBatchSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, error: `${where}${issue?.message ?? 'Invalid reading'}` };
  }
  return { ok: true, entries: parsed.data.entries };
}

/* ----------------------------------------------------------- normal ranges */

export type Flag = 'low' | 'high';

/**
 * Adult ranges, to draw the eye — never a diagnosis, and shown as text (H/L)
 * as well as colour. The early warning score (plan §7.5, module `ews`) is a
 * separate, doctor-approved thing.
 */
export const NORMAL_RANGES = {
  pulse: { low: 60, high: 100 },
  bpSystolic: { low: 90, high: 140 },
  bpDiastolic: { low: 60, high: 90 },
  spo2: { low: 94, high: null },
  // 100.0 °F and above is flagged: the pilot's notes record 100.0 °F as a fever spike.
  tempFTenths: { low: 968, high: 999 },
  bslMgDl: { low: 70, high: 180 },
  respRate: { low: 12, high: 20 },
} as const;

export function flagOf(key: keyof typeof NORMAL_RANGES, value: number | null | undefined): Flag | null {
  if (value === null || value === undefined) return null;
  const range = NORMAL_RANGES[key];
  if (value < range.low) return 'low';
  if (range.high !== null && value > range.high) return 'high';
  return null;
}

/* ----------------------------------------------------------- the chart day */

export const CHART_DAY_STARTS_AT = '08:00';

/** The chart day (the date on the paper sheet) a moment belongs to: before 8 am it is the day before. */
export function chartDayOf(at: Date, timezone: string): string {
  const date = serviceDateIn(timezone, at);
  return at.getTime() < zonedTimeToUtc(date, CHART_DAY_STARTS_AT, timezone).getTime() ? addDays(date, -1) : date;
}

/** The instants a chart day covers: 8 am that day to 8 am the next. */
export function chartDayWindow(day: string, timezone: string): { from: Date; to: Date } {
  return {
    from: zonedTimeToUtc(day, CHART_DAY_STARTS_AT, timezone),
    to: zonedTimeToUtc(addDays(day, 1), CHART_DAY_STARTS_AT, timezone),
  };
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export const isChartDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/** The local hour (0–23) of a moment in the hospital's timezone. */
export function localHour(at: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(at));
}

/** The paper's rows: the front of the sheet is 8 am–10 pm, the back 11 pm–7 am. */
export const FRONT_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] as const;
export const BACK_HOURS = [23, 0, 1, 2, 3, 4, 5, 6, 7] as const;
export const CHART_HOURS = [...FRONT_HOURS, ...BACK_HOURS] as const;

export function hourLabel(hour: number): string {
  if (hour === 0) return '12 am';
  if (hour === 12) return '12 pm';
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

/* ------------------------------------------------------- shifts and totals */

export type ShiftKey = 'morning' | 'evening' | 'night';

/** Default nursing shifts 8–2–8 (decision D-SHIFT); a hospital setting later. */
export const SHIFTS: readonly { key: ShiftKey; label: string; fromHour: number; toHour: number }[] = [
  { key: 'morning', label: '8 am – 2 pm', fromHour: 8, toHour: 14 },
  { key: 'evening', label: '2 pm – 8 pm', fromHour: 14, toHour: 20 },
  { key: 'night', label: '8 pm – 8 am', fromHour: 20, toHour: 8 },
];

export function shiftOf(hour: number): ShiftKey {
  if (hour >= 8 && hour < 14) return 'morning';
  if (hour >= 14 && hour < 20) return 'evening';
  return 'night';
}

export type FluidReading = Partial<Record<FluidKey, number | null>> & { hour: number };
export type IoTotal = { intakeMl: number; outputMl: number; balanceMl: number };

const sum = (values: (number | null | undefined)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** Intake and output by shift and for the 24-hour chart day, as nurses total them in the margin. */
export function ioTotals(readings: readonly FluidReading[]): { byShift: Record<ShiftKey, IoTotal>; day: IoTotal } {
  const total = (rows: readonly FluidReading[]): IoTotal => {
    const intakeMl = sum(rows.flatMap((r) => [r.oralMl, r.ivMl]));
    const outputMl = sum(rows.flatMap((r) => [r.urineMl, r.drainMl, r.rtAspirateMl]));
    return { intakeMl, outputMl, balanceMl: intakeMl - outputMl };
  };
  return {
    byShift: {
      morning: total(readings.filter((r) => shiftOf(r.hour) === 'morning')),
      evening: total(readings.filter((r) => shiftOf(r.hour) === 'evening')),
      night: total(readings.filter((r) => shiftOf(r.hour) === 'night')),
    },
    day: total(readings),
  };
}

/** Recorded more than 2 hours after it was taken: printed "late entry", as the paper convention asks. */
export const LATE_ENTRY_MS = 2 * 3_600_000;
export const isLateEntry = (observedAt: Date, recordedAt: Date): boolean =>
  recordedAt.getTime() - observedAt.getTime() > LATE_ENTRY_MS;

/* ------------------------------------------------------------ one-line text */

type SummaryInput = Partial<
  Record<'pulse' | 'bpSystolic' | 'bpDiastolic' | 'spo2' | 'tempFTenths' | 'bslMgDl' | 'respRate' | 'abdGirthCm' | FluidKey, number | null>
>;

/** A reading in one line, in paper order: "Pulse 82 · B.P. 110/70 · Temp 98.6 · Urine 400 ml". */
export function readingSummary(r: SummaryInput): string {
  const parts: string[] = [];
  const add = (label: string, value: number | null | undefined, text?: string) => {
    if (value !== null && value !== undefined) parts.push(`${label} ${text ?? value}`);
  };
  add('Pulse', r.pulse);
  add('B.P.', r.bpSystolic, `${r.bpSystolic}/${r.bpDiastolic}`);
  add('SpO2', r.spo2);
  add('Temp', r.tempFTenths, r.tempFTenths ? formatTemperature(r.tempFTenths) : undefined);
  add('BSL', r.bslMgDl);
  add('R.R.', r.respRate);
  add('Abd girth', r.abdGirthCm);
  for (const column of [...OUTPUT_COLUMNS, ...INTAKE_COLUMNS]) add(column.label, r[column.key], `${r[column.key]} ml`);
  return parts.join(' · ') || 'Note only';
}

/** What one paper box shows for a vital, with its flag; null when nothing was taken. */
export type VitalCell = { text: string; flag: Flag | null };

type CellInput = Partial<
  Record<'pulse' | 'bpSystolic' | 'bpDiastolic' | 'spo2' | 'tempFTenths' | 'bslMgDl' | 'respRate' | 'abdGirthCm', number | null>
>;

export function vitalCell(r: CellInput, key: VitalKey): VitalCell | null {
  const plain = (value: number | null | undefined, flag: Flag | null = null): VitalCell | null =>
    value === null || value === undefined ? null : { text: String(value), flag };
  switch (key) {
    case 'pulse':
      return plain(r.pulse, flagOf('pulse', r.pulse));
    case 'bp':
      return r.bpSystolic === null || r.bpSystolic === undefined
        ? null
        : { text: `${r.bpSystolic}/${r.bpDiastolic}`, flag: flagOf('bpSystolic', r.bpSystolic) ?? flagOf('bpDiastolic', r.bpDiastolic) };
    case 'spo2':
      return plain(r.spo2, flagOf('spo2', r.spo2));
    case 'temp':
      return r.tempFTenths === null || r.tempFTenths === undefined
        ? null
        : { text: formatTemperature(r.tempFTenths), flag: flagOf('tempFTenths', r.tempFTenths) };
    case 'bsl':
      return plain(r.bslMgDl, flagOf('bslMgDl', r.bslMgDl));
    case 'rr':
      return plain(r.respRate, flagOf('respRate', r.respRate));
    case 'abdGirth':
      return plain(r.abdGirthCm);
  }
}
