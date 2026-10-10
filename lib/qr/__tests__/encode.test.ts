import { describe, expect, it } from 'vitest';
import { QrError, dataCodewords, penaltyScore, qrMatrix, qrSvgPath, rsDivisor, rsRemainder } from '../encode';

/**
 * The QR encoder (B3b). The data and error-correction codewords are checked
 * against the worked example in the standard's tutorials ("HELLO WORLD",
 * version 1-M); the matrix is checked for its fixed patterns. A full decode
 * of printed labels is checked by hand in the browser check (jsQR), not here,
 * to keep a decoder out of the project's dependencies.
 */
describe('QR encoder', () => {
  it('encodes HELLO WORLD at 1-M as the reference codewords', () => {
    const data = dataCodewords('HELLO WORLD', 1, 'M');
    expect(data).toEqual([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('draws finder, timing and the dark module where the standard puts them', () => {
    const code = qrMatrix('QB1:ZXB3N2');
    expect(code.version).toBe(1);
    expect(code.size).toBe(21);
    const m = code.modules;
    // Finder (top-left): dark ring, light ring, dark 3×3 centre.
    expect([m[0][0], m[0][6], m[6][0], m[6][6], m[1][1], m[3][3]]).toEqual([true, true, true, true, false, true]);
    // Separators light.
    expect([m[7][0], m[0][7], m[7][7]]).toEqual([false, false, false]);
    // Timing pattern alternates on row and column 6.
    for (let i = 8; i < 13; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    // The dark module next to the bottom-left finder.
    expect(m[code.size - 8][8]).toBe(true);
  });

  it('grows the version for longer text and places alignment patterns', () => {
    const url = 'https://quriiohq.example/ipd/bed/ZXB3N2?h=3597fd3a-2d7f';
    const code = qrMatrix(url);
    expect(code.version).toBeGreaterThan(2);
    // Alignment pattern centre (dark) with its light ring, at (size-7, size-7).
    const c = code.size - 7;
    expect(code.modules[c][c]).toBe(true);
    expect(code.modules[c][c + 1]).toBe(false);
    expect(code.modules[c + 2][c + 2]).toBe(true);
  });

  it('writes version information from version 7', () => {
    const long = 'x'.repeat(150);
    const code = qrMatrix(long, 'L');
    expect(code.version).toBeGreaterThanOrEqual(7);
    // The two copies of the version block are mirror images.
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) expect(code.modules[code.size - 11 + j][i]).toBe(code.modules[i][code.size - 11 + j]);
  });

  it('chooses the mask with the lowest penalty and refuses what does not fit', () => {
    const code = qrMatrix('QB1:ABCDEF');
    expect(code.mask).toBeGreaterThanOrEqual(0);
    expect(penaltyScore(code.modules)).toBeGreaterThan(0);
    expect(() => qrMatrix('x'.repeat(400), 'H')).toThrow(QrError);
  });

  it('renders one SVG path with a quiet zone', () => {
    const path = qrSvgPath(qrMatrix('QB1:ABCDEF'));
    expect(path.startsWith('M4,4h1v1h-1z')).toBe(true);
  });
});
