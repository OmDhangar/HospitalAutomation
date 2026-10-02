import { describe, expect, it } from 'vitest';
import {
  MAX_BACKDATE_MS,
  UNDO_WINDOW_MS,
  canUndoEntry,
  isLateRecording,
  occurredAtRefusal,
  parseCareEntryBatch,
  recentDuplicate,
} from '../care-entry';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (extra: Record<string, unknown> = {}) => ({
  clientId: id(1),
  admissionId: id(2),
  item: { type: 'charge', id: id(3) },
  quantity: 1,
  occurredAt: '2026-10-20T10:42:00.000+05:30',
  ...extra,
});

describe('parseCareEntryBatch', () => {
  it('accepts a catalogue item, a medicine and a new item', () => {
    const result = parseCareEntryBatch({
      entries: [
        entry(),
        entry({ clientId: id(4), item: { type: 'medicine', id: id(5) }, quantity: 2 }),
        entry({ clientId: id(6), item: { type: 'new', kind: 'consumable', name: '  Crepe   bandage ' } }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries[2].item).toEqual({ type: 'new', kind: 'consumable', name: 'Crepe bandage' });
  });

  it('refuses any price the phone tries to send', () => {
    expect(parseCareEntryBatch({ entries: [entry({ unitPricePaise: 100 })] }).ok).toBe(false);
    expect(parseCareEntryBatch({ entries: [entry({ item: { type: 'charge', id: id(3), price: 1 } })] }).ok).toBe(
      false,
    );
    expect(parseCareEntryBatch({ entries: [entry()], totalPaise: 100 }).ok).toBe(false);
  });

  it('refuses a zero or huge quantity, a bad id, or an empty batch', () => {
    expect(parseCareEntryBatch({ entries: [entry({ quantity: 0 })] }).ok).toBe(false);
    expect(parseCareEntryBatch({ entries: [entry({ quantity: 1000 })] }).ok).toBe(false);
    expect(parseCareEntryBatch({ entries: [entry({ clientId: 'abc' })] }).ok).toBe(false);
    expect(parseCareEntryBatch({ entries: [] }).ok).toBe(false);
  });
});

describe('occurredAtRefusal', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  it('allows now, a little ago, and a slightly fast phone', () => {
    expect(occurredAtRefusal(now, now)).toBeNull();
    expect(occurredAtRefusal(new Date(now.getTime() - 60 * 60_000), now)).toBeNull();
    expect(occurredAtRefusal(new Date(now.getTime() + 3 * 60_000), now)).toBeNull();
  });
  it('refuses the future and the long past', () => {
    expect(occurredAtRefusal(new Date(now.getTime() + 30 * 60_000), now)).toBe('future');
    expect(occurredAtRefusal(new Date(now.getTime() - MAX_BACKDATE_MS - 1), now)).toBe('too_old');
  });
});

describe('canUndoEntry', () => {
  const recordedAt = new Date('2026-10-20T10:00:00Z');
  const base = { recordedByUserId: 'nurse', actorUserId: 'nurse', recordedAt, voided: false };
  it('lets a nurse undo her own entry for two minutes', () => {
    expect(canUndoEntry({ ...base, now: new Date(recordedAt.getTime() + UNDO_WINDOW_MS) })).toBe(true);
    expect(canUndoEntry({ ...base, now: new Date(recordedAt.getTime() + UNDO_WINDOW_MS + 1) })).toBe(false);
  });
  it('never someone else’s, and never twice', () => {
    expect(canUndoEntry({ ...base, actorUserId: 'other', now: recordedAt })).toBe(false);
    expect(canUndoEntry({ ...base, voided: true, now: recordedAt })).toBe(false);
  });
});

describe('recentDuplicate', () => {
  const at = new Date('2026-10-20T10:42:00Z');
  it('finds the nearest earlier dose within fifteen minutes', () => {
    expect(
      recentDuplicate([{ occurredAt: new Date('2026-10-20T10:36:00Z') }, { occurredAt: new Date('2026-10-20T10:00:00Z') }], at),
    ).toEqual({ minutesAgo: 6 });
  });
  it('ignores doses outside the window', () => {
    expect(recentDuplicate([{ occurredAt: new Date('2026-10-20T10:20:00Z') }], at)).toBeNull();
  });
});

describe('isLateRecording', () => {
  it('flags entries recorded more than six hours after they were given', () => {
    const given = new Date('2026-10-20T02:00:00Z');
    expect(isLateRecording(given, new Date('2026-10-20T07:59:00Z'))).toBe(false);
    expect(isLateRecording(given, new Date('2026-10-20T08:01:00Z'))).toBe(true);
  });
});
