import { z } from 'zod';

/**
 * What a nurse records at the bedside, as pure rules (IPD plan §5.6, task
 * T1.7). The phone sends what was given, how much and when — never a price.
 * The schema is strict, so a request that carries a price field is refused
 * outright rather than quietly ignored.
 */

/** A nurse may undo her own entry for this long; after it, the desk voids with a reason. */
export const UNDO_WINDOW_MS = 2 * 60_000;
/** The same item for the same patient this soon is probably a double tap. */
export const DUPLICATE_WINDOW_MS = 15 * 60_000;
/**
 * How far back "given at" may go. Generous, because an entry saved offline
 * may sync hours later and still carries the time it was given; the desk
 * sees anything recorded long after the fact as a flag at discharge.
 */
export const MAX_BACKDATE_MS = 48 * 3_600_000;
/** A phone clock running fast; the database allows the same. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** Recorded this long after it was given, the entry is flagged for review. */
export const LATE_RECORDING_FLAG_MS = 6 * 3_600_000;
/** At most this many entries per request (an offline outbox flush). */
export const MAX_BATCH = 50;

const uuid = z.string().uuid();

/** An item from the catalogue, or a new one the nurse is adding ("not in the list"). */
const itemRef = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('medicine'), id: uuid }),
  z.strictObject({ type: z.literal('charge'), id: uuid }),
  z.strictObject({
    type: z.literal('new'),
    kind: z.enum(['medicine', 'consumable', 'procedure']),
    name: z
      .string()
      .max(240)
      .transform((value) => value.trim().replace(/\s+/g, ' '))
      .pipe(z.string().min(2, 'Type the item’s name').max(120)),
  }),
]);

const entrySchema = z.strictObject({
  clientId: uuid,
  admissionId: uuid,
  item: itemRef,
  quantity: z.number().int().min(1).max(999),
  occurredAt: z.iso.datetime({ offset: true }),
});

export const careEntryBatchSchema = z.strictObject({
  entries: z.array(entrySchema).min(1).max(MAX_BATCH),
});

export type CareEntryInput = z.infer<typeof entrySchema>;
export type CareItemRef = z.infer<typeof itemRef>;

export type ParsedBatch =
  | { ok: true; entries: CareEntryInput[] }
  | { ok: false; error: string };

export function parseCareEntryBatch(raw: unknown): ParsedBatch {
  const parsed = careEntryBatchSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, error: `${where}${issue?.message ?? 'Invalid entry'}` };
  }
  return { ok: true, entries: parsed.data.entries };
}

export type OccurredAtRefusal = 'future' | 'too_old';

/** "Given at" must be now-ish or in the recent past. */
export function occurredAtRefusal(occurredAt: Date, now: Date): OccurredAtRefusal | null {
  const ahead = occurredAt.getTime() - now.getTime();
  if (ahead > MAX_CLOCK_SKEW_MS) return 'future';
  if (-ahead > MAX_BACKDATE_MS) return 'too_old';
  return null;
}

/** Undo is the nurse's own mistake, quickly; anything else is a correction. */
export function canUndoEntry(args: {
  recordedByUserId: string | null;
  actorUserId: string;
  recordedAt: Date;
  voided: boolean;
  now: Date;
}): boolean {
  return (
    !args.voided &&
    args.recordedByUserId === args.actorUserId &&
    args.now.getTime() - args.recordedAt.getTime() <= UNDO_WINDOW_MS
  );
}

/**
 * The most recent earlier entry of the same item within the duplicate
 * window, or null. The record screen turns Save into "Add again? (given 6
 * min ago)" when this is not null.
 */
export function recentDuplicate(
  previous: readonly { occurredAt: Date }[],
  occurredAt: Date,
): { minutesAgo: number } | null {
  let nearest: number | null = null;
  for (const entry of previous) {
    const gap = Math.abs(occurredAt.getTime() - entry.occurredAt.getTime());
    if (gap <= DUPLICATE_WINDOW_MS && (nearest === null || gap < nearest)) nearest = gap;
  }
  return nearest === null ? null : { minutesAgo: Math.round(nearest / 60_000) };
}

/** Recorded long after it was given: a flag for the desk at discharge (T2.2). */
export const isLateRecording = (occurredAt: Date, recordedAt: Date): boolean =>
  recordedAt.getTime() - occurredAt.getTime() > LATE_RECORDING_FLAG_MS;

/** The quick "given at" choices on the record sheet. */
export const GIVEN_AT_OPTIONS = [
  { minutesAgo: 0, label: 'Now' },
  { minutesAgo: 15, label: '15 min ago' },
  { minutesAgo: 30, label: '30 min ago' },
  { minutesAgo: 60, label: '1 hour ago' },
] as const;
