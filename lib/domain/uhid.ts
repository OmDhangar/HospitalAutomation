/**
 * QID: Qurio's platform-wide patient identity, e.g. QID-8K4M-2P7R.
 *
 * Eight symbols from the Crockford base32 alphabet (no I, L, O, U, so 0/O and
 * 1/I cannot be confused): seven random symbols and one Luhn mod-32 check
 * symbol. Random rather than sequential, so it reveals nothing about patient
 * counts and cannot be guessed, and never derived from a name or phone.
 *
 * The database is the final integrity boundary: `qurio_is_valid_qid` in
 * 0039_persons_qid.sql rejects any QID this module would reject, and the
 * equivalence test pins the two together. This copy exists for fast feedback
 * and to refuse typos before any database call.
 *
 * Guarantees of the check symbol, and only these:
 * - every single-symbol substitution is detected (the doubling map is a
 *   permutation of 0..31);
 * - every adjacent transposition of a valid QID is detected. Luhn mod 32 has
 *   exactly one blind spot, 0 <-> Z, and a valid QID never contains 0Z or Z0.
 * Jump transpositions and multi-symbol errors are caught only probabilistically.
 */

export const QID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE = 32;
const QID_RE = /^QID-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

const doubled = (v: number) => Math.floor((2 * v) / BASE) + ((2 * v) % BASE);

/** The check symbol for a 7-symbol payload, or null if the payload is not 7 alphabet symbols. */
export function qidCheckSymbol(payload: string): string | null {
  if (payload.length !== 7) return null;
  let sum = 0;
  for (let i = payload.length - 1, dbl = true; i >= 0; i -= 1, dbl = !dbl) {
    const v = QID_ALPHABET.indexOf(payload[i]);
    if (v < 0) return null;
    sum += dbl ? doubled(v) : v;
  }
  return QID_ALPHABET[(BASE - (sum % BASE)) % BASE];
}

const symbolsOf = (qid: string) => qid.slice(4, 8) + qid.slice(9, 13);
const hasZeroZBlindSpot = (symbols: string) => symbols.includes('0Z') || symbols.includes('Z0');

/** A canonical, valid QID: exact format, no adjacent 0/Z, correct check symbol. */
export function isValidQid(qid: string): boolean {
  if (!QID_RE.test(qid)) return false;
  const symbols = symbolsOf(qid);
  if (hasZeroZBlindSpot(symbols)) return false;
  return qidCheckSymbol(symbols.slice(0, 7)) === symbols[7];
}

export function formatQid(symbols: string): string {
  return `QID-${symbols.slice(0, 4)}-${symbols.slice(4, 8)}`;
}

/**
 * Turns what a person typed or scanned into the canonical form, or null.
 * Accepts lower case, missing or extra dashes and spaces, an optional QID
 * prefix, and the look-alikes O (zero), I and L (one).
 */
export function normalizeQid(input: string): string | null {
  let s = input.trim().toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith('QID')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 8) return null;
  const qid = formatQid(s);
  return isValidQid(qid) ? qid : null;
}

/** Uniform random symbols from a CSPRNG; 32 divides 256, so masking a byte is unbiased. */
function randomPayload(): string {
  const bytes = new Uint8Array(7);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += QID_ALPHABET[b & (BASE - 1)];
  return out;
}

/**
 * A new QID. Candidates containing 0Z or Z0 anywhere (check symbol included)
 * are discarded, about 1.3% of draws, which closes the one transposition
 * blind spot of Luhn mod 32. Uniqueness is the database's job: the caller
 * retries on a unique violation.
 */
export function generateQid(payload: () => string = randomPayload): string {
  for (;;) {
    const p = payload();
    const symbols = p + (qidCheckSymbol(p) ?? '');
    if (symbols.length === 8 && !hasZeroZBlindSpot(symbols)) return formatQid(symbols);
  }
}
