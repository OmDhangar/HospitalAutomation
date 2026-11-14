import { describe, expect, it } from 'vitest';
import {
  editDistance,
  phoneticKey,
  scorePatientMatch,
  type MatchCandidate,
} from '../patient-match';

describe('Indian Phonetic Tokenizer (phoneticKey)', () => {
  it('normalizes common Indian name transliteration variants', () => {
    // Patil vs Patel
    expect(phoneticKey('Patil')).toBe(phoneticKey('Patel'));

    // Pooja vs Puja
    expect(phoneticKey('Pooja')).toBe(phoneticKey('Puja'));

    // Choudhary vs Chaudhary vs Chowdhry
    expect(phoneticKey('Choudhary')).toBe(phoneticKey('Chaudhary'));

    // Joshi vs Joshee
    expect(phoneticKey('Joshi')).toBe(phoneticKey('Joshee'));

    // Vikas vs Bikas / Wani vs Vani
    expect(phoneticKey('Vikas')).toBe(phoneticKey('Wikas'));

    // Shinde vs Scindia
    expect(phoneticKey('Shinde')).toBe(phoneticKey('Sinde'));
  });

  it('normalizes duplicate consecutive characters and trailing vowels', () => {
    expect(phoneticKey('Ramesh')).toBe(phoneticKey('Ramesha'));
    expect(phoneticKey('Suresh')).toBe(phoneticKey('Suresha'));
    expect(phoneticKey('Kulkarni')).toBe(phoneticKey('Koolkarni'));
  });
});

describe('Edit Distance (Damerau-Levenshtein)', () => {
  it('computes distance for single mutations and transpositions', () => {
    expect(editDistance('ramesh', 'ramesh')).toBe(0);
    expect(editDistance('ramesh', 'ramsh')).toBe(1); // deletion
    expect(editDistance('ramesh', 'rameesh')).toBe(1); // insertion
    expect(editDistance('ramesh', 'ramesp')).toBe(1); // substitution
    expect(editDistance('patil', 'patli')).toBe(1); // transposition
    expect(editDistance('ramesh', 'somesh')).toBe(2);
    expect(editDistance('ramesh', 'suresh')).toBe(3);
  });
});

describe('Multi-Factor Match Confidence Scoring (scorePatientMatch)', () => {
  const base: MatchCandidate = {
    nameKey: 'ramesh patil',
    birthYear: 1984,
    phoneE164: '+919800000001',
    gender: 'M',
  };

  it('returns exact match (score 100) when phone and nameKey match identically', () => {
    const res = scorePatientMatch(base, { ...base });
    expect(res.tier).toBe('exact');
    expect(res.score).toBe(100);
    expect(res.isProbableDuplicate).toBe(true);
    expect(res.isFamilyPhone).toBe(false);
  });

  it('returns high match (score >= 85) when phone matches and name is phonetic equivalent or typo', () => {
    // ramesh patel vs ramesh patil on same phone
    const res = scorePatientMatch(base, {
      ...base,
      nameKey: 'ramesh patel',
    });
    expect(res.tier).toBe('high');
    expect(res.score).toBeGreaterThanOrEqual(85);
    expect(res.isProbableDuplicate).toBe(true);
  });

  it('returns high match when exact name and demographics match without phone', () => {
    const res = scorePatientMatch(base, {
      nameKey: 'ramesh patil',
      birthYear: 1984,
      phoneE164: null,
      gender: 'M',
    });
    expect(res.tier).toBe('high');
    expect(res.score).toBeGreaterThanOrEqual(80);
    expect(res.isProbableDuplicate).toBe(true);
  });

  it('returns medium match (family phone) when phone matches but name is distinctly different', () => {
    const res = scorePatientMatch(base, {
      nameKey: 'sunita patil',
      birthYear: 1988,
      phoneE164: '+919800000001',
      gender: 'F',
    });
    expect(res.tier).toBe('medium');
    expect(res.isFamilyPhone).toBe(true);
    expect(res.isProbableDuplicate).toBe(false);
  });

  it('returns none when neither phone nor name demographics match', () => {
    const res = scorePatientMatch(base, {
      nameKey: 'gita deshmukh',
      birthYear: 1995,
      phoneE164: '+919999999999',
      gender: 'F',
    });
    expect(res.tier).toBe('none');
    expect(res.score).toBe(0);
    expect(res.isProbableDuplicate).toBe(false);
  });
});
