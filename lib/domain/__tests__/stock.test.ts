import { describe, expect, it } from 'vitest';
import {
  StockError,
  adjustmentQuantity,
  allocateUse,
  countDue,
  countOutcome,
  expiryStatus,
  fefo,
  parseBatchNo,
  parseExpiry,
  parseQuantity,
} from '../stock';

const TZ = 'Asia/Kolkata';
const ist = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour - 5, minute - 30));

describe('typed input', () => {
  it('reads batch numbers as printed, in capitals', () => {
    expect(parseBatchNo(' mf2401a ')).toBe('MF2401A');
    expect(parseBatchNo('B-24/07.1')).toBe('B-24/07.1');
    for (const bad of ['', ' ', 'a b', '#12']) expect(() => parseBatchNo(bad), bad).toThrow(StockError);
  });

  it('reads expiries as month/year (last day of the month) or a full date', () => {
    expect(parseExpiry('03/2027')).toBe('2027-03-31');
    expect(parseExpiry('2/2028')).toBe('2028-02-29');
    expect(parseExpiry('2027-06-15')).toBe('2027-06-15');
    for (const bad of ['13/2027', '2027-02-30', 'March 27', '']) expect(() => parseExpiry(bad), bad).toThrow(StockError);
  });

  it('reads whole quantities within limits', () => {
    expect(parseQuantity('10')).toBe(10);
    expect(parseQuantity('0', 'Counted', { min: 0 })).toBe(0);
    for (const bad of ['0', '-1', '1.5', 'ten']) expect(() => parseQuantity(bad), bad).toThrow(StockError);
  });
});

describe('expiry', () => {
  it('says expired, soon (90 days) or fine', () => {
    expect(expiryStatus('2026-10-09', '2026-10-10')).toBe('expired');
    expect(expiryStatus('2026-10-10', '2026-10-10')).toBe('soon');
    expect(expiryStatus('2027-01-08', '2026-10-10')).toBe('soon');
    expect(expiryStatus('2027-01-09', '2026-10-10')).toBe('ok');
  });

  it('orders batches first expiry first', () => {
    const order = fefo([
      { batchNo: 'B', expiryDate: '2027-05-31' },
      { batchNo: 'C', expiryDate: '2026-12-31' },
      { batchNo: 'A', expiryDate: '2027-05-31' },
    ]).map((b) => b.batchNo);
    expect(order).toEqual(['C', 'A', 'B']);
  });
});

describe('a count', () => {
  const morphineA = { batchId: 'a', medicineId: 'morphine', batchNo: 'A', expiryDate: '2027-01-31' };
  const morphineB = { batchId: 'b', medicineId: 'morphine', batchNo: 'B', expiryDate: '2027-06-30' };

  it('spreads the register’s “used” figure over the batches that expire first', () => {
    const { byBatch, unallocated } = allocateUse(
      [
        { ...morphineB, quantity: 10 },
        { ...morphineA, quantity: 3 },
      ],
      5,
    );
    expect(Object.fromEntries(byBatch)).toEqual({ a: 3, b: 2 });
    expect(unallocated).toBe(0);
  });

  it('finds the difference per batch after use: counted − (book − used)', () => {
    const { lines, overUse } = countOutcome(
      [
        { ...morphineA, book: 3, counted: 0 },
        { ...morphineB, book: 10, counted: 7 },
      ],
      new Map([['morphine', 5]]),
    );
    // 5 used: 3 from A, 2 from B. A expected 0, counted 0. B expected 8, counted 7: one missing.
    expect(lines).toEqual([
      { batchId: 'a', usedAllocated: 3, variance: 0 },
      { batchId: 'b', usedAllocated: 2, variance: -1 },
    ]);
    expect(overUse.size).toBe(0);
  });

  it('reports a “used” figure larger than the books instead of hiding it', () => {
    const { lines, overUse } = countOutcome([{ ...morphineA, book: 2, counted: 0 }], new Map([['morphine', 5]]));
    expect(lines[0]).toEqual({ batchId: 'a', usedAllocated: 2, variance: 0 });
    expect(overUse.get('morphine')).toBe(3);
  });

  it('counts a surplus as a positive difference', () => {
    const { lines } = countOutcome([{ ...morphineA, book: 4, counted: 6 }], new Map());
    expect(lines[0].variance).toBe(2);
  });
});

describe('when a count is due', () => {
  it('is daily from 8 am, the morning shift change', () => {
    const now = ist(10, 9);
    expect(countDue({ lastCountAt: null, every: 'daily', now, timezone: TZ })).toBe(true);
    expect(countDue({ lastCountAt: ist(10, 8, 15), every: 'daily', now, timezone: TZ })).toBe(false);
    expect(countDue({ lastCountAt: ist(10, 7, 50), every: 'daily', now, timezone: TZ })).toBe(true);
    // At 7 am the chart day is still yesterday's: a count at 9 am yesterday covers it.
    expect(countDue({ lastCountAt: ist(9, 9), every: 'daily', now: ist(10, 7), timezone: TZ })).toBe(false);
  });

  it('is weekly after seven days', () => {
    expect(countDue({ lastCountAt: ist(4, 9), every: 'weekly', now: ist(10, 9), timezone: TZ })).toBe(false);
    expect(countDue({ lastCountAt: ist(3, 9), every: 'weekly', now: ist(10, 9), timezone: TZ })).toBe(true);
  });
});

describe('adjustments', () => {
  it('take stock out for expired, damaged and returned, and in for found', () => {
    expect(adjustmentQuantity('expired', 'out', 4)).toBe(-4);
    expect(adjustmentQuantity('found', 'in', 2)).toBe(2);
    expect(adjustmentQuantity('entry_error', 'in', 2)).toBe(2);
    expect(() => adjustmentQuantity('expired', 'in', 4)).toThrow(/only take stock out/);
    expect(() => adjustmentQuantity('found', 'out', 1)).toThrow(/only add stock/);
  });
});

describe('B4b: doses from the treatment card', () => {
  const b = (batchId: string, expiryDate: string, quantity: number) => ({ batchId, batchNo: batchId, expiryDate, quantity });

  it('draws a dose earliest expiry first, across batches, all or nothing', async () => {
    const { planDraw } = await import('@/lib/domain/stock');
    const shelf = [b('LATE', '2028-01-31', 5), b('SOON', '2027-01-31', 2)];
    expect(planDraw(shelf, 1)).toEqual([{ batchId: 'SOON', quantity: 1 }]);
    expect(planDraw(shelf, 4)).toEqual([{ batchId: 'SOON', quantity: 2 }, { batchId: 'LATE', quantity: 2 }]);
    expect(planDraw(shelf, 7)).toHaveLength(2);
    expect(planDraw(shelf, 8)).toBeNull();
    expect(planDraw(shelf, 0)).toEqual([]);
  });

  it('reconciles opening + movements to closing, keeping the card apart from the paper register', async () => {
    const { reconcile } = await import('@/lib/domain/stock');
    const from = new Date('2026-10-10T02:30:00Z');
    const to = new Date('2026-10-11T02:30:00Z');
    const at = (iso: string) => new Date(iso);
    const lines = reconcile(
      [
        { batchId: 'A', kind: 'receive', source: 'app', quantity: 10, occurredAt: at('2026-10-09T10:00:00Z') },
        { batchId: 'A', kind: 'give', source: 'manual_register', quantity: -2, occurredAt: at('2026-10-09T12:00:00Z') },
        { batchId: 'A', kind: 'transfer_in', source: 'app', quantity: 5, occurredAt: at('2026-10-10T03:00:00Z') },
        { batchId: 'A', kind: 'give', source: 'mar', quantity: -3, occurredAt: at('2026-10-10T04:00:00Z') },
        { batchId: 'A', kind: 'reversal', source: 'mar', quantity: 1, occurredAt: at('2026-10-10T05:00:00Z') },
        { batchId: 'A', kind: 'waste', source: 'mar', quantity: -1, occurredAt: at('2026-10-10T06:00:00Z') },
        { batchId: 'A', kind: 'give', source: 'manual_register', quantity: -1, occurredAt: at('2026-10-10T07:00:00Z') },
        { batchId: 'A', kind: 'transfer_out', source: 'app', quantity: -2, occurredAt: at('2026-10-10T08:00:00Z') },
        { batchId: 'A', kind: 'count_variance', source: 'app', quantity: -1, occurredAt: at('2026-10-10T09:00:00Z') },
        { batchId: 'A', kind: 'adjust', source: 'app', quantity: 2, occurredAt: at('2026-10-10T10:00:00Z') },
        { batchId: 'A', kind: 'give', source: 'mar', quantity: -4, occurredAt: at('2026-10-11T03:00:00Z') }, // after the period
        { batchId: 'B', kind: 'receive', source: 'app', quantity: 3, occurredAt: at('2026-10-01T00:00:00Z') },
        { batchId: 'C', kind: 'receive', source: 'app', quantity: 3, occurredAt: at('2026-10-01T00:00:00Z') },
        { batchId: 'C', kind: 'return', source: 'app', quantity: -3, occurredAt: at('2026-10-02T00:00:00Z') },
      ],
      from,
      to,
    );
    expect(lines.find((l) => l.batchId === 'A')).toEqual({
      batchId: 'A', opening: 8, received: 0, transferredIn: 5, sentOut: 2, givenMar: 3, givenRegister: 1, wasted: 1, returned: 0,
      adjusted: 2, countDifference: -1, putBack: 1, closing: 8,
    });
    expect(lines.find((l) => l.batchId === 'B')).toMatchObject({ opening: 3, closing: 3 });
    // A batch with nothing before, during or at the end of the period is left out.
    expect(lines.some((l) => l.batchId === 'C')).toBe(false);
  });

  it('D13: two counts with a difference in 7 days on one store, counter or shift', async () => {
    const { shiftOf, varianceRecurrence } = await import('@/lib/domain/stock');
    expect(shiftOf(new Date('2026-10-10T03:00:00Z'), 'Asia/Kolkata')).toBe('morning'); // 08:30 IST
    expect(shiftOf(new Date('2026-10-10T09:00:00Z'), 'Asia/Kolkata')).toBe('evening'); // 14:30
    expect(shiftOf(new Date('2026-10-10T15:00:00Z'), 'Asia/Kolkata')).toBe('night'); // 20:30
    const now = new Date('2026-10-11T00:00:00Z');
    const e = (countId: string, locationId: string, person: string, daysAgo: number, shift: 'morning' | 'evening' | 'night' = 'morning') => ({
      countId, locationId, countedByUserId: person, approvedAt: new Date(now.getTime() - daysAgo * 86_400_000), shift,
    });
    const flags = varianceRecurrence([e('c1', 'W1', 'asha', 1), e('c2', 'W1', 'bina', 3, 'night'), e('c3', 'W2', 'asha', 2, 'night'), e('c4', 'W2', 'chaya', 9)], now);
    expect(flags.map((f) => [f.on, f.key, f.counts]).sort()).toEqual([
      ['location', 'W1', 2],
      ['person', 'asha', 2],
      ['shift', 'night', 2],
    ]);
    // One count, however many lines differ, is one count.
    expect(varianceRecurrence([e('c1', 'W1', 'asha', 1), e('c1', 'W1', 'asha', 1)], now)).toEqual([]);
  });
});
