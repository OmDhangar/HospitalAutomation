import { describe, expect, it } from 'vitest';
import { birthYearFromAge, NAME_KEY_PUNCTUATION, nameKey, scoreMatch } from '../patient-match';

const ch = (...codes: number[]) => String.fromCharCode(...codes);
const ZWJ = ch(0x200d);
const ZWNJ = ch(0x200c);

/** The same corpus the SQL equivalence test runs against qurio_name_key(). */
export const NAME_KEY_CORPUS: Array<[string, string]> = [
  ['  Ramesh  B. Patil ', 'ramesh b patil'],
  ['RAMESH PATIL', 'ramesh patil'],
  ['शोभाबाई  पाटील,', 'शोभाबाई पाटील'],
  ['शोभाबाई पाटील', 'शोभाबाई पाटील'],
  ['राम', 'राम'],
  ['रम', 'रम'],
  ['Sunita दिनेश पाटील', 'sunita दिनेश पाटील'],
  ['Sunita', 'sunita'],
  ['सुनीता', 'सुनीता'],
  ['O' + ch(0x2019) + 'Brien', 'obrien'],
  ["D'Souza", 'dsouza'],
  ['Mary-Ann', 'mary ann'],
  ['Name - Shobhabai Age-49 year/female', 'name shobhabai age 49 year female'],
  ['क्' + ZWJ + 'ष', 'क्' + ZWJ + 'ष'],
  ['क्' + ZWNJ + 'ष', 'क्' + ZWNJ + 'ष'],
  [ch(0x0958), ch(0x0915, 0x093c)],
  ['राम' + ch(0x0964), 'राम'],
  ['राम' + ch(0x0965) + ' श्याम', 'राम श्याम'],
  ['Ram' + ch(0x00a0, 0x2003) + 'Patil' + ch(0x09), 'ram patil'],
  ['Ram' + ch(0x3000) + 'Patil', 'ram patil'],
  ['Ram' + ch(0x200b) + 'Patil', 'rampatil'],
  [ch(0xfeff) + 'Ram', 'ram'],
  ['ÄNDREA', 'Ändrea'],
  ['१२३ राम', '१२३ राम'],
  [ch(0x201c) + 'Ramesh' + ch(0x201d) + ' ' + ch(0x2014) + ' Patil' + ch(0x2026), 'ramesh patil'],
  ['Ramesh' + ch(0x00b7) + 'Patil', 'ramesh patil'],
  ['!!!', ''],
  ['   ', ''],
];

describe('nameKey', () => {
  it.each(NAME_KEY_CORPUS)('%j -> %j', (input, expected) => {
    expect(nameKey(input)).toBe(expected);
  });

  it('maps each of the 39 punctuation characters to a space, one by one', () => {
    expect(NAME_KEY_PUNCTUATION).toHaveLength(39);
    for (const p of NAME_KEY_PUNCTUATION) expect(nameKey('a' + p + 'b')).toBe('a b');
  });

  it('keeps Devanagari vowel signs and virama (a letters-only rule would drop them)', () => {
    expect(nameKey('राम')).not.toBe(nameKey('रम'));
  });
});

describe('birthYearFromAge', () => {
  it('derives a year and refuses nonsense', () => {
    const now = new Date(Date.UTC(2026, 9, 9));
    expect(birthYearFromAge(42, now)).toBe(1984);
    expect(birthYearFromAge(null, now)).toBeNull();
    expect(birthYearFromAge(-1, now)).toBeNull();
    expect(birthYearFromAge(200, now)).toBeNull();
  });
});

describe('scoreMatch', () => {
  const base = { nameKey: 'ramesh patil', birthYear: 1984, phoneE164: '+919800000001', gender: 'M' };

  it('same name and birth year within one year is possible, never strong', () => {
    expect(scoreMatch(base, { ...base, birthYear: 1985, phoneE164: null })).toBe('possible');
    expect(scoreMatch(base, { ...base, birthYear: 1987, phoneE164: null })).toBe('none');
  });

  it('a phone alone is weak; a phone plus the same first name is possible', () => {
    expect(scoreMatch(base, { ...base, nameKey: 'sunita patil', birthYear: 1990 })).toBe('weak');
    expect(scoreMatch(base, { ...base, nameKey: 'ramesh b patil', birthYear: 1950 })).toBe('possible');
  });

  it('a different name and birth year with no shared phone is never suggested', () => {
    expect(scoreMatch(base, { nameKey: 'gita', birthYear: 1990, phoneE164: null, gender: 'F' })).toBe('none');
  });
});
