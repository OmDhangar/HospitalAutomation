import { describe, expect, it } from 'vitest';
import { UNDO_WINDOWS_MS, formatUndoToken, idList, isId, parseUndoToken, withinWindow } from '../undo';

const a = '6f1c9a3e-2b7d-4e8a-9c21-7d4e5f6a8b90';
const b = '1e1c9a3e-2b7d-4e8a-9c21-7d4e5f6a8b90';

describe('undo tokens', () => {
  it('round-trips a kind and its ids, empty slots included', () => {
    const token = formatUndoToken('assign', a, null);
    expect(token).toBe(`assign~${a}~`);
    expect(parseUndoToken(token)).toEqual({ kind: 'assign', args: [a, ''] });
  });

  it('carries a list of ids in one slot', () => {
    const token = formatUndoToken('beds', `${a},${b}`);
    expect(idList(parseUndoToken(token)!.args[0])).toEqual([a, b]);
  });

  it('refuses unknown kinds and odd characters', () => {
    expect(parseUndoToken('drop-table~x')).toBeNull();
    expect(parseUndoToken(`assign~${a};--`)).toBeNull();
    expect(parseUndoToken(42)).toBeNull();
    expect(parseUndoToken(undefined)).toBeNull();
  });

  it('checks ids', () => {
    expect(isId(a)).toBe(true);
    expect(isId('nope')).toBe(false);
    expect(idList('nope,' + a)).toEqual([a]);
  });
});

describe('withinWindow', () => {
  const now = new Date('2026-10-03T10:00:00Z');
  it('is true inside the window and false after it, or without a time', () => {
    expect(withinWindow(new Date(now.getTime() - 5 * 60_000), UNDO_WINDOWS_MS.desk, now)).toBe(true);
    expect(withinWindow(new Date(now.getTime() - 11 * 60_000), UNDO_WINDOWS_MS.desk, now)).toBe(false);
    expect(withinWindow(null, UNDO_WINDOWS_MS.desk, now)).toBe(false);
  });
});
