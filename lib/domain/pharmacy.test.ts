import { describe, it, expect } from 'vitest';
import {
  calculateItemTax,
  calculateSaleTotals,
  formatSaleNumber,
  formatReturnNumber,
  generateReceiptData,
} from './pharmacy';

describe('Pharmacy Domain Engine', () => {
  describe('calculateItemTax', () => {
    it('calculates 12% GST correctly on 10 units @ Rs 100 with 10% discount', () => {
      // 10 units @ 10,000 paise = 100,000 paise gross
      // 10% discount = 10,000 paise
      // Taxable = 90,000 paise
      // CGST 6% = 5,400 paise
      // SGST 6% = 5,400 paise
      // Total = 100,800 paise (Rs 1,008.00)
      const result = calculateItemTax({
        unitPricePaise: 10000,
        quantity: 10,
        discountPercent: 10,
        gstRate: 12,
      });

      expect(result.grossAmountPaise).toBe(100000);
      expect(result.discountAmountPaise).toBe(10000);
      expect(result.taxableAmountPaise).toBe(90000);
      expect(result.cgstAmountPaise).toBe(5400);
      expect(result.sgstAmountPaise).toBe(5400);
      expect(result.totalAmountPaise).toBe(100800);
    });

    it('calculates 0% GST (exempt medicines) correctly', () => {
      const result = calculateItemTax({
        unitPricePaise: 5000,
        quantity: 2,
        discountPercent: 0,
        gstRate: 0,
      });

      expect(result.taxableAmountPaise).toBe(10000);
      expect(result.cgstAmountPaise).toBe(0);
      expect(result.sgstAmountPaise).toBe(0);
      expect(result.totalAmountPaise).toBe(10000);
    });

    it('calculates 5% GST and preserves exact paise precision', () => {
      // 3 units @ 333 paise = 999 paise
      // 0% discount -> taxable = 999
      // CGST 2.5% = round(999 * 5 / 200) = round(24.975) = 25
      // SGST 2.5% = round(999 * 5 / 200) = 25
      // Total = 999 + 25 + 25 = 1049
      const result = calculateItemTax({
        unitPricePaise: 333,
        quantity: 3,
        discountPercent: 0,
        gstRate: 5,
      });

      expect(result.taxableAmountPaise).toBe(999);
      expect(result.cgstAmountPaise).toBe(25);
      expect(result.sgstAmountPaise).toBe(25);
      expect(result.totalAmountPaise).toBe(1049);
    });
  });

  describe('calculateSaleTotals', () => {
    it('aggregates multiple items accurately', () => {
      const items = [
        {
          taxableAmountPaise: 90000,
          cgstAmountPaise: 5400,
          sgstAmountPaise: 5400,
          totalAmountPaise: 100800,
        },
        {
          taxableAmountPaise: 10000,
          cgstAmountPaise: 250,
          sgstAmountPaise: 250,
          totalAmountPaise: 10500,
        },
      ];

      const totals = calculateSaleTotals(items, 500); // 500 paise bill discount
      expect(totals.subtotalPaise).toBe(100000);
      expect(totals.totalCgstPaise).toBe(5650);
      expect(totals.totalSgstPaise).toBe(5650);
      expect(totals.discountPaise).toBe(500);
      expect(totals.totalPaise).toBe(110800);
    });
  });

  describe('Sequencing and Formatting', () => {
    it('formats sale number with standard hospital prefix and 5-digit sequence', () => {
      expect(formatSaleNumber('PH', 2026, 42)).toBe('PH-2026-00042');
    });

    it('formats return number with RET prefix and 5-digit sequence', () => {
      expect(formatReturnNumber('RET', 2026, 7)).toBe('RET-2026-00007');
    });
  });

  describe('generateReceiptData (Rule 2.2 Compliance)', () => {
    it('produces English-only receipt metadata with required pharmacy labels', () => {
      const receipt = generateReceiptData({
        hospitalName: 'Qurio City Hospital',
        hospitalAddress: 'Station Road, Pune',
        drugLicenseNo: 'MH-PUN-123456',
        gstin: '27AAAAA0000A1Z5',
        saleNo: 'PH-2026-00001',
        saleDate: new Date('2026-11-06T12:00:00Z'),
        cashierName: 'Dr. Jane / Pharmacist',
        customerName: 'Rahul Sharma',
        customerPhone: '+919876543210',
        doctorName: 'Dr. A. Verma',
        paymentMode: 'cash',
        items: [
          {
            medicineName: 'Paracetamol 650mg',
            batchNo: 'BATCH-001',
            expiryDate: '2027-12-31',
            quantity: 10,
            mrpPaise: 12000,
            unitPricePaise: 10000,
            discountPercent: 10,
            gstRate: 12,
            taxableAmountPaise: 90000,
            cgstAmountPaise: 5400,
            sgstAmountPaise: 5400,
            totalAmountPaise: 100800,
          },
        ],
        subtotalPaise: 90000,
        cgstPaise: 5400,
        sgstPaise: 5400,
        discountPaise: 0,
        totalPaise: 100800,
      });

      expect(receipt.title).toBe('RETAIL PHARMACY CASH MEMO');
      expect(receipt.termsNotice).toContain('Medicines once sold');
      expect(receipt.items[0].medicineName).toBe('Paracetamol 650mg');
      expect(receipt.paymentMode).toBe('CASH');
    });
  });
});
