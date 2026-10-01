import { z } from 'zod';

/**
 * The medicine catalogue's rules. Pure: no database.
 *
 * A medicine is identified by name + strength + form within a hospital — the
 * database enforces that with a unique index on the lower-cased values — so
 * the job here is to make sure "Paracetamol  500mg " and "paracetamol 500mg"
 * arrive at that index as the same thing.
 */

/** Trims and collapses internal whitespace. Case is left alone for display. */
export const tidy = (value: string): string => value.trim().replace(/\s+/g, ' ');

const optionalText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform(tidy)
    .pipe(z.string().max(max))
    .transform((value) => (value === '' ? null : value))
    .nullish();

const medicineFields = z.object({
  name: z.string().max(240).transform(tidy).pipe(z.string().min(1, 'Name is required').max(120)),
  genericName: optionalText(120),
  strength: optionalText(40),
  form: optionalText(40),
  unit: z
    .string()
    .max(40)
    .transform(tidy)
    .pipe(z.string().max(20))
    .transform((value) => value || 'unit')
    .optional(),
  sellingPricePaise: z.number().int().min(0).max(100_000_000).nullish(),
  taxRateBp: z.number().int().min(0).max(10_000).optional(),
});

export type MedicineInput = {
  name: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  unit: string;
  sellingPricePaise: number | null;
  taxRateBp: number;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseMedicineInput(raw: unknown): ParseResult<MedicineInput> {
  const parsed = medicineFields.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] ? `${String(issue.path[0])}: ` : '';
    return { ok: false, error: `${field}${issue?.message ?? 'Invalid medicine'}` };
  }
  const v = parsed.data;
  return {
    ok: true,
    value: {
      name: v.name,
      genericName: v.genericName ?? null,
      strength: v.strength ?? null,
      form: v.form ?? null,
      unit: v.unit ?? 'unit',
      sellingPricePaise: v.sellingPricePaise ?? null,
      taxRateBp: v.taxRateBp ?? 0,
    },
  };
}

/** "Paracetamol 500 mg tablet" — how a medicine reads everywhere it is shown. */
export function medicineLabel(m: {
  name: string;
  strength?: string | null;
  form?: string | null;
}): string {
  return [m.name, m.strength, m.form].filter(Boolean).join(' ');
}

/**
 * Escapes LIKE wildcards in a search term, so a doctor typing "50%" searches
 * for those characters rather than for everything starting with "50".
 */
export const escapeLikePattern = (term: string): string => term.replace(/[\\%_]/g, (c) => `\\${c}`);
