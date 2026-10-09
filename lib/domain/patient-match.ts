/**
 * Patient matching helpers. Matching only ever *suggests*: nothing here links,
 * creates or merges a person by itself.
 */

const fromCodes = (...codes: number[]) => new Set(codes.map((c) => String.fromCharCode(c)));

/** Deleted outright: apostrophes, and invisible format characters (ZWJ/ZWNJ are kept). */
const DELETED = fromCodes(0x0027, 0x2018, 0x2019, 0x200b, 0x2060, 0xfeff);

/**
 * Replaced with a space: the 31 ASCII punctuation characters other than the
 * apostrophe, plus curly quotes, en/em dash, ellipsis, middle dot, danda and
 * double danda. Written as code points so no escape can silently drop one.
 */
const PUNCTUATION = fromCodes(
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
  0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x7b,
  0x7c, 0x7d, 0x7e,
  0x201c, 0x201d, 0x2013, 0x2014, 0x2026, 0x00b7, 0x0964, 0x0965,
);

/** Collapsed to a single space. */
const WHITESPACE = fromCodes(
  0x20, 0x09, 0x0a, 0x0d, 0x00a0,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x202f, 0x3000,
);

/**
 * The canonical matching key of a name. An exact mirror of `qurio_name_key()`
 * in 0039_persons_qid.sql, which derives the stored key; change both together.
 *
 * NFC, delete apostrophes and invisible format characters, punctuation to
 * space, lowercase ASCII A-Z only, collapse whitespace, trim. Devanagari
 * letters, vowel signs, virama, nukta and digits are never removed, and
 * nothing is transliterated, so "Sunita" and "सुनीता" stay different keys.
 */
export function nameKey(name: string): string {
  let out = '';
  for (const ch of name.normalize('NFC')) {
    if (DELETED.has(ch)) continue;
    if (PUNCTUATION.has(ch) || WHITESPACE.has(ch)) {
      out += ' ';
      continue;
    }
    const code = ch.charCodeAt(0);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
  }
  return out.split(' ').filter(Boolean).join(' ');
}

/** The 39 punctuation characters, exported so tests can check each one. */
export const NAME_KEY_PUNCTUATION: readonly string[] = [...PUNCTUATION];

/** Birth year implied by an age given today; ages are approximate, so matching allows ±1. */
export function birthYearFromAge(age: number | null | undefined, now: Date = new Date()): number | null {
  if (age == null || !Number.isInteger(age) || age < 0 || age > 130) return null;
  return now.getUTCFullYear() - age;
}

export type MatchStrength = 'strong' | 'possible' | 'weak' | 'none';

export type MatchCandidate = {
  nameKey: string;
  birthYear: number | null;
  phoneE164: string | null;
  gender: string | null;
};

/**
 * How strongly an existing patient in this hospital matches what the desk has
 * typed. Strong evidence (a chosen profile, a verified QID) never comes through
 * here; this only ranks suggestions:
 *
 * - possible: same name key and birth year within one year; same name key and
 *   gender with no birth year on either side; or same phone and a name key
 *   that shares its first word (the family-phone case).
 * - weak: same phone only, so the profile is listed but nothing is implied.
 */
export function scoreMatch(typed: MatchCandidate, existing: MatchCandidate): MatchStrength {
  const sameName = typed.nameKey !== '' && typed.nameKey === existing.nameKey;
  const years =
    typed.birthYear != null && existing.birthYear != null
      ? Math.abs(typed.birthYear - existing.birthYear)
      : null;
  if (sameName && years != null && years <= 1) return 'possible';
  if (sameName && years == null && typed.gender && typed.gender === existing.gender) return 'possible';

  const samePhone = typed.phoneE164 != null && typed.phoneE164 === existing.phoneE164;
  if (samePhone) {
    const first = (k: string) => k.split(' ')[0] ?? '';
    if (first(typed.nameKey) !== '' && first(typed.nameKey) === first(existing.nameKey)) return 'possible';
    return 'weak';
  }
  return 'none';
}
