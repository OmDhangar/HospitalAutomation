/**
 * Undo, everywhere staff act (decided 3 Oct 2026: "everyone makes mistakes").
 *
 * After an action the screen's usual "Saved" message carries an Undo button.
 * The button posts an undo token: what was done and to which rows. The token
 * is not a credential — the server re-checks the permission, the time window
 * and that nothing has been built on the change since — so a tampered token
 * can do nothing its holder could not already do. Pure: no database.
 */

export const UNDO_KINDS = [
  // Settings
  'ward',
  'beds',
  'item',
  'medicine',
  'prices',
  'toggle-ward',
  'toggle-bed',
  'toggle-item',
  'toggle-medicine',
  // The desk
  'assign',
  'transfer',
  'direct',
  'cancel',
  'ready',
  'void-entry',
  // The bill
  'void-line',
  'discount',
  'payment',
  'approved',
  'finalize',
  // The doctor
  'tests',
] as const;
export type UndoKind = (typeof UNDO_KINDS)[number];

export type UndoToken = { kind: UndoKind; args: string[] };

const SEP = '~';

/** "assign~<admission id>~<payment id>" — safe in a URL and a form field. */
export function formatUndoToken(kind: UndoKind, ...args: (string | null | undefined)[]): string {
  return [kind, ...args.map((arg) => arg ?? '')].join(SEP);
}

/** Reads a token; anything malformed is null, never an exception. */
export function parseUndoToken(raw: unknown): UndoToken | null {
  if (typeof raw !== 'string' || raw.length > 4000) return null;
  const [kind, ...args] = raw.split(SEP);
  if (!(UNDO_KINDS as readonly string[]).includes(kind)) return null;
  if (!args.every((arg) => arg === '' || /^[0-9a-zA-Z,_.:-]{1,2000}$/.test(arg))) return null;
  return { kind: kind as UndoKind, args };
}

/** How long each kind of action can be undone. */
export const UNDO_WINDOWS_MS = {
  /** Set-up: wards, beds, items, prices. Nothing depends on them for a while. */
  settings: 60 * 60_000,
  /** The desk's actions on a patient: before anything else happens to them. */
  desk: 10 * 60_000,
  /** A finalised bill can be reopened for a day; after that, a correction is a new bill. */
  reopenBill: 24 * 3_600_000,
  /** A doctor's tests, like a nurse's entry. */
  tests: 2 * 60_000,
} as const;

export const withinWindow = (at: Date | null | undefined, windowMs: number, now: Date = new Date()): boolean =>
  at !== null && at !== undefined && now.getTime() - at.getTime() <= windowMs;

/** A comma list of ids from a token argument, each checked. */
export const idList = (arg: string | undefined): string[] =>
  (arg ?? '').split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id));

export const isId = (arg: string | undefined): arg is string => typeof arg === 'string' && /^[0-9a-f-]{36}$/i.test(arg);
