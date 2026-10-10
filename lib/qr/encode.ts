/**
 * A small QR Code encoder (ISO/IEC 18004, model 2), written here rather than
 * taken as a dependency (owner's choice, B3b). Enough for what the hospital
 * prints: bed labels and short links — one segment in alphanumeric or byte
 * mode, versions 1–10, error correction L/M/Q/H, automatic mask choice.
 *
 * Pure: no DOM. `qrMatrix` gives the modules (true = dark); `qrSvgPath` turns
 * them into one SVG path for printing. The structure follows the reference
 * algorithm (finder, timing and alignment patterns; Reed–Solomon over
 * GF(256) with 0x11D; block interleaving; zig-zag placement; masks scored by
 * the four penalty rules; BCH-coded format and version information).
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index = version (0 unused), for versions 1–10.
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const NUM_ERROR_CORRECTION_BLOCKS: Record<QrEcc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
export const MAX_VERSION = 10;

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export class QrError extends Error {}

/* ------------------------------------------------------------- GF(256) / RS */

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of the given degree, highest coefficient dropped. */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The Reed–Solomon error-correction codewords for `data`. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

/* ------------------------------------------------------------- capacities */

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number, ecc: QrEcc): number {
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc][version];
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/* ---------------------------------------------------------------- data bits */

type Segment = { mode: 'alphanumeric' | 'byte'; chars: number; bits: number[] };

function appendBits(into: number[], value: number, length: number) {
  for (let i = length - 1; i >= 0; i--) into.push((value >>> i) & 1);
}

function makeSegment(text: string): Segment {
  if ([...text].every((c) => ALPHANUMERIC.includes(c))) {
    const bits: number[] = [];
    let i = 0;
    for (; i + 2 <= text.length; i += 2) {
      appendBits(bits, ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
    }
    if (i < text.length) appendBits(bits, ALPHANUMERIC.indexOf(text[i]), 6);
    return { mode: 'alphanumeric', chars: text.length, bits };
  }
  const bytes = new TextEncoder().encode(text);
  const bits: number[] = [];
  for (const b of bytes) appendBits(bits, b, 8);
  return { mode: 'byte', chars: bytes.length, bits };
}

const charCountBits = (mode: Segment['mode'], version: number) =>
  mode === 'alphanumeric' ? (version <= 9 ? 9 : 11) : version <= 9 ? 8 : 16;

/** The data codewords (before error correction) for `text` at `version`. */
export function dataCodewords(text: string, version: number, ecc: QrEcc): number[] {
  const seg = makeSegment(text);
  const capacityBits = numDataCodewords(version, ecc) * 8;
  const bits: number[] = [];
  appendBits(bits, seg.mode === 'alphanumeric' ? 0x2 : 0x4, 4);
  appendBits(bits, seg.chars, charCountBits(seg.mode, version));
  bits.push(...seg.bits);
  if (bits.length > capacityBits) throw new QrError('Too long for this version');
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return codewords;
}

function fitsIn(text: string, version: number, ecc: QrEcc): boolean {
  const seg = makeSegment(text);
  return 4 + charCountBits(seg.mode, version) + seg.bits.length <= numDataCodewords(version, ecc) * 8 && seg.chars < 1 << charCountBits(seg.mode, version);
}

/** Splits into blocks, adds each block's error correction, and interleaves (ISO 18004 §7.6). */
function withErrorCorrection(data: readonly number[], version: number, ecc: QrEcc): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

/* ------------------------------------------------------------------ matrix */

class Grid {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFunction(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

function drawFormatBits(grid: Grid, ecc: QrEcc, mask: number) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const size = grid.size;
  for (let i = 0; i <= 5; i++) grid.setFunction(8, i, bit(i));
  grid.setFunction(8, 7, bit(6));
  grid.setFunction(8, 8, bit(7));
  grid.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) grid.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) grid.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) grid.setFunction(8, size - 15 + i, bit(i));
  grid.setFunction(8, size - 8, true);
}

function drawVersion(grid: Grid, version: number) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    grid.setFunction(a, b, dark);
    grid.setFunction(b, a, dark);
  }
}

function drawFunctionPatterns(grid: Grid, version: number, ecc: QrEcc) {
  const size = grid.size;
  for (let i = 0; i < size; i++) {
    grid.setFunction(6, i, i % 2 === 0);
    grid.setFunction(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        grid.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(version);
  const last = align.length - 1;
  align.forEach((ay, i) => {
    align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) grid.setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  drawFormatBits(grid, ecc, 0); // reserves the area; redrawn with the chosen mask
  drawVersion(grid, version);
}

function drawCodewords(grid: Grid, codewords: readonly number[]) {
  const size = grid.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!grid.isFunction[y][x] && i < codewords.length * 8) {
          grid.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
        // Remainder bits stay light (0) before masking.
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number) {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.isFunction[y][x] && MASKS[mask](x, y)) grid.modules[y][x] = !grid.modules[y][x];
    }
  }
}

/** The four penalty rules of ISO 18004 §8.8.2; the mask with the lowest score is used. */
export function penaltyScore(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push([...modules[i]]);
    lines.push(modules.map((row) => row[i]));
  }
  for (const line of lines) {
    // Rule 1: runs of five or more of one colour.
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // Rule 3: 1:1:3:1:1 finder-like patterns with four light modules on one side.
    const padded = [false, false, false, false, ...line, false, false, false, false];
    for (let i = 0; i + 11 <= padded.length; i++) {
      const w = padded.slice(i, i + 11);
      const core = w[4] && !w[5] && w[6] && w[7] && w[8] && !w[9] && w[10];
      const coreRev = w[0] && !w[1] && w[2] && w[3] && w[4] && !w[5] && w[6];
      if (core && !w[0] && !w[1] && !w[2] && !w[3]) score += 40;
      if (coreRev && !w[7] && !w[8] && !w[9] && !w[10]) score += 40;
    }
  }
  // Rule 2: 2×2 blocks of one colour.
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  // Rule 4: balance of dark and light.
  const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

export type QrCode = { version: number; ecc: QrEcc; mask: number; size: number; modules: boolean[][] };

/**
 * Encodes `text` in the smallest version (1–10) that holds it at `ecc`
 * (default M: ~15% of the code can be damaged or dirty and still read).
 */
export function qrMatrix(text: string, ecc: QrEcc = 'M'): QrCode {
  let version = 1;
  while (version <= MAX_VERSION && !fitsIn(text, version, ecc)) version++;
  if (version > MAX_VERSION) throw new QrError('Text too long for a QR code here');
  const codewords = withErrorCorrection(dataCodewords(text, version, ecc), version, ecc);

  let best: { mask: number; score: number; modules: boolean[][] } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = new Grid(version * 4 + 17);
    drawFunctionPatterns(grid, version, ecc);
    drawCodewords(grid, codewords);
    applyMask(grid, mask);
    drawFormatBits(grid, ecc, mask);
    const score = penaltyScore(grid.modules);
    if (!best || score < best.score) best = { mask, score, modules: grid.modules };
  }
  return { version, ecc, mask: best!.mask, size: version * 4 + 17, modules: best!.modules };
}

/** One SVG path drawing every dark module, offset by a quiet zone (4 modules by the standard). */
export function qrSvgPath(code: QrCode, quiet = 4): string {
  const parts: string[] = [];
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + quiet},${y + quiet}h1v1h-1z`);
    });
  });
  return parts.join('');
}
