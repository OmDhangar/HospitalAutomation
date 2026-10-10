/**
 * The treatment card and the MAR (IPD sheets plan B3-min, §7.2; migration 0048). Pure.
 *
 * The doctor writes the treatment card: each line a medicine with dose,
 * route and frequency, or an instruction. A line written by anyone else (a
 * telephone or verbal order) is transcribed and waits for that doctor's
 * countersign. Nurses record each dose against a line: given, or not given
 * with a reason.
 *
 * Risk-class medicines carry the controls (D-WITNESS, §7.2): the line must be
 * signed or countersigned; a give from a personal phone needs proof of being
 * at the bed; NDPS gives (and IV psychotropics, and any class the hospital
 * marks) need a second person. Each control rolls out observe → warn →
 * enforce: before enforce a missing control is recorded on the dose as a
 * flag, never silently passed and never blocking care.
 */

import type { ModuleStage } from '@/lib/modules/registry';

export class MarError extends Error {}

export const ROUTES = {
  oral: 'Oral',
  iv: 'IV',
  im: 'IM',
  sc: 'SC',
  sl: 'Sublingual',
  inhaled: 'Inhaled / neb',
  topical: 'Local',
  pr: 'PR',
  other: 'Other',
} as const;
export type Route = keyof typeof ROUTES;
export const isRoute = (value: string): value is Route => value in ROUTES;

/** What doctors write; free text is allowed too (up to 30 letters). */
export const FREQUENCY_PRESETS = ['STAT', 'OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'q4h', 'q6h', 'q8h', 'q12h'] as const;

export const DOSE_STATES = {
  given: 'Given',
  held: 'Held',
  refused: 'Refused',
  not_available: 'Not available',
  omitted: 'Not given',
} as const;
export type DoseState = keyof typeof DOSE_STATES;

/** The mark on the paper MAR: ✓ given, H held, R refused, ✗ the rest. */
export const DOSE_MARK: Record<DoseState, string> = { given: '✓', held: 'H', refused: 'R', not_available: '✗', omitted: '✗' };

export const REASONS = {
  refused: 'Patient refused',
  npo: 'Nil by mouth',
  away: 'At a procedure / away',
  not_available: 'Not available (stock-out)',
  held_by_doctor: 'Held by doctor',
  late_entry: 'Written late',
  other: 'Other',
} as const;
export type ReasonCode = keyof typeof REASONS;

/** "Not given" choices on the dose sheet, and the state and reason each records. */
export const NOT_GIVEN = {
  refused: { label: 'Refused', state: 'refused', reason: 'refused' },
  held_by_doctor: { label: 'Held by doctor', state: 'held', reason: 'held_by_doctor' },
  not_available: { label: 'Not available', state: 'not_available', reason: 'not_available' },
  npo: { label: 'Nil by mouth', state: 'omitted', reason: 'npo' },
  away: { label: 'At a procedure / away', state: 'omitted', reason: 'away' },
  other: { label: 'Other reason', state: 'omitted', reason: 'other' },
} as const satisfies Record<string, { label: string; state: Exclude<DoseState, 'given'>; reason: ReasonCode }>;
export type NotGivenChoice = keyof typeof NOT_GIVEN;
export const isNotGivenChoice = (value: string): value is NotGivenChoice => value in NOT_GIVEN;

export const CONTROL_FLAGS = {
  uncountersigned_order: 'Line not countersigned yet',
  no_presence: 'Not proved at the bed',
  no_witness: 'No witness',
  witness_late: 'Witness not there in 15 min',
  late_entry: 'Written over 2 h later',
} as const;
export type ControlFlag = keyof typeof CONTROL_FLAGS;

export const WITNESS_APPROVAL_MS = 10 * 60_000;
export const WITNESS_LATE_MS = 15 * 60_000;
export const PRESENCE_VALID_MS = 5 * 60_000;
export const LATE_ENTRY_MS = 2 * 3_600_000;
export const DESK_ONLY_AFTER_MS = 48 * 3_600_000;
export const FUTURE_SLACK_MS = 5 * 60_000;

/* ---------------------------------------------------------------- orders */

export type OrderInput =
  | { kind: 'medicine'; medicineId: string; dose: string; route: Route; frequency: string; instructions: string | null }
  | { kind: 'instruction'; description: string };

const tidy = (value: unknown, max: number, label: string, required: boolean): string | null => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new MarError(`Write the ${label}`);
    return null;
  }
  if (text.length > max) throw new MarError(`The ${label} is too long (at most ${max} letters)`);
  return text;
};

/** Checks a treatment line as typed. Throws MarError. */
export function parseOrder(raw: {
  kind: string;
  medicineId?: string | null;
  dose?: string | null;
  route?: string | null;
  frequency?: string | null;
  instructions?: string | null;
  description?: string | null;
}): OrderInput {
  if (raw.kind === 'instruction') {
    return { kind: 'instruction', description: tidy(raw.description, 200, 'instruction', true)! };
  }
  if (raw.kind !== 'medicine') throw new MarError('Choose a medicine or an instruction');
  if (!raw.medicineId || !/^[0-9a-f-]{36}$/i.test(raw.medicineId)) throw new MarError('Choose the medicine');
  const route = String(raw.route ?? '');
  if (!isRoute(route)) throw new MarError('Choose the route');
  return {
    kind: 'medicine',
    medicineId: raw.medicineId,
    dose: tidy(raw.dose, 40, 'dose', true)!,
    route,
    frequency: tidy(raw.frequency, 30, 'frequency', true)!,
    instructions: tidy(raw.instructions, 200, 'instructions', false),
  };
}

export type OrderStatus = 'active' | 'awaiting_countersign' | 'stopped' | 'struck_out';

export function orderStatus(order: { transcribed: boolean; countersignedAt: Date | null; stoppedAt: Date | null; voidedAt: Date | null }): OrderStatus {
  if (order.voidedAt) return 'struck_out';
  if (order.stoppedAt) return 'stopped';
  if (order.transcribed && !order.countersignedAt) return 'awaiting_countersign';
  return 'active';
}

/* ------------------------------------------------------------- the controls */

export type RiskInfo = { kind: 'ndps' | 'psychotropic' | 'high_value' | 'other'; witnessAtGive: boolean } | null;

/** D-WITNESS: NDPS (ENDs) always; IV psychotropics (benzodiazepines); any class the hospital marks. */
export function needsWitness(risk: RiskInfo, route: Route | null): boolean {
  if (!risk) return false;
  return risk.kind === 'ndps' || risk.witnessAtGive || (risk.kind === 'psychotropic' && route === 'iv');
}

export type GiveCheck = {
  /** Set when the give is refused outright. */
  refusal: string | null;
  flags: ControlFlag[];
  witness: 'not_needed' | 'ward_device' | 'approval' | 'skipped';
  /** A late entry needs a written reason. */
  needsLateReason: boolean;
};

/**
 * What the rules say about one give, before it is written. The time rules
 * (§7.2 sanity) hold at every stage; the risk-class controls refuse only in
 * `enforce` and are recorded as flags before that.
 */
export function checkGive(args: {
  stage: ModuleStage;
  risk: RiskInfo;
  route: Route | null;
  channel: 'personal' | 'ward_device';
  order: { transcribed: boolean; countersignedAt: Date | null };
  hasPresenceProof: boolean;
  witnessUserId: string | null;
  occurredAt: Date;
  now: Date;
}): GiveCheck {
  const ago = args.now.getTime() - args.occurredAt.getTime();
  const result: GiveCheck = { refusal: null, flags: [], witness: 'not_needed', needsLateReason: false };
  if (ago < -FUTURE_SLACK_MS) return { ...result, refusal: 'The time given is in the future' };
  if (ago > DESK_ONLY_AFTER_MS) return { ...result, refusal: 'That was over 48 hours ago. Tell the desk.' };
  if (ago > LATE_ENTRY_MS) {
    result.flags.push('late_entry');
    result.needsLateReason = true;
  }
  if (!args.risk) return result;

  const enforce = args.stage === 'enforce';
  if (args.order.transcribed && !args.order.countersignedAt) {
    if (enforce) return { ...result, refusal: 'This line is waiting for the doctor’s countersign. Ask the doctor to countersign it first.' };
    result.flags.push('uncountersigned_order');
  }
  if (args.channel === 'personal' && !args.hasPresenceProof) {
    if (enforce) return { ...result, refusal: 'Enter the code on the patient’s bed first (or use the ward tablet).' };
    result.flags.push('no_presence');
  }
  if (needsWitness(args.risk, args.route)) {
    if (args.channel === 'ward_device') result.witness = 'ward_device';
    else if (args.witnessUserId) result.witness = 'approval';
    else if (enforce) return { ...result, refusal: 'Choose who will witness this dose.' };
    else {
      result.witness = 'skipped';
      result.flags.push('no_witness');
    }
  }
  return result;
}

/** A dose noted as not given needs its reason; "other" needs it in words. */
export function notGivenRefusal(choice: NotGivenChoice, text: string | null): string | null {
  if (choice === 'other' && !text) return 'Write why it was not given';
  return null;
}

/* --------------------------------------------------------------- bed codes */

/** The letters on a bed label: no 0/O, 1/I/L, so it reads and types without doubt. */
export const BED_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newBedCode(random: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  let code = '';
  for (let i = 0; i < 6; i += 1) code += BED_CODE_ALPHABET[random(BED_CODE_ALPHABET.length)];
  return code;
}

/** What the nurse typed, tidied: "ab c-d2 3" → "ABCD23". Null when it cannot be a code. */
export function normaliseBedCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-HJKMNP-Z2-9]{6}$/.test(code) ? code : null;
}
