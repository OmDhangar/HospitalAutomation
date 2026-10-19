import { sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { documentSequences } from '@/lib/db/schema';
import { serviceDateIn } from '@/lib/domain/time';

/**
 * Returns Indian Financial Year string (e.g. "26-27" for date between 1 Apr 2026 and 31 Mar 2027).
 */
export function currentFiscalYear(date: Date = new Date(), timezone: string = 'Asia/Kolkata'): string {
  const ymd = serviceDateIn(timezone, date); // "YYYY-MM-DD"
  const year = parseInt(ymd.slice(0, 4), 10);
  const month = parseInt(ymd.slice(5, 7), 10);
  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(-2)}-${String(endYear).slice(-2)}`;
}

export type NextNumberResult = {
  rawNumber: number;
  fiscalYear: string;
  formatted: string;
};

/**
 * Atomically generates the next sequential number for a given document kind
 * in a hospital and financial year using row-locked document_sequences.
 */
export async function nextDocumentNumberInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    kind: string; // 'admission' | 'deposit_receipt' | 'mlc' | 'temp_mrn'
    date?: Date;
    timezone?: string;
    prefix?: string; // e.g. 'ADM' -> 'ADM/26-27/00042'
    padding?: number;
    resetsAnnually?: boolean;
  },
): Promise<NextNumberResult> {
  const resets = args.resetsAnnually ?? true;
  const fy = resets ? currentFiscalYear(args.date ?? new Date(), args.timezone ?? 'Asia/Kolkata') : '-';
  const padding = args.padding ?? 5;

  const [row] = await tx
    .insert(documentSequences)
    .values({
      hospitalId: args.hospitalId,
      kind: args.kind,
      fiscalYear: fy,
      lastNumber: 1,
    })
    .onConflictDoUpdate({
      target: [documentSequences.hospitalId, documentSequences.kind, documentSequences.fiscalYear],
      set: { lastNumber: sql`${documentSequences.lastNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ lastNumber: documentSequences.lastNumber });

  const num = row.lastNumber;
  const numPadded = String(num).padStart(padding, '0');
  const formatted = args.prefix
    ? resets
      ? `${args.prefix}/${fy}/${numPadded}`
      : `${args.prefix}-${numPadded}`
    : numPadded;

  return {
    rawNumber: num,
    fiscalYear: fy,
    formatted,
  };
}
