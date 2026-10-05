import { z } from 'zod';
import { tidy, type ParseResult } from './medicine';
import { parsePercentToBasisPoints, parseRupeesToPaise } from './patient-billing';
import { formatRupees } from './billing';

/**
 * Ward, bed and charge-item set-up rules. Pure: no database.
 *
 * The owner sets up a hospital's IPD once, usually in one sitting, so the
 * inputs here are built for speed: "1-12" makes twelve beds, and a price list
 * arrives as a CSV pasted from whatever the hospital uses today.
 */

export const CHARGE_ITEM_KINDS = ['consumable', 'procedure', 'service', 'room'] as const;
export type ChargeItemKind = (typeof CHARGE_ITEM_KINDS)[number];

export const CHARGE_ITEM_KIND_LABELS: Record<ChargeItemKind, string> = {
  consumable: 'Consumable',
  procedure: 'Procedure',
  service: 'Service',
  room: 'Room (per day)',
};

export const isChargeItemKind = (value: string): value is ChargeItemKind =>
  (CHARGE_ITEM_KINDS as readonly string[]).includes(value);

/** At most this many beds from one range, so a typo ("1-1000") cannot flood a ward. */
export const MAX_BEDS_PER_RANGE = 60;

/**
 * Turns what the owner typed into bed labels.
 *
 *   "12"        → 12 beds: 1 … 12, or — in a ward that already has beds 1–12 —
 *                 13 … 24. A single number is a count, because that is what
 *                 "how many beds?" means to the person typing it.
 *   "1-12"      → 1, 2, … 12
 *   "A1-A6"     → A1 … A6       (the prefix may be repeated on the right)
 *   "ICU 1-4"   → ICU 1 … ICU 4
 *   "1, 2, 5"   → 1, 2, 5       (a list names exact beds)
 *   "ICU-3"     → ICU-3         (a single label: letters before the hyphen)
 *   "13-13"     → 13            (one bed with an exact number)
 *
 * Duplicates are dropped, case-insensitively, keeping the first spelling.
 */
export function parseBedLabels(input: string, existingLabels: readonly string[] = []): ParseResult<string[]> {
  const parts = input
    .split(/[,\n;]/)
    .map((part) => tidy(part))
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: 'Enter how many beds, like 12' };

  if (parts.length === 1 && /^\d{1,3}$/.test(parts[0])) {
    const count = Number(parts[0]);
    if (count < 1) return { ok: false, error: 'Enter at least 1 bed' };
    if (count > MAX_BEDS_PER_RANGE) {
      return { ok: false, error: `That is more than ${MAX_BEDS_PER_RANGE} beds at once` };
    }
    const highest = existingLabels.reduce((max, label) => (/^\d+$/.test(label) ? Math.max(max, Number(label)) : max), 0);
    return { ok: true, value: Array.from({ length: count }, (_, i) => String(highest + 1 + i)) };
  }

  const labels: string[] = [];
  for (const part of parts) {
    const range = /^([A-Za-z]*\s?)(\d{1,4})\s*[-–—]\s*([A-Za-z]*\s?)(\d{1,4})$/.exec(part);
    if (range && (range[3] === '' || range[3].trim() === range[1].trim())) {
      const prefix = range[1];
      const from = Number(range[2]);
      const to = Number(range[4]);
      if (to < from) return { ok: false, error: `“${part}” counts backwards` };
      if (to - from + 1 > MAX_BEDS_PER_RANGE) {
        return { ok: false, error: `“${part}” is more than ${MAX_BEDS_PER_RANGE} beds at once` };
      }
      for (let n = from; n <= to; n += 1) labels.push(`${prefix}${n}`);
      continue;
    }
    if (part.length > 20) return { ok: false, error: `“${part}” is too long for a bed label` };
    labels.push(part);
  }

  const seen = new Set<string>();
  const unique = labels.filter((label) => {
    const key = label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > MAX_BEDS_PER_RANGE) {
    return { ok: false, error: `That is more than ${MAX_BEDS_PER_RANGE} beds at once` };
  }
  return { ok: true, value: unique };
}

/**
 * Sorts bed labels the way a ward is walked: "2" before "10", "A2" before
 * "A10". Used for display and to assign sort_order on creation.
 */
export const compareBedLabels = (a: string, b: string): number =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/* ----------------------------------------------------------- charge items */

const chargeItemFields = z.object({
  kind: z.enum(CHARGE_ITEM_KINDS),
  name: z.string().max(240).transform(tidy).pipe(z.string().min(1, 'Name is required').max(120)),
  unit: z
    .string()
    .max(40)
    .transform(tidy)
    .pipe(z.string().max(20))
    .transform((value) => value || 'unit')
    .optional(),
  sellingPricePaise: z.number().int().min(0).max(100_000_000).nullish(),
  taxRateBp: z.number().int().min(0).max(10_000).optional(),
  isTest: z.boolean().optional(),
});

export type ChargeItemInput = {
  kind: ChargeItemKind;
  name: string;
  unit: string;
  sellingPricePaise: number | null;
  taxRateBp: number;
  isTest: boolean;
};

export function parseChargeItemInput(raw: unknown): ParseResult<ChargeItemInput> {
  const parsed = chargeItemFields.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] ? `${String(issue.path[0])}: ` : '';
    return { ok: false, error: `${field}${issue?.message ?? 'Invalid item'}` };
  }
  const v = parsed.data;
  // Only a service can be a test; the database refuses anything else, so the
  // flag is dropped here rather than turned into an error the owner must fix.
  const isTest = v.kind === 'service' && (v.isTest ?? false);
  return {
    ok: true,
    value: {
      kind: v.kind,
      name: v.name,
      unit: v.unit ?? defaultUnitFor(v.kind),
      sellingPricePaise: v.sellingPricePaise ?? null,
      taxRateBp: v.taxRateBp ?? 0,
      isTest,
    },
  };
}

export const defaultUnitFor = (kind: ChargeItemKind): string =>
  kind === 'room' ? 'day' : kind === 'consumable' ? 'unit' : 'each';

/* -------------------------------------------------------------- CSV import */

export type CsvImportRow = {
  /** 1-based line number in the pasted text, for "line 14: …" messages. */
  line: number;
  name: string;
  kind: ChargeItemKind;
  unit: string;
  sellingPricePaise: number | null;
  taxRateBp: number;
  isTest: boolean;
};

export type CsvImportError = { line: number; text: string; error: string };

export type CsvImportPreview = {
  rows: CsvImportRow[];
  errors: CsvImportError[];
};

/** At most this many rows per import: a hospital price list, not a pharmacy master. */
export const MAX_IMPORT_ROWS = 1000;

/**
 * Splits one CSV line into fields. Handles quoted fields with commas and
 * doubled quotes ("Dressing, large"), which is what spreadsheets export.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === '\t') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((field) => tidy(field));
}

/** The words a hospital might use for each kind, in any case. */
const KIND_WORDS: Record<string, { kind: ChargeItemKind; isTest: boolean }> = {
  consumable: { kind: 'consumable', isTest: false },
  consumables: { kind: 'consumable', isTest: false },
  material: { kind: 'consumable', isTest: false },
  procedure: { kind: 'procedure', isTest: false },
  procedures: { kind: 'procedure', isTest: false },
  service: { kind: 'service', isTest: false },
  services: { kind: 'service', isTest: false },
  test: { kind: 'service', isTest: true },
  tests: { kind: 'service', isTest: true },
  lab: { kind: 'service', isTest: true },
  investigation: { kind: 'service', isTest: true },
  room: { kind: 'room', isTest: false },
  bed: { kind: 'room', isTest: false },
};

/**
 * Reads a pasted price list: name, kind, unit, price in rupees, tax %.
 *
 * Only name is required; kind defaults to consumable, unit to the kind's
 * default, a blank price to "not priced yet", a blank tax to 0. A header row
 * is recognised and skipped. Every bad row is reported with its line number,
 * and the good rows are still returned — the owner fixes the few, not the
 * whole sheet.
 */
export function parseChargeItemCsv(text: string): CsvImportPreview {
  const rows: CsvImportRow[] = [];
  const errors: CsvImportError[] = [];
  const seen = new Set<string>();

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    if (raw.trim() === '') continue;
    const [name = '', kindWord = '', unit = '', price = '', tax = ''] = splitCsvLine(raw);

    if (rows.length === 0 && errors.length === 0 && /^name$/i.test(name)) continue;
    if (rows.length + errors.length >= MAX_IMPORT_ROWS) {
      errors.push({ line, text: raw, error: `Only ${MAX_IMPORT_ROWS} rows at a time` });
      break;
    }

    const fail = (error: string) => errors.push({ line, text: raw, error });

    if (!name) {
      fail('Name is missing');
      continue;
    }
    const kindKey = kindWord.toLowerCase();
    const kindInfo = kindKey === '' ? KIND_WORDS.consumable : KIND_WORDS[kindKey];
    if (!kindInfo) {
      fail(`Kind “${kindWord}” is not one of consumable, procedure, service, test, room`);
      continue;
    }
    let sellingPricePaise: number | null = null;
    if (price !== '') {
      sellingPricePaise = parseRupeesToPaise(price);
      if (sellingPricePaise === null) {
        fail(`Price “${price}” is not an amount in rupees, like 15 or 2.50`);
        continue;
      }
    }
    let taxRateBp = 0;
    if (tax !== '') {
      const parsedTax = parsePercentToBasisPoints(tax);
      if (parsedTax === null) {
        fail(`Tax “${tax}” is not a percentage, like 12`);
        continue;
      }
      taxRateBp = parsedTax;
    }

    const parsed = parseChargeItemInput({
      kind: kindInfo.kind,
      name,
      unit: unit || undefined,
      sellingPricePaise,
      taxRateBp,
      isTest: kindInfo.isTest,
    });
    if (!parsed.ok) {
      fail(parsed.error);
      continue;
    }
    const key = `${parsed.value.kind}:${parsed.value.name.toLowerCase()}`;
    if (seen.has(key)) {
      fail(`“${parsed.value.name}” appears twice in this list`);
      continue;
    }
    seen.add(key);
    rows.push({ line, ...parsed.value });
  }

  return { rows, errors };
}

/* ---------------------------------------------------------------- pricing */

export type PriceEdit = { id: string; sellingPricePaise: number };

/**
 * Reads the "Set prices" form: one `price:<id>` field per row. A blank box
 * means "leave it", not "make it free"; an unreadable amount is reported by
 * row so nothing is half-saved.
 */
export function parsePriceEdits(
  entries: Iterable<[string, string]>,
): ParseResult<PriceEdit[]> {
  const edits: PriceEdit[] = [];
  for (const [key, value] of entries) {
    if (!key.startsWith('price:')) continue;
    const id = key.slice('price:'.length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const typed = value.trim();
    if (typed === '') continue;
    const paise = parseRupeesToPaise(typed);
    if (paise === null) return { ok: false, error: `“${typed}” is not an amount in rupees, like 2.50` };
    edits.push({ id, sellingPricePaise: paise });
  }
  return { ok: true, value: edits };
}

/**
 * "Syringe 5 ml ₹12, Cannula ₹45 and 3 more" — what a bulk price save just
 * did, for the confirmation shown beside its button. `labels` maps id to the
 * name the form showed; edits without a label are counted, not named.
 */
export function describeSavedPrices(
  edits: PriceEdit[],
  labels: ReadonlyMap<string, string>,
  limit = 5,
): string {
  if (edits.length === 0) return '';
  const named = edits
    .filter((edit) => labels.has(edit.id))
    .slice(0, limit)
    .map((edit) => `${labels.get(edit.id)} ${formatRupees(edit.sellingPricePaise)}`);
  const rest = edits.length - named.length;
  const list = named.join(', ') + (rest > 0 ? `${named.length ? ' and ' : ''}${rest} more` : '');
  return `Saved ${edits.length} price${edits.length === 1 ? '' : 's'}: ${list}`;
}

/** Reads the `label:<id>` hidden inputs a bulk price form sends with each box. */
export function priceLabelsFrom(entries: Iterable<[string, string]>): Map<string, string> {
  const labels = new Map<string, string>();
  for (const [key, value] of entries) {
    if (key.startsWith('label:')) labels.set(key.slice('label:'.length), value.slice(0, 60));
  }
  return labels;
}
