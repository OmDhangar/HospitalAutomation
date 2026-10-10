import { chartDayOf, chartDayWindow } from '@/lib/domain/tpr';

/**
 * Count-first stock for risk-class medicines (IPD sheets plan B4a, §7.3). Pure.
 *
 * What a place should hold = what came in − what went out − what was used,
 * per batch. Until the MAR records each dose (B3-min, B4b), "used" is the
 * figure the counter copies from the paper drug register at count time; it is
 * spread over the batches that expire first, as the shelf would be used.
 *
 * A count is blind: the counter never sees what the books expect until the
 * count is submitted, and someone else approves it.
 */

export class StockError extends Error {}

export const LOCATION_KINDS = {
  main_store: 'Main store',
  ward_store: 'Ward store',
  lab_store: 'Lab store',
  crash_cart: 'Crash cart',
  other: 'Other',
} as const;
export type LocationKind = keyof typeof LOCATION_KINDS;

export const RISK_KINDS = {
  ndps: 'Narcotic (NDPS)',
  psychotropic: 'Psychotropic',
  high_value: 'High value',
  other: 'Other',
} as const;
export type RiskKind = keyof typeof RISK_KINDS;

export const LEDGER_KIND_LABELS = {
  receive: 'Received from supplier',
  transfer_out: 'Sent out',
  transfer_in: 'Received from store',
  give: 'Used',
  waste: 'Wasted',
  return: 'Returned to supplier',
  adjust: 'Adjusted',
  count_variance: 'Count difference',
} as const;
export type LedgerKind = keyof typeof LEDGER_KIND_LABELS;

/** Why stock is adjusted outside a count, and the movement each reason posts. Expired and damaged stock is wasted. */
export const ADJUST_REASONS = {
  expired: { label: 'Expired', kind: 'waste', direction: 'out' },
  damaged: { label: 'Broken or damaged', kind: 'waste', direction: 'out' },
  returned_to_supplier: { label: 'Returned to supplier', kind: 'return', direction: 'out' },
  found: { label: 'Found (was missing)', kind: 'adjust', direction: 'in' },
  entry_error: { label: 'Wrong entry earlier', kind: 'adjust', direction: 'either' },
  other: { label: 'Other', kind: 'adjust', direction: 'either' },
} as const satisfies Record<string, { label: string; kind: LedgerKind; direction: 'in' | 'out' | 'either' }>;
export type AdjustReason = keyof typeof ADJUST_REASONS;
export const isAdjustReason = (value: string): value is AdjustReason => value in ADJUST_REASONS;

/** Why a count differs from the books. Every difference needs one before the count is approved. */
export const VARIANCE_REASONS = {
  recount_confirmed: 'Counted again — the number is right',
  use_not_written: 'Used but not written in the register',
  broken: 'Broken or spilt',
  expired_removed: 'Expired and taken out',
  move_not_recorded: 'Moved without being recorded',
  unknown: 'Not known',
  other: 'Other',
} as const;
export type VarianceReason = keyof typeof VARIANCE_REASONS;
export const isVarianceReason = (value: string): value is VarianceReason => value in VARIANCE_REASONS;

/* ---------------------------------------------------------------- input */

/** A batch number as printed on the strip or vial, in capitals. */
export function parseBatchNo(raw: string): string {
  const text = raw.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9/._-]{0,39}$/.test(text)) throw new StockError('Type the batch number as printed (letters, numbers, / . _ -)');
  return text;
}

export function parseQuantity(raw: string | number, label = 'Quantity', options: { min?: number; max?: number } = {}): number {
  const min = options.min ?? 1;
  const max = options.max ?? 100_000;
  const text = String(raw).trim();
  if (!/^\d{1,6}$/.test(text)) throw new StockError(`${label}: type a whole number`);
  const value = Number(text);
  if (value < min || value > max) throw new StockError(`${label} must be between ${min} and ${max}`);
  return value;
}

/** An expiry as printed: "2027-03-31", or month and year "03/2027" (the last day of that month). */
export function parseExpiry(raw: string): string {
  const text = raw.trim();
  let date: string | null = null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const monthYear = /^(\d{1,2})[/-](\d{4})$/.exec(text);
  if (iso) {
    date = text;
  } else if (monthYear) {
    const month = Number(monthYear[1]);
    const year = Number(monthYear[2]);
    if (month >= 1 && month <= 12) {
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      date = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    }
  }
  if (!date || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new StockError('Type the expiry like 03/2027 or 2027-03-31');
  }
  return date;
}

/* ---------------------------------------------------------------- expiry */

export const EXPIRY_SOON_DAYS = 90;

export function expiryStatus(expiryDate: string, today: string): 'expired' | 'soon' | 'ok' {
  const days = (Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  if (days < 0) return 'expired';
  if (days <= EXPIRY_SOON_DAYS) return 'soon';
  return 'ok';
}

export type BatchOnHand = { batchId: string; batchNo: string; expiryDate: string; quantity: number };

/** First expiry first out (plan §7.3), then batch number, so the order is always the same. */
export function fefo<T extends { batchNo: string; expiryDate: string }>(batches: readonly T[]): T[] {
  return [...batches].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.batchNo.localeCompare(b.batchNo));
}

/* ---------------------------------------------------------------- counts */

/** Spreads a "used" figure over a medicine's batches, earliest expiry first, never more than a batch holds. */
export function allocateUse(batches: readonly BatchOnHand[], used: number): { byBatch: Map<string, number>; unallocated: number } {
  const byBatch = new Map<string, number>();
  let left = used;
  for (const batch of fefo(batches)) {
    if (left <= 0) break;
    const take = Math.min(batch.quantity, left);
    if (take > 0) byBatch.set(batch.batchId, take);
    left -= take;
  }
  return { byBatch, unallocated: Math.max(left, 0) };
}

export type CountLineInput = {
  batchId: string;
  medicineId: string;
  batchNo: string;
  expiryDate: string;
  counted: number;
  /** What the books say this place holds of this batch at submission. */
  book: number;
};

export type CountLineOutcome = { batchId: string; usedAllocated: number; variance: number };

/**
 * The outcome of a submitted count: per batch, how much of the register's
 * "used" figure it takes (FEFO) and the difference left over:
 * variance = counted − (book − used). Negative means missing.
 * A "used" figure larger than the books is reported per medicine.
 */
export function countOutcome(
  lines: readonly CountLineInput[],
  usedByMedicine: ReadonlyMap<string, number>,
): { lines: CountLineOutcome[]; overUse: Map<string, number> } {
  const byMedicine = new Map<string, CountLineInput[]>();
  for (const line of lines) {
    const list = byMedicine.get(line.medicineId) ?? [];
    list.push(line);
    byMedicine.set(line.medicineId, list);
  }
  const used = new Map<string, number>();
  const overUse = new Map<string, number>();
  for (const [medicineId, list] of byMedicine) {
    const figure = usedByMedicine.get(medicineId) ?? 0;
    const { byBatch, unallocated } = allocateUse(
      list.map((l) => ({ batchId: l.batchId, batchNo: l.batchNo, expiryDate: l.expiryDate, quantity: l.book })),
      figure,
    );
    for (const [batchId, qty] of byBatch) used.set(batchId, qty);
    if (unallocated > 0) overUse.set(medicineId, unallocated);
  }
  return {
    lines: lines.map((line) => {
      const usedAllocated = used.get(line.batchId) ?? 0;
      return { batchId: line.batchId, usedAllocated, variance: line.counted - (line.book - usedAllocated) };
    }),
    overUse,
  };
}

/**
 * Is a place's count due? Daily classes: once each chart day (from 8 am, at
 * the morning shift change, decision D-COUNT). Weekly classes: once in 7 days.
 */
export function countDue(args: { lastCountAt: Date | null; every: 'daily' | 'weekly'; now: Date; timezone: string }): boolean {
  if (!args.lastCountAt) return true;
  if (args.every === 'weekly') return args.now.getTime() - args.lastCountAt.getTime() >= 7 * 86_400_000;
  const { from } = chartDayWindow(chartDayOf(args.now, args.timezone), args.timezone);
  return args.lastCountAt.getTime() < from.getTime();
}

/** The signed quantity an adjustment posts, from the reason and the number typed. */
export function adjustmentQuantity(reason: AdjustReason, direction: 'in' | 'out', quantity: number): number {
  const allowed = ADJUST_REASONS[reason].direction;
  if (allowed !== 'either' && allowed !== direction) {
    throw new StockError(`“${ADJUST_REASONS[reason].label}” can only ${allowed === 'out' ? 'take stock out' : 'add stock'}`);
  }
  return direction === 'out' ? -quantity : quantity;
}
