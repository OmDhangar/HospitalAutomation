import { z } from 'zod';
import { tidy, type ParseResult } from './medicine';

/**
 * What a doctor records at an OPD visit, and the rules it must satisfy before
 * it becomes part of the patient's record. Pure: no database.
 *
 * A consultation is three separate clinical facts about one visit — the
 * diagnosis, the notes and the prescription — which are stored in three
 * separate tables. They are collected together here only because the doctor
 * writes them on one screen.
 */

/**
 * Indian prescription notation, offered as one-tap presets. Free text is still
 * accepted: these cover the common cases, not every case.
 */
export const FREQUENCY_PRESETS = [
  { value: '1-0-1', hint: 'morning, night' },
  { value: '1-1-1', hint: 'morning, afternoon, night' },
  { value: '1-0-0', hint: 'morning' },
  { value: '0-0-1', hint: 'night' },
  { value: '0-1-0', hint: 'afternoon' },
  { value: '1-1-1-1', hint: 'four times a day' },
  { value: 'SOS', hint: 'only when needed' },
  { value: 'Once a week', hint: 'weekly' },
] as const;

export const DURATION_PRESETS = [3, 5, 7, 10, 15, 30] as const;

export const INSTRUCTION_PRESETS = [
  'After food',
  'Before food',
  'At bedtime',
  'Empty stomach',
] as const;

export const LIMITS = {
  diagnosis: 300,
  notes: 4000,
  advice: 1000,
  items: 30,
  dose: 60,
  frequency: 40,
  instructions: 200,
  durationDays: 365,
} as const;

/** One medicine line as the doctor writes it. */
export type PrescriptionLine = {
  medicineId: string;
  dose: string;
  frequency: string;
  durationDays: number | null;
  instructions: string;
};

/** The doctor's whole visit record, as submitted at Save. */
export type ConsultationInput = {
  diagnosis: string;
  notes: string;
  items: PrescriptionLine[];
  advice: string;
  /** YYYY-MM-DD, or null for none. */
  followUpOn: string | null;
};

/**
 * A line in a draft also carries the medicine's label, so a reopened draft can
 * be shown without another lookup. The label is display-only: at Save the
 * server reads the medicine again and snapshots what the catalogue says.
 */
export type DraftLine = PrescriptionLine & { medicineLabel: string };
export type ConsultationDraft = Omit<ConsultationInput, 'items'> & { items: DraftLine[] };

const text = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(tidy)
    .pipe(z.string().max(max, `Keep this under ${max} characters`));

/** Notes keep their line breaks; only the ends are trimmed. */
const multiline = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((value) => value.trim())
    .pipe(z.string().max(max, `Keep this under ${max} characters`));

const line = z.object({
  medicineId: z.uuid('Pick the medicine from the list'),
  dose: text(LIMITS.dose).pipe(z.string().min(1, 'Enter a dose, like 1 tablet')),
  frequency: text(LIMITS.frequency).pipe(z.string().min(1, 'Choose how often')),
  durationDays: z.number().int().min(1).max(LIMITS.durationDays).nullable(),
  instructions: text(LIMITS.instructions),
});

const consultation = z.object({
  diagnosis: text(LIMITS.diagnosis),
  notes: multiline(LIMITS.notes),
  items: z.array(line).max(LIMITS.items, `At most ${LIMITS.items} medicines`),
  advice: multiline(LIMITS.advice),
  followUpOn: z.iso.date('Follow-up must be a date').nullable(),
});

/** Validates and normalises a consultation for Save. */
export function parseConsultation(raw: unknown): ParseResult<ConsultationInput> {
  const parsed = consultation.safeParse(raw);
  if (!parsed.success) return { ok: false, error: describe(parsed.error) };
  if (isEmptyConsultation(parsed.data)) {
    return { ok: false, error: 'Nothing to save yet' };
  }
  const ids = parsed.data.items.map((item) => item.medicineId);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: 'The same medicine appears twice. Combine the lines.' };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Drafts are scratch space, so they are accepted half-written — a line with no
 * dose yet is exactly what a draft is for. Only the shape and the size are
 * checked, so a draft can never be used to park megabytes in the database.
 */
const draftLine = z.object({
  medicineId: z.string().max(64),
  medicineLabel: z.string().max(300),
  dose: z.string().max(LIMITS.dose * 2),
  frequency: z.string().max(LIMITS.frequency * 2),
  durationDays: z.number().int().min(0).max(LIMITS.durationDays).nullable(),
  instructions: z.string().max(LIMITS.instructions * 2),
});

const draft = z.object({
  diagnosis: z.string().max(LIMITS.diagnosis * 2),
  notes: z.string().max(LIMITS.notes * 2),
  items: z.array(draftLine).max(LIMITS.items),
  advice: z.string().max(LIMITS.advice * 2),
  followUpOn: z.string().max(10).nullable(),
});

export function parseDraft(raw: unknown): ParseResult<ConsultationDraft> {
  const parsed = draft.safeParse(raw);
  if (!parsed.success) return { ok: false, error: describe(parsed.error) };
  return { ok: true, value: parsed.data };
}

export function isEmptyConsultation(c: {
  diagnosis: string;
  notes: string;
  items: readonly unknown[];
  advice: string;
  followUpOn: string | null;
}): boolean {
  return (
    c.diagnosis.trim() === '' &&
    c.notes.trim() === '' &&
    c.items.length === 0 &&
    c.advice.trim() === '' &&
    c.followUpOn === null
  );
}

/**
 * Whether two prescriptions say the same thing. Saving an unchanged
 * prescription again must not create a new version: a revision is a clinical
 * event, and a doctor pressing Save twice is not one.
 */
export function samePrescription(
  a: { items: readonly PrescriptionLine[]; advice: string; followUpOn: string | null },
  b: { items: readonly PrescriptionLine[]; advice: string; followUpOn: string | null },
): boolean {
  if (a.advice !== b.advice || a.followUpOn !== b.followUpOn) return false;
  if (a.items.length !== b.items.length) return false;
  return a.items.every((item, i) => {
    const other = b.items[i];
    return (
      item.medicineId === other.medicineId &&
      item.dose === other.dose &&
      item.frequency === other.frequency &&
      item.durationDays === other.durationDays &&
      item.instructions === other.instructions
    );
  });
}

const describe = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return 'Check the consultation and try again';
  const [head, index, field] = issue.path;
  if (head === 'items' && typeof index === 'number') {
    return `Medicine ${index + 1}${field ? ` (${String(field)})` : ''}: ${issue.message}`;
  }
  return issue.message;
};
