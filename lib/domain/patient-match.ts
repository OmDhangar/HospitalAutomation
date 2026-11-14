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

/* ------------------------------------------------------------------ phonetics & multi-factor */

/**
 * Phonetic transliteration key for Indian names. Normalizes widespread English spelling variations:
 * - Vowels: ee -> i, oo -> u, ou/au/ow -> o, ai/ay -> e, aa -> a, e -> i
 * - Consonants: w -> v, ph -> f, sh/sch -> s, ch -> c, ksh/x -> x, dh -> d, th -> t, bh -> b, gh -> g, kh -> k
 * - Deduplicates consecutive identical letters
 * - Strips trailing 'a' on tokens of length > 4 (e.g. Ramesha -> Ramesh, Suresha -> Suresh)
 */
export function phoneticKey(name: string): string {
  const base = nameKey(name);
  if (!base) return '';

  return base
    .split(' ')
    .filter(Boolean)
    .map((rawToken) => {
      let t = rawToken.toLowerCase();

      // Transliteration normalizations
      t = t.replace(/ee/g, 'i')
           .replace(/oo/g, 'u')
           .replace(/ou|au|ow/g, 'o')
           .replace(/ai|ay/g, 'e')
           .replace(/aa/g, 'a')
           .replace(/ph/g, 'f')
           .replace(/sh|sch/g, 's')
           .replace(/ch/g, 'c')
           .replace(/ksh/g, 'x')
           .replace(/dh/g, 'd')
           .replace(/th/g, 't')
           .replace(/bh/g, 'b')
           .replace(/gh/g, 'g')
           .replace(/kh/g, 'k')
           .replace(/w/g, 'v')
           .replace(/e/g, 'i');

      // Deduplicate consecutive identical characters (e.g. tt -> t, ll -> l, kk -> k)
      t = t.replace(/(.)\1+/g, '$1');

      // Strip trailing 'a' on tokens longer than 4 characters (Suresha -> Suresh, Ramesha -> Ramesh)
      if (t.length > 4 && t.endsWith('a')) {
        t = t.slice(0, -1);
      }

      return t;
    })
    .join(' ');
}

/**
 * Damerau-Levenshtein edit distance: insertions, deletions, substitutions, and adjacent transpositions.
 */
export function editDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const d: number[][] = Array.from({ length: al + 1 }, () => Array(bl + 1).fill(0));

  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost, // substitution
      );

      // Transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }

  return d[al][bl];
}

export type MatchTier = 'exact' | 'high' | 'medium' | 'weak' | 'none';

export type MultiFactorMatchResult = {
  tier: MatchTier;
  score: number;
  reasons: string[];
  isFamilyPhone: boolean;
  isProbableDuplicate: boolean;
};

/**
 * High-confidence multi-factor patient duplicate matching.
 */
export function scorePatientMatch(typed: MatchCandidate, existing: MatchCandidate): MultiFactorMatchResult {
  const samePhone = typed.phoneE164 != null && typed.phoneE164 === existing.phoneE164;
  const exactName = typed.nameKey !== '' && typed.nameKey === existing.nameKey;
  const pTyped = phoneticKey(typed.nameKey);
  const pExist = phoneticKey(existing.nameKey);
  const samePhonetic = pTyped !== '' && pTyped === pExist;
  const dist = editDistance(typed.nameKey, existing.nameKey);
  const fuzzyName = samePhonetic || (dist <= 2 && typed.nameKey.length >= 5 && existing.nameKey.length >= 5);

  const years =
    typed.birthYear != null && existing.birthYear != null
      ? Math.abs(typed.birthYear - existing.birthYear)
      : null;
  const sameGender = Boolean(typed.gender && existing.gender && typed.gender === existing.gender);

  // Exact Match: Same Phone & Exact NameKey
  if (samePhone && exactName) {
    return {
      tier: 'exact',
      score: 100,
      reasons: ['same_phone_exact_name'],
      isFamilyPhone: false,
      isProbableDuplicate: true,
    };
  }

  // High Match: Same Phone & Phonetic/Fuzzy Name (Typo or spelling variant)
  if (samePhone && fuzzyName) {
    return {
      tier: 'high',
      score: 90,
      reasons: ['same_phone_phonetic_name'],
      isFamilyPhone: false,
      isProbableDuplicate: true,
    };
  }

  // High Match: Exact Name & Demographics Match (No Phone or Matching Phone)
  if (exactName && ((years != null && years <= 1) || (years == null && sameGender) || typed.phoneE164 == null)) {
    return {
      tier: 'high',
      score: 85,
      reasons: ['exact_name_matching_demographics'],
      isFamilyPhone: false,
      isProbableDuplicate: true,
    };
  }

  // Medium Match: Same Phone, but distinctly different name (Shared Family Mobile)
  if (samePhone && !exactName && !fuzzyName) {
    return {
      tier: 'medium',
      score: 70,
      reasons: ['family_phone_distinct_name'],
      isFamilyPhone: true,
      isProbableDuplicate: false,
    };
  }

  // Medium Match: Phonetic Name match with matching demographics across different phones
  if (fuzzyName && (sameGender || (years != null && years <= 2))) {
    return {
      tier: 'medium',
      score: 60,
      reasons: ['phonetic_name_matching_demographics'],
      isFamilyPhone: false,
      isProbableDuplicate: false,
    };
  }

  // Weak Match: Exact Name but conflicting gender or large birth year gap
  if (exactName) {
    return {
      tier: 'weak',
      score: 30,
      reasons: ['name_match_divergent_demographics'],
      isFamilyPhone: false,
      isProbableDuplicate: false,
    };
  }

  return {
    tier: 'none',
    score: 0,
    reasons: [],
    isFamilyPhone: false,
    isProbableDuplicate: false,
  };
}
