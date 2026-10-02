import { parseRupeesToPaise } from './patient-billing';
import type { ParseResult } from './medicine';

/**
 * Who pays for a stay, as reception records it on the admission sheet (IPD
 * plan §5.3; decision D-AD moved this from discharge to admission).
 *
 * "Self" needs nothing more. Anyone else needs a name — the bill shows who the
 * share was claimed from — and may carry a policy number and the pre-
 * authorised amount. The approved amount comes later, at discharge.
 */

export const PAYER_KINDS = ['self', 'insurer', 'tpa', 'corporate'] as const;
export type PayerKind = (typeof PAYER_KINDS)[number];

export const PAYER_KIND_LABELS: Record<PayerKind, string> = {
  self: 'Self',
  insurer: 'Insurer',
  tpa: 'TPA',
  corporate: 'Corporate',
};

export const isPayerKind = (value: string): value is PayerKind =>
  (PAYER_KINDS as readonly string[]).includes(value);

export type PayerInput = {
  kind: PayerKind;
  payerName: string | null;
  policyNumber: string | null;
  preauthAmountPaise: number | null;
};

const tidy = (value: string | null | undefined): string | null => {
  const text = (value ?? '').trim().replace(/\s+/g, ' ');
  return text === '' ? null : text;
};

/** Reads the payer block of a form. Self clears the other fields. */
export function parsePayerInput(raw: {
  kind?: string | null;
  payerName?: string | null;
  policyNumber?: string | null;
  preauthRupees?: string | null;
}): ParseResult<PayerInput> {
  const kind = (raw.kind ?? 'self').trim() || 'self';
  if (!isPayerKind(kind)) return { ok: false, error: 'Choose who is paying' };
  if (kind === 'self') {
    return { ok: true, value: { kind, payerName: null, policyNumber: null, preauthAmountPaise: null } };
  }

  const payerName = tidy(raw.payerName);
  if (!payerName) return { ok: false, error: `Enter the ${PAYER_KIND_LABELS[kind]}’s name` };
  if (payerName.length > 120) return { ok: false, error: 'The payer’s name is too long' };
  const policyNumber = tidy(raw.policyNumber);
  if (policyNumber && policyNumber.length > 60) return { ok: false, error: 'The policy number is too long' };

  const preauth = tidy(raw.preauthRupees);
  let preauthAmountPaise: number | null = null;
  if (preauth) {
    preauthAmountPaise = parseRupeesToPaise(preauth);
    if (preauthAmountPaise === null) return { ok: false, error: 'Enter the pre-auth amount in rupees' };
  }
  return { ok: true, value: { kind, payerName, policyNumber, preauthAmountPaise } };
}

/** A deposit as typed: blank means none; otherwise a positive rupee amount. */
export function parseDepositRupees(raw: string | null | undefined): ParseResult<number | null> {
  const text = (raw ?? '').trim();
  if (text === '') return { ok: true, value: null };
  const paise = parseRupeesToPaise(text);
  if (paise === null || paise <= 0) return { ok: false, error: 'Enter the deposit in rupees, like 5000' };
  return { ok: true, value: paise };
}
