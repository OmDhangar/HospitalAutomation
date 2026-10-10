import { describe, expect, it } from 'vitest';
import { formatQid, generateQid, isValidQid, normalizeQid, QID_ALPHABET, qidCheckSymbol } from '../uhid';

const symbolsOf = (qid: string) => qid.slice(4, 8) + qid.slice(9, 13);
const withCheck = (payload: string) => formatQid(payload + qidCheckSymbol(payload));

describe('QID check symbol: proven properties, tested exhaustively', () => {
  /**
   * The checksum is a sum of independent per-position terms, so whether a
   * change at position i is detected depends only on the old and new symbol
   * at i (and their neighbour, for a transposition). Testing every pair at
   * every position over one fixed context therefore covers every payload.
   */
  const context = '8K4M2P7';

  it('detects every single-symbol substitution at every position', () => {
    const valid = context + qidCheckSymbol(context);
    let undetected = 0;
    for (let i = 0; i < 8; i += 1) {
      for (const c of QID_ALPHABET) {
        if (c === valid[i]) continue;
        const changed = valid.slice(0, i) + c + valid.slice(i + 1);
        if (qidCheckSymbol(changed.slice(0, 7)) === changed[7]) undetected += 1;
      }
    }
    expect(undetected).toBe(0);
  });

  it('detects every adjacent transposition except 0<->Z, which valid QIDs exclude', () => {
    const blind = new Set<string>();
    for (let i = 0; i < 7; i += 1) {
      for (const a of QID_ALPHABET) {
        for (const b of QID_ALPHABET) {
          if (a === b) continue;
          // A valid word with a, b at positions i, i+1 (the check symbol may be one of them).
          const payload = (context.slice(0, i) + a + b + context.slice(i + 2)).slice(0, 7);
          const word = payload + qidCheckSymbol(payload);
          if (word[i] !== a || word[i + 1] !== b) continue;
          const swapped = word.slice(0, i) + b + a + word.slice(i + 2);
          if (qidCheckSymbol(swapped.slice(0, 7)) === swapped[7]) blind.add([a, b].sort().join(''));
        }
      }
    }
    expect([...blind]).toEqual(['0Z']);
  });
});

describe('isValidQid', () => {
  it('accepts a canonical QID and rejects a wrong check symbol', () => {
    const qid = withCheck('8K4M2P7');
    expect(isValidQid(qid)).toBe(true);
    const wrong = qid.slice(0, -1) + (qid.endsWith('0') ? '1' : '0');
    expect(isValidQid(wrong)).toBe(false);
  });

  it('rejects any QID containing 0Z or Z0, even with a correct check symbol', () => {
    expect(isValidQid(withCheck('0Z56789'))).toBe(false);
    expect(isValidQid(withCheck('12Z0789'))).toBe(false);
  });

  it('rejects letters outside the alphabet, lower case and wrong shapes', () => {
    expect(isValidQid('QID-8K4M-2P7U')).toBe(false);
    expect(isValidQid(withCheck('8K4M2P7').toLowerCase())).toBe(false);
    expect(isValidQid('QID8K4M2P7R')).toBe(false);
    expect(isValidQid('')).toBe(false);
  });
});

describe('normalizeQid', () => {
  it('accepts formatting variants and look-alikes, returning the canonical form', () => {
    const qid = withCheck('8K4M2P1');
    const typed = qid.toLowerCase().replace(/-/g, ' ').replace(/1/g, 'l');
    expect(normalizeQid(typed)).toBe(qid);
    expect(normalizeQid(symbolsOf(qid))).toBe(qid);
  });

  it('returns null for anything that is not a valid QID', () => {
    expect(normalizeQid('QID-1234-5678')).toBeNull();
    expect(normalizeQid('hello')).toBeNull();
  });
});

describe('generateQid (property and measured)', () => {
  it('always yields valid QIDs with no adjacent 0/Z', () => {
    for (let i = 0; i < 5000; i += 1) {
      const qid = generateQid();
      expect(isValidQid(qid)).toBe(true);
      expect(/0Z|Z0/.test(symbolsOf(qid))).toBe(false);
    }
  });

  it('discards about 1.3% of candidates (measured, not asserted as a guarantee beyond a band)', () => {
    // mulberry32: a small, well-mixed seeded generator, so the measurement is repeatable.
    let seed = 12345;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let drawn = 0;
    const payload = () => {
      drawn += 1;
      let p = '';
      for (let i = 0; i < 7; i += 1) p += QID_ALPHABET[Math.floor(rand() * 32)];
      return p;
    };
    const n = 200_000;
    for (let i = 0; i < n; i += 1) generateQid(payload);
    const rejected = (drawn - n) / drawn;
    expect(rejected).toBeGreaterThan(0.012);
    expect(rejected).toBeLessThan(0.0145);
  });
});
