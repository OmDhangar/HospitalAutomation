/**
 * IPD numbers (IPD sheets plan §11.1 A4-min): the "IPD No." on every sheet.
 *
 * Given when a patient first gets a bed, from `document_sequences` (kind
 * `ipd_number`). They run on across years, as the pilot's do (its paper bill
 * shows IPD No. 6158), so the sequence uses one fixed "year" that never resets.
 * A number, once given, is never given again — not after an undo, not after a
 * cancellation — so the owner may move the next number up, never down.
 */

export const IPD_NUMBER_KIND = 'ipd_number';
/** `document_sequences.fiscal_year` for a sequence that never resets. */
export const IPD_NUMBER_NEVER_RESETS = '0000-00';
export const MAX_IPD_NUMBER = 99_999_999;

export class IpdNumberError extends Error {}

/**
 * The owner types the next IPD No. to use (to continue from their register).
 * Returns the value to store as the sequence's last number.
 */
export function parseNextIpdNumber(
  raw: string,
  current: { lastNumber: number; highestGiven: number },
): { lastNumber: number } {
  const text = raw.trim().replace(/[,\s]/g, '');
  if (!/^\d+$/.test(text)) throw new IpdNumberError('Type the next IPD number as digits, e.g. 6159');
  const next = Number(text);
  if (next < 1 || next > MAX_IPD_NUMBER) throw new IpdNumberError(`The IPD number must be between 1 and ${MAX_IPD_NUMBER}`);
  const floor = Math.max(current.lastNumber, current.highestGiven);
  if (next <= floor) {
    throw new IpdNumberError(
      `IPD No. ${floor} is already used, so the next number must be ${floor + 1} or more. Numbers are never reused.`,
    );
  }
  return { lastNumber: next - 1 };
}

/** What the next admission will get. */
export const nextIpdNumber = (current: { lastNumber: number; highestGiven: number }) =>
  Math.max(current.lastNumber, current.highestGiven) + 1;

export const formatIpdNumber = (value: number | null): string => (value === null ? '—' : String(value));
