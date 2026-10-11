import { TprInputError, formatTemperature, parseBloodPressure, parseTemperature } from '@/lib/domain/tpr';

/**
 * The doctor's case sheet and progress notes (IPD sheets plan C3). Pure.
 *
 * The admission note follows the paper case sheet: Case of, C/O (each
 * complaint with how long), H/O, P/H, O/E (general signs and vitals), S/E
 * (CNS, RS, P/A, CVS), Adv. A progress note is what changed and what to do.
 * The O/E vitals come from a chart reading under 2 hours old when there is
 * one; a doctor who finds different values writes them, and the note then
 * puts one reading on the chart, so the two never disagree.
 */

export class NoteError extends Error {}

export const NOTE_KINDS = { admission: 'Admission note (case sheet)', progress: 'Progress note' } as const;
export type NoteKind = keyof typeof NOTE_KINDS;

export type Complaint = { text: string; duration: string | null };

export const GENERAL_SIGNS = {
  pallor: 'Pallor',
  icterus: 'Icterus',
  cyanosis: 'Cyanosis',
  clubbing: 'Clubbing',
  lymphadenopathy: 'Lymphadenopathy',
  oedema: 'Oedema',
} as const;
export type GeneralSign = keyof typeof GENERAL_SIGNS;
export type GeneralExam = Partial<Record<GeneralSign, 'absent' | 'present'>> & { other?: string };

export const SYSTEMS = { cns: 'CNS', rs: 'RS', pa: 'P/A', cvs: 'CVS' } as const;
export type SystemKey = keyof typeof SYSTEMS;
export type SystemicExam = Partial<Record<SystemKey, string>>;

export type NoteVitals = {
  pulse?: number;
  bpSystolic?: number;
  bpDiastolic?: number;
  tempFTenths?: number;
  spo2?: number;
  respRate?: number;
};

/** A chart reading this recent is the O/E's starting point. */
export const RECENT_READING_MS = 2 * 3_600_000;

export type NoteInput = {
  kind: NoteKind;
  seenAt: Date;
  caseOf: string | null;
  complaints: Complaint[];
  history: string | null;
  pastHistory: string | null;
  generalExam: GeneralExam;
  vitals: NoteVitals;
  systemicExam: SystemicExam;
  progress: string | null;
  advice: string | null;
};

const tidy = (value: unknown, max: number, label: string): string | null => {
  const text = String(value ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  if (text.length > max) throw new NoteError(`${label} is too long (at most ${max} letters)`);
  return text;
};

const whole = (raw: unknown, min: number, max: number, label: string): number | undefined => {
  const text = String(raw ?? '').trim();
  if (!text) return undefined;
  if (!/^\d{1,3}$/.test(text)) throw new NoteError(`${label}: type a whole number`);
  const value = Number(text);
  if (value < min || value > max) throw new NoteError(`${label} must be between ${min} and ${max}`);
  return value;
};

/** The vitals as typed on the note: "120/80", "98.6" or "37.2", numbers. */
export function parseNoteVitals(raw: { pulse?: unknown; bp?: unknown; temp?: unknown; spo2?: unknown; rr?: unknown }): NoteVitals {
  const vitals: NoteVitals = {};
  try {
    const bp = parseBloodPressure(String(raw.bp ?? ''));
    if (bp) {
      vitals.bpSystolic = bp.systolic;
      vitals.bpDiastolic = bp.diastolic;
    }
    const temp = parseTemperature(String(raw.temp ?? ''));
    if (temp !== null) vitals.tempFTenths = temp;
  } catch (err) {
    if (err instanceof TprInputError) throw new NoteError(err.message);
    throw err;
  }
  const pulse = whole(raw.pulse, 20, 250, 'Pulse');
  if (pulse !== undefined) vitals.pulse = pulse;
  const spo2 = whole(raw.spo2, 40, 100, 'SpO2');
  if (spo2 !== undefined) vitals.spo2 = spo2;
  const rr = whole(raw.rr, 4, 80, 'Breathing rate');
  if (rr !== undefined) vitals.respRate = rr;
  return vitals;
}

/** Checks a note as typed. Throws NoteError. */
export function parseNote(
  raw: {
    kind?: unknown;
    seenAt?: unknown;
    caseOf?: unknown;
    complaints?: readonly { text?: unknown; duration?: unknown }[];
    history?: unknown;
    pastHistory?: unknown;
    generalExam?: Record<string, unknown>;
    vitals?: { pulse?: unknown; bp?: unknown; temp?: unknown; spo2?: unknown; rr?: unknown };
    systemicExam?: Record<string, unknown>;
    progress?: unknown;
    advice?: unknown;
  },
  now: Date = new Date(),
): NoteInput {
  const kind = String(raw.kind ?? '');
  if (kind !== 'admission' && kind !== 'progress') throw new NoteError('Choose admission note or progress note');
  const seenAt = raw.seenAt ? new Date(String(raw.seenAt)) : now;
  if (Number.isNaN(seenAt.getTime())) throw new NoteError('Give the time the patient was seen');
  if (seenAt.getTime() > now.getTime() + 5 * 60_000) throw new NoteError('The time seen is in the future');
  if (now.getTime() - seenAt.getTime() > 48 * 3_600_000) throw new NoteError('That was over 48 hours ago. Tell the desk.');

  const complaints: Complaint[] = [];
  for (const c of raw.complaints ?? []) {
    const text = tidy(c.text, 120, 'A complaint');
    if (!text) continue;
    complaints.push({ text, duration: tidy(c.duration, 40, 'How long') });
  }
  if (complaints.length > 20) throw new NoteError('At most 20 complaints');

  const generalExam: GeneralExam = {};
  for (const key of Object.keys(GENERAL_SIGNS) as GeneralSign[]) {
    const value = raw.generalExam?.[key];
    if (value === 'absent' || value === 'present') generalExam[key] = value;
  }
  const other = tidy(raw.generalExam?.other, 300, 'Other findings');
  if (other) generalExam.other = other;

  const systemicExam: SystemicExam = {};
  for (const key of Object.keys(SYSTEMS) as SystemKey[]) {
    const value = tidy(raw.systemicExam?.[key], 500, SYSTEMS[key]);
    if (value) systemicExam[key] = value;
  }

  const note: NoteInput = {
    kind,
    seenAt,
    caseOf: tidy(raw.caseOf, 300, 'Case of'),
    complaints,
    history: tidy(raw.history, 2000, 'H/O'),
    pastHistory: tidy(raw.pastHistory, 1000, 'P/H'),
    generalExam,
    vitals: parseNoteVitals(raw.vitals ?? {}),
    systemicExam,
    progress: tidy(raw.progress, 2000, 'Progress'),
    advice: tidy(raw.advice, 2000, 'Adv'),
  };
  if (kind === 'admission' && !note.caseOf && complaints.length === 0) throw new NoteError('Write what the patient came with: Case of, or the complaints');
  if (kind === 'progress' && !note.progress && !note.advice) throw new NoteError('Write the progress or the advice');
  return note;
}

type Reading = { pulse: number | null; bpSystolic: number | null; bpDiastolic: number | null; tempFTenths: number | null; spo2: number | null; respRate: number | null };

/** The vitals a chart reading holds, as a note's O/E. */
export function vitalsOf(reading: Reading): NoteVitals {
  const v: NoteVitals = {};
  if (reading.pulse !== null) v.pulse = reading.pulse;
  if (reading.bpSystolic !== null && reading.bpDiastolic !== null) {
    v.bpSystolic = reading.bpSystolic;
    v.bpDiastolic = reading.bpDiastolic;
  }
  if (reading.tempFTenths !== null) v.tempFTenths = reading.tempFTenths;
  if (reading.spo2 !== null) v.spo2 = reading.spo2;
  if (reading.respRate !== null) v.respRate = reading.respRate;
  return v;
}

const KEYS: (keyof NoteVitals)[] = ['pulse', 'bpSystolic', 'bpDiastolic', 'tempFTenths', 'spo2', 'respRate'];

export const hasVitals = (v: NoteVitals) => KEYS.some((k) => v[k] !== undefined);

/** Same values for every vital either side has. */
export function sameVitals(a: NoteVitals, b: NoteVitals): boolean {
  return KEYS.every((k) => a[k] === b[k]);
}

/**
 * What the note does with the chart: confirm the recent reading (the doctor
 * kept its values), write a new one (changed, or none recent), or nothing
 * (no vitals on the note).
 */
export function chartAction(noteVitals: NoteVitals, recent: { id: string; vitals: NoteVitals } | null): { kind: 'none' } | { kind: 'confirm'; entryId: string } | { kind: 'write' } {
  if (!hasVitals(noteVitals)) return { kind: 'none' };
  if (recent && sameVitals(noteVitals, recent.vitals)) return { kind: 'confirm', entryId: recent.id };
  return { kind: 'write' };
}

/** "P 88 · BP 130/80 · T 99.1 °F · SpO2 97% · RR 18". */
export function vitalsText(v: NoteVitals): string {
  return [
    v.pulse !== undefined ? `P ${v.pulse}` : null,
    v.bpSystolic !== undefined ? `BP ${v.bpSystolic}/${v.bpDiastolic}` : null,
    v.tempFTenths !== undefined ? `T ${formatTemperature(v.tempFTenths)} °F` : null,
    v.spo2 !== undefined ? `SpO2 ${v.spo2}%` : null,
    v.respRate !== undefined ? `RR ${v.respRate}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Pallor present, icterus absent, …" — only the signs looked for. */
export function generalExamText(g: GeneralExam): string {
  const parts = (Object.keys(GENERAL_SIGNS) as GeneralSign[]).filter((k) => g[k]).map((k) => `${GENERAL_SIGNS[k]} ${g[k] === 'present' ? '+' : '−'}`);
  if (g.other) parts.push(g.other);
  return parts.join(', ');
}
