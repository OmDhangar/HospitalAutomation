import { describe, expect, it } from 'vitest';
import {
  BillingInputError,
  calculateBillItem,
  parseRupeesToPaise,
  paymentStatus,
  sumBillItems,
} from '../patient-billing';

describe('calculateBillItem', () => {
  it('multiplies quantity by the unit price', () => {
    // Paracetamol at ₹2.00, five tablets.
    expect(calculateBillItem({ quantity: 5, unitPricePaise: 200 })).toEqual({
      subtotalPaise: 1_000,
      discountPaise: 0,
      taxPaise: 0,
      totalPaise: 1_000,
    });
  });

  it('prices the same quantity differently after a price change', () => {
    expect(calculateBillItem({ quantity: 5, unitPricePaise: 250 }).totalPaise).toBe(1_250);
  });

  it('taxes the discounted amount, not the list amount', () => {
    const line = calculateBillItem({
      quantity: 2,
      unitPricePaise: 50_000,
      discountPaise: 10_000,
      taxRateBp: 1_800,
    });
    expect(line.subtotalPaise).toBe(100_000);
    expect(line.taxPaise).toBe(16_200); // 18% of ₹900
    expect(line.totalPaise).toBe(106_200);
  });

  it('rounds tax half-up to whole paise', () => {
    // 5% of 1,010 paise is 50.5 paise.
    expect(calculateBillItem({ quantity: 1, unitPricePaise: 1_010, taxRateBp: 500 }).taxPaise).toBe(51);
    // 5% of 1,009 paise is 50.45 paise.
    expect(calculateBillItem({ quantity: 1, unitPricePaise: 1_009, taxRateBp: 500 }).taxPaise).toBe(50);
  });

  it('allows a free line', () => {
    expect(calculateBillItem({ quantity: 1, unitPricePaise: 0 }).totalPaise).toBe(0);
  });

  it('keeps total = subtotal - discount + tax, the invariant the database checks', () => {
    for (const [quantity, unitPricePaise, discountPaise, taxRateBp] of [
      [3, 333, 7, 1_200],
      [10, 199, 0, 500],
      [1, 99_999, 99_999, 1_800],
    ]) {
      const line = calculateBillItem({ quantity, unitPricePaise, discountPaise, taxRateBp });
      expect(line.subtotalPaise).toBe(quantity * unitPricePaise);
      expect(line.totalPaise).toBe(line.subtotalPaise - line.discountPaise + line.taxPaise);
    }
  });

  it.each([
    [{ quantity: 0, unitPricePaise: 100 }, 'Quantity'],
    [{ quantity: 1.5, unitPricePaise: 100 }, 'Quantity'],
    [{ quantity: 1, unitPricePaise: -1 }, 'Unit price'],
    [{ quantity: 1, unitPricePaise: 2.5 }, 'Unit price'],
    [{ quantity: 1, unitPricePaise: 100, discountPaise: 101 }, 'Discount'],
    [{ quantity: 1, unitPricePaise: 100, taxRateBp: 10_001 }, 'Tax rate'],
  ])('refuses %o', (input, message) => {
    expect(() => calculateBillItem(input)).toThrow(BillingInputError);
    expect(() => calculateBillItem(input)).toThrow(message);
  });
});

describe('sumBillItems', () => {
  it('adds every column', () => {
    const lines = [
      calculateBillItem({ quantity: 1, unitPricePaise: 30_000 }),
      calculateBillItem({ quantity: 10, unitPricePaise: 200 }),
    ];
    expect(sumBillItems(lines)).toEqual({
      subtotalPaise: 32_000,
      discountPaise: 0,
      taxPaise: 0,
      totalPaise: 32_000,
    });
  });

  it('is zero for an empty bill', () => {
    expect(sumBillItems([]).totalPaise).toBe(0);
  });
});

describe('paymentStatus', () => {
  it('is unpaid when nothing has been charged yet', () => {
    expect(paymentStatus({ hasCharges: false, totalPaise: 0, paidPaise: 0 })).toBe('unpaid');
  });

  it('is unpaid, partial or paid by what has been received', () => {
    expect(paymentStatus({ hasCharges: true, totalPaise: 30_000, paidPaise: 0 })).toBe('unpaid');
    expect(paymentStatus({ hasCharges: true, totalPaise: 30_000, paidPaise: 10_000 })).toBe('partial');
    expect(paymentStatus({ hasCharges: true, totalPaise: 30_000, paidPaise: 30_000 })).toBe('paid');
  });

  it('treats a charged ₹0 consultation as settled', () => {
    expect(paymentStatus({ hasCharges: true, totalPaise: 0, paidPaise: 0 })).toBe('paid');
  });
});

describe('parseRupeesToPaise', () => {
  it.each([
    ['300', 30_000],
    ['300.5', 30_050],
    ['300.05', 30_005],
    ['1,250.00', 125_000],
    ['₹ 450', 45_000],
    ['0', 0],
  ])('reads %s as %i paise', (input, paise) => {
    expect(parseRupeesToPaise(input)).toBe(paise);
  });

  it.each(['', 'abc', '-5', '1.234', '12e3', '10000000'])('rejects %s', (input) => {
    expect(parseRupeesToPaise(input)).toBeNull();
  });
});
