import { createHash } from 'node:crypto';
import { formatRupees } from '@/lib/domain/billing';
import { readingSummary } from '@/lib/domain/tpr';

/**
 * The evidence log's arithmetic (IPD sheets plan §7.6, phase A6-min). Pure and
 * server-only.
 *
 * Each event row is hashed when it is written (0044, `acct_events_seal`) over
 * a fixed text of its fields. Every hour a hospital's new rows are sealed into
 * a digest: the Merkle root of their hashes in seq order, chained to the
 * previous digest's hash. The verifier rebuilds all of it here, from the raw
 * columns, so it never has to trust a function inside the database it is
 * checking.
 *
 * The tree is the one Certificate Transparency uses (RFC 6962 §2.1), so its
 * test vectors apply and an inclusion proof for one event can be given later
 * without revealing the others.
 */

const sha256 = (...parts: (Buffer | Uint8Array)[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const UNIT = String.fromCharCode(31);
const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

/** An event row as the verifier reads it: times as microseconds since 1970 and the payload as Postgres prints it. */
export type EventFields = {
  seq: string;
  hospitalId: string;
  branchId: string | null;
  occurredAtMicros: string;
  recordedAtMicros: string;
  actorUserId: string | null;
  witnessUserId: string | null;
  channel: string | null;
  deviceId: string | null;
  sessionId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  payloadText: string;
};

/** The same text as `public.acct_event_canonical` (0044). Version 1. */
export function canonicalEvent(e: EventFields): string {
  return [
    'v1',
    e.seq,
    e.hospitalId,
    e.branchId ?? '',
    e.occurredAtMicros,
    e.recordedAtMicros,
    e.actorUserId ?? '',
    e.witnessUserId ?? '',
    e.channel ?? '',
    e.deviceId ?? '',
    e.sessionId ?? '',
    e.action,
    e.objectType,
    e.objectId ?? '',
    e.payloadText,
  ].join(UNIT);
}

/** A row's hash: the Merkle leaf hash of its canonical text. */
export const leafHash = (data: string | Buffer): Buffer =>
  sha256(LEAF, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);

export const eventHash = (e: EventFields): Buffer => leafHash(canonicalEvent(e));

/**
 * The Merkle tree hash (RFC 6962 MTH) over leaf hashes already computed:
 * split at the largest power of two below n, hash the halves, join with 0x01.
 */
export function merkleRoot(leaves: readonly Buffer[]): Buffer {
  if (leaves.length === 0) return sha256();
  const build = (from: number, to: number): Buffer => {
    const n = to - from;
    if (n === 1) return leaves[from];
    let k = 1;
    while (k * 2 < n) k *= 2;
    return sha256(NODE, build(from, from + k), build(from + k, to));
  };
  return build(0, leaves.length);
}

/** The digest before the first one. */
export const GENESIS_HASH = Buffer.alloc(32);

export type DigestFields = {
  hospitalId: string;
  digestNo: number;
  seqFrom: string;
  seqTo: string;
  eventCount: number;
  merkleRoot: Buffer;
  prevHash: Buffer;
};

export function canonicalDigest(d: DigestFields): string {
  return [
    'qurio-evidence-digest-v1',
    d.hospitalId,
    String(d.digestNo),
    d.seqFrom,
    d.seqTo,
    String(d.eventCount),
    d.merkleRoot.toString('hex'),
    d.prevHash.toString('hex'),
  ].join(UNIT);
}

export const digestHash = (d: DigestFields): Buffer => sha256(Buffer.from(canonicalDigest(d), 'utf8'));

/** A short, stable name for a signing key: the first 8 bytes of the SHA-256 of its raw public key. */
export const keyIdOf = (rawPublicKey: Buffer): string => sha256(rawPublicKey).subarray(0, 8).toString('hex');

/* ------------------------------------------------------------ verification */

export type EvidenceProblemCode =
  /** A digest's prev_hash is not the hash of the digest before it. */
  | 'chain_broken'
  /** A digest's own hash does not match its fields. */
  | 'digest_hash_mismatch'
  /** The signature does not verify with the evidence key. */
  | 'signature_invalid'
  /** The digests' seq ranges leave a gap or overlap. */
  | 'range_gap'
  /** More or fewer rows in the range than were sealed: rows added or removed. */
  | 'event_count_mismatch'
  /** The rows in the range do not hash to the sealed root: rows changed, added, removed or reordered. */
  | 'merkle_root_mismatch'
  /** A row's stored hash does not match its fields: the row was changed after it was written. */
  | 'row_hash_mismatch'
  /** The anchor copy kept outside the database differs from the digest. */
  | 'anchor_mismatch';

export type EvidenceProblem = { code: EvidenceProblemCode; digestNo: number | null; count?: number };

export const PROBLEM_TEXT: Record<EvidenceProblemCode, string> = {
  chain_broken: 'A seal does not follow on from the one before it.',
  digest_hash_mismatch: 'A seal’s details were changed after it was made.',
  signature_invalid: 'A seal’s signature does not match the evidence key.',
  range_gap: 'Some events fall between two seals.',
  event_count_mismatch: 'Events were added or removed after they were sealed.',
  merkle_root_mismatch: 'Sealed events no longer match their seal.',
  row_hash_mismatch: 'An event was changed after it was written.',
  anchor_mismatch: 'A seal differs from its copy kept outside the database.',
};

/* ------------------------------------------------------------------ labels */

/** What an event says on the Accountability page, in plain words. Unknown actions show as written. */
const LABELS: Record<string, string> = {
  'chart_entry.created': 'T.P.R. reading charted',
  'chart_entry.voided': 'T.P.R. reading struck through',
  'care_entry.created': 'Bedside item recorded',
  'care_entry.voided': 'Bedside item removed',
  'bill_item.created': 'Bill line added',
  'bill_item.voided': 'Bill line removed',
  'bill_item.changed': 'Bill line changed',
  'admission.created': 'Admission started',
  'admission.changed': 'Admission updated',
  'bed_assignment.created': 'Bed assigned',
  'bed_assignment.changed': 'Bed released',
  'record_access.created': 'Patient record opened',
  'policy_acknowledgement.created': 'Staff notice accepted',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.switch_user': 'Switched user on a ward tablet',
  'auth.pin_login': 'Unlocked a ward tablet with PIN',
  'auth.pin_failed': 'Wrong PIN',
  'auth.pin_set': 'PIN set',
  'auth.pin_reset': 'PIN cleared',
  'auth.session_locked': 'Screen locked',
  'auth.session_unlocked': 'Screen unlocked',
  'auth.signed_out_everywhere': 'Signed out everywhere',
  'auth.ward_device_created': 'Ward tablet added',
  'auth.ward_device_enrolled': 'Ward tablet enrolled',
  'auth.ward_device_revoked': 'Ward tablet removed',
  'auth.ward_device_locked': 'Ward tablet locked after wrong PINs',
  'module.changed': 'Module switched on or off',
  'evidence.viewed': 'Accountability page opened',
  'evidence.record_viewed': 'History viewed',
  'stock_movement.created': 'Stock movement',
  'stock_receipt.created': 'Stock received from supplier',
  'stock_transfer.created': 'Stock sent to a store',
  'stock_transfer.changed': 'Stock delivery taken in',
  'stock_transfer_line.created': 'Line on a stock delivery',
  'stock_transfer_line.changed': 'Line taken in',
  'stock_count.created': 'Stock count started',
  'stock_count.changed': 'Stock count updated',
  'stock_count_line.created': 'Count entered',
  'stock_count_line.changed': 'Count changed',
  'stock_adjustment.created': 'Stock adjustment asked',
  'stock_adjustment.changed': 'Stock adjustment decided',
  'service_point.created': 'Lab or room added',
  'service_point.changed': 'Lab or room changed',
  'service_point_staff.created': 'Staff added to a lab',
  'service_point_staff.changed': 'Staff removed from a lab',
  'test_order.created': 'Test ordered',
  'test_order.changed': 'Test updated',
  'test_call.created': 'Patient called about a test',
  'tests.service_point_created': 'Lab or room set up',
  'tests.service_point_changed': 'Lab or room settings changed',
  'tests.test_placed': 'Test assigned to a lab or room',
  'tests.order_cancelled': 'Test cancelled',
  'treatment_order.created': 'Treatment line written',
  'treatment_order.changed': 'Treatment line countersigned or stopped',
  'treatment_order.voided': 'Treatment line struck out',
  'mar_administration.created': 'Dose recorded',
  'mar_administration.changed': 'Dose witnessed or flagged',
  'mar_administration.voided': 'Dose struck out',
  'witness_request.created': 'Witness asked for',
  'witness_request.changed': 'Witness decided',
  'presence_proof.created': 'Bed code entered at the bedside',
  'mar.unlinked_risk_give': 'Risk-class medicine recorded without a treatment line',
  'due_escalation.created': 'Late time-critical dose escalated',
  'due_escalation.changed': 'Escalation acknowledged',
  'due_snooze.created': 'Time-critical alert put off',
  'time_critical_signoff.created': 'Time-critical list signed off',
  'on_call_assignment.created': 'Doctor on call added',
  'on_call_assignment.changed': 'Doctor on call removed',
  'mar.time_critical_set': 'Medicine marked time-critical (or not)',
  'mar.due_settings': 'Dose windows or escalation changed',
  'mar.ward_in_charge': 'Ward in-charge set',
  'mar.bed_code_wrong': 'Wrong bed code entered',
  'stock.risk_class_witness': 'Risk class witness rule changed',
  'evidence.verified': 'Evidence log checked',
  'evidence.verification_failed': 'Evidence log check FAILED',
  'support.impersonation.start': 'QuriioHQ support opened this hospital',
  'support.impersonation.end': 'QuriioHQ support left this hospital',
};

export const eventLabel = (action: string): string => LABELS[action] ?? action;

/** Filters on the Accountability page: each a set of action prefixes. */
export const EVENT_FAMILIES = {
  charting: { label: 'Charting', prefixes: ['chart_entry.'] },
  bedside: { label: 'Bedside items', prefixes: ['care_entry.'] },
  billing: { label: 'Billing', prefixes: ['bill_item.', 'billing.', 'payment.'] },
  admissions: { label: 'Admissions and beds', prefixes: ['admission.', 'bed_assignment.', 'ipd.'] },
  stock: { label: 'Risk-class stock', prefixes: ['stock_', 'stock.'] },
  treatment: {
    label: 'Treatment and MAR',
    prefixes: ['treatment_order', 'mar_', 'mar.', 'witness_request', 'presence_proof', 'due_', 'time_critical', 'on_call'],
  },
  tests: { label: 'Tests and follow-up', prefixes: ['test_', 'service_point', 'tests.'] },
  records: { label: 'Records opened', prefixes: ['record_access.'] },
  access: { label: 'Sign-in and access', prefixes: ['auth.', 'support.', 'policy_acknowledgement.'] },
  settings: { label: 'Settings', prefixes: ['module.', 'letterhead.', 'medicine.', 'doctor.', 'capacity.', 'whatsapp.'] },
  evidence: { label: 'This log', prefixes: ['evidence.'] },
} as const;

export type EventFamily = keyof typeof EVENT_FAMILIES;

export const isEventFamily = (value: string): value is EventFamily => value in EVENT_FAMILIES;

/* ------------------------------------------------------------ history lines */

const ADMISSION_STATUS_TEXT: Record<string, string> = {
  awaiting_bed: 'waiting for a bed',
  admitted: 'in a bed',
  discharge_ready: 'ready for discharge',
  discharged: 'discharged',
  cancelled: 'cancelled',
};

const ACCESS_TEXT: Record<string, string> = {
  view_admission: 'opened the patient file',
  print_ipd_file: 'printed the patient file',
  view_file_upload: 'opened an attached file',
  family_unlock: 'family opened the status page',
};

const TEST_STATUS_TEXT: Record<string, string> = {
  ordered: 'not arrived',
  arrived: 'arrived',
  done: 'test done',
  reported: 'report added',
  not_coming: 'not coming',
  cancelled: 'cancelled',
};

const TEST_OUTCOME_TEXT: Record<string, string> = {
  no_answer: 'no answer',
  coming_now: 'coming now',
  told_the_way: 'told the way',
  will_come_later: 'will come later',
  went_home: 'went home',
  refused_cost: 'refused: cost',
  refused_fear: 'refused: fear',
  refused_other: 'refused: other',
};

/**
 * What an event's numbers say, in one short line for the History view: the
 * reading, the quantity, the amount, the new status. Null when the label
 * says it all. Built from the payload only (ids, numbers, codes).
 */
export function eventDetail(action: string, payload: Record<string, unknown>): string | null {
  const num = (key: string): number | null => (typeof payload[key] === 'number' ? (payload[key] as number) : null);
  const text = (key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null);
  switch (action) {
    case 'chart_entry.created': {
      const line = readingSummary({
        pulse: num('pulse'),
        bpSystolic: num('bp_systolic'),
        bpDiastolic: num('bp_diastolic'),
        spo2: num('spo2'),
        tempFTenths: num('temp_f_tenths'),
        bslMgDl: num('bsl_mg_dl'),
        respRate: num('resp_rate'),
        abdGirthCm: num('abd_girth_cm'),
        urineMl: num('urine_ml'),
        drainMl: num('drain_ml'),
        rtAspirateMl: num('rt_aspirate_ml'),
        oralMl: num('oral_ml'),
        ivMl: num('iv_ml'),
      });
      return payload.on_oxygen === true ? `${line} · on oxygen` : line;
    }
    case 'care_entry.created':
      return num('quantity') === null ? null : `× ${num('quantity')}`;
    case 'bill_item.created':
    case 'bill_item.changed': {
      const parts = [num('total_paise') === null ? null : formatRupees(num('total_paise')!)];
      if (num('quantity') !== null) parts.push(`× ${num('quantity')}`);
      if (num('discount_paise')) parts.push(`discount ${formatRupees(num('discount_paise')!)}`);
      return parts.filter(Boolean).join(' · ') || null;
    }
    case 'admission.created':
    case 'admission.changed': {
      const parts: string[] = [];
      const status = text('status');
      if (status) parts.push(ADMISSION_STATUS_TEXT[status] ?? status);
      if (num('ipd_number') !== null) parts.push(`IPD No. ${num('ipd_number')}`);
      return parts.join(' · ') || null;
    }
    case 'bed_assignment.changed':
      return text('to_at') ? 'left the bed' : null;
    case 'record_access.created': {
      const what = text('action');
      return what ? (ACCESS_TEXT[what] ?? what) : null;
    }
    case 'stock_movement.created': {
      const kinds: Record<string, string> = {
        receive: 'received',
        transfer_out: 'sent out',
        transfer_in: 'taken in',
        give: 'used',
        waste: 'wasted',
        return: 'returned',
        adjust: 'adjusted',
        count_variance: 'count difference',
      };
      const quantity = num('quantity');
      const kind = text('kind');
      const parts = [kind ? (kinds[kind] ?? kind) : null, quantity === null ? null : `${quantity > 0 ? '+' : ''}${quantity}`];
      if (text('source') === 'manual_register') parts.push('from the paper register');
      return parts.filter(Boolean).join(' · ') || null;
    }
    case 'stock_count.changed':
      return text('status');
    case 'stock_count_line.created':
    case 'stock_count_line.changed': {
      const parts: string[] = [];
      if (num('counted_qty') !== null) parts.push(`counted ${num('counted_qty')}`);
      if (num('book_qty') !== null) parts.push(`books ${num('book_qty')}`);
      if (num('variance')) parts.push(`difference ${num('variance')! > 0 ? '+' : ''}${num('variance')}`);
      return parts.join(' · ') || null;
    }
    case 'stock_adjustment.created':
    case 'stock_adjustment.changed':
      return [num('quantity') === null ? null : `${num('quantity')! > 0 ? '+' : ''}${num('quantity')}`, text('reason_code'), text('status')]
        .filter(Boolean)
        .join(' · ');
    case 'mar_administration.created':
    case 'mar_administration.changed': {
      const parts = [text('state'), num('quantity') ? `× ${num('quantity')}` : null, text('reason_code')];
      const witness = text('witness_status');
      if (witness && witness !== 'not_needed') parts.push(`witness ${witness}`);
      const flags = Array.isArray(payload.control_flags) ? (payload.control_flags as string[]) : [];
      if (flags.length) parts.push(`flags: ${flags.join(', ')}`);
      return parts.filter(Boolean).join(' · ') || null;
    }
    case 'due_escalation.created':
    case 'due_escalation.changed':
      return [num('level') ? `level ${num('level')}` : null, text('mode') === 'observe' ? 'counted only (observe)' : null, text('target')?.replace(/_/g, ' ') ?? null]
        .filter(Boolean)
        .join(' · ');
    case 'witness_request.created':
    case 'witness_request.changed':
      return [text('method') === 'ward_device' ? 'on the ward tablet' : 'by approval', text('status')].filter(Boolean).join(' · ');
    case 'test_order.created':
    case 'test_order.changed': {
      const status = text('status');
      const parts = [status ? (TEST_STATUS_TEXT[status] ?? status) : null];
      if (text('escalated_at')) parts.push('raised to the admin');
      else if (text('task_raised_at')) parts.push('not-arrived task raised');
      if (text('closed_reason')) parts.push(TEST_OUTCOME_TEXT[text('closed_reason')!] ?? text('closed_reason'));
      return parts.filter(Boolean).join(' · ') || null;
    }
    case 'test_call.created': {
      const outcome = text('outcome');
      return outcome ? (TEST_OUTCOME_TEXT[outcome] ?? outcome) : null;
    }
    case 'evidence.verified':
    case 'evidence.verification_failed':
      return `${num('digests') ?? 0} seals, ${num('events') ?? 0} events`;
    default:
      return null;
  }
}
