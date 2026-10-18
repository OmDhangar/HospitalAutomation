import { describe, expect, it } from 'vitest';
import {
  categorizeBillLines,
  classifyRoomType,
  computeReceiptSummary,
  formatBeddingInfo,
} from '../bill-receipt';
import type { BillLine, PaymentRow } from '@/lib/services/discharge-billing';

describe('bill-receipt categorization & computations', () => {
  const dummyLines: BillLine[] = [
    {
      id: 'l1',
      itemType: 'procedure',
      description: 'REGISTRATION',
      quantity: 1,
      unitPricePaise: 20000,
      subtotalPaise: 20000,
      totalPaise: 20000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      day: '2026-09-24',
      at: new Date('2026-09-24T10:00:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: null,
    },
    {
      id: 'l2',
      itemType: 'procedure',
      description: 'INTRACATH INSERTION',
      quantity: 1,
      unitPricePaise: 15000,
      subtotalPaise: 15000,
      totalPaise: 15000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      day: '2026-09-24',
      at: new Date('2026-09-24T10:30:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: null,
    },
    {
      id: 'l3',
      itemType: 'investigation',
      description: 'ECG',
      quantity: 1,
      unitPricePaise: 20000,
      subtotalPaise: 20000,
      totalPaise: 20000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      day: '2026-09-24',
      at: new Date('2026-09-24T11:00:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: null,
    },
    {
      id: 'l4',
      itemType: 'consumable',
      description: 'IV SALINE 100 ML',
      quantity: 9,
      unitPricePaise: 20000,
      subtotalPaise: 180000,
      totalPaise: 180000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      day: '2026-09-24',
      at: new Date('2026-09-24T12:00:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: null,
    },
    {
      id: 'l5',
      itemType: 'room',
      description: 'BED CHARGES',
      quantity: 4,
      unitPricePaise: 80000,
      subtotalPaise: 320000,
      totalPaise: 320000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      day: '2026-09-24',
      at: new Date('2026-09-24T12:00:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: null,
    },
    {
      id: 'l6',
      itemType: 'service',
      description: 'DR VISITING CHARGES',
      quantity: 4,
      unitPricePaise: 50000,
      subtotalPaise: 200000,
      totalPaise: 200000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      day: '2026-09-24',
      at: new Date('2026-09-24T12:00:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: null,
    },
    {
      id: 'l-voided',
      itemType: 'consumable',
      description: 'VOIDED SYRINGE',
      quantity: 1,
      unitPricePaise: 5000,
      subtotalPaise: 5000,
      totalPaise: 5000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      day: '2026-09-24',
      at: new Date('2026-09-24T12:00:00Z'),
      voidedAt: new Date('2026-09-24T13:00:00Z'),
      voidReason: 'Mistake',
      careEntryId: null,
    },
  ];

  it('categorizes non-voided bill lines into appropriate groups with sequential S.No', () => {
    const groups = categorizeBillLines(dummyLines, 'Asia/Kolkata');

    // Expected categories present
    const categoryTitles = groups.map((g) => g.categoryTitle);
    expect(categoryTitles).toContain('HOSPITAL CHARGES');
    expect(categoryTitles).toContain('INVESTIGATION');
    expect(categoryTitles).toContain('PHARMACY & CONSUMABLES');
    expect(categoryTitles).toContain('ROOM & CLINICAL CHARGES');

    // Voided line must NOT be included
    const allLineDescriptions = groups.flatMap((g) => g.lines.map((l) => l.particulars));
    expect(allLineDescriptions).not.toContain('VOIDED SYRINGE');

    // Check Hospital charges lines & subtotal
    const hospitalGroup = groups.find((g) => g.categoryTitle === 'HOSPITAL CHARGES')!;
    expect(hospitalGroup.lines).toHaveLength(2);
    expect(hospitalGroup.lines[0].sNo).toBe(1);
    expect(hospitalGroup.lines[1].sNo).toBe(2);
    expect(hospitalGroup.subtotalPaise).toBe(35000); // 20000 + 15000

    // Check Room & Clinical charges lines & subtotal
    const roomGroup = groups.find((g) => g.categoryTitle === 'ROOM & CLINICAL CHARGES')!;
    expect(roomGroup.lines).toHaveLength(2); // BED CHARGES + DR VISITING
    expect(roomGroup.subtotalPaise).toBe(520000); // 320000 + 200000
  });

  it('safely handles unknown or custom item types by falling back to HOSPITAL CHARGES', () => {
    const customLine: BillLine = {
      id: 'custom-1',
      itemType: 'unknown_specialty_charge',
      description: 'AMBULANCE SERVICE',
      quantity: 1,
      unitPricePaise: 100000,
      subtotalPaise: 100000,
      totalPaise: 100000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      day: '2026-09-24',
      at: new Date('2026-09-24T10:00:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: null,
    };

    const groups = categorizeBillLines([customLine], 'Asia/Kolkata');
    expect(groups).toHaveLength(1);
    expect(groups[0].categoryTitle).toBe('HOSPITAL CHARGES');
    expect(groups[0].lines[0].particulars).toBe('AMBULANCE SERVICE');
    expect(groups[0].subtotalPaise).toBe(100000);
  });

  it('correctly reconciles financial receipt summary', () => {
    const totals = {
      subtotalPaise: 775000,
      discountPaise: 0,
      taxPaise: 0,
      totalPaise: 775000,
    };

    const payments: PaymentRow[] = [
      {
        id: 'p1',
        amountPaise: 500000,
        kind: 'payment',
        method: 'cash',
        receivedAt: new Date('2026-09-20'),
        voidedAt: null,
      },
      {
        id: 'p2',
        amountPaise: 275000,
        kind: 'payment',
        method: 'upi',
        receivedAt: new Date('2026-09-24'),
        voidedAt: null,
      },
      {
        id: 'p-void',
        amountPaise: 100000,
        kind: 'payment',
        method: 'cash',
        receivedAt: new Date('2026-09-21'),
        voidedAt: new Date('2026-09-21'),
      },
    ];

    const summary = computeReceiptSummary(totals, payments);
    expect(summary.totalBillAmountPaise).toBe(775000);
    expect(summary.netPaymentsPaise).toBe(775000);
    expect(summary.balanceDuePaise).toBe(0);
    expect(summary.netAmountPaise).toBe(775000);
  });

  it('handles zero payments gracefully', () => {
    const totals = {
      subtotalPaise: 120000,
      discountPaise: 0,
      taxPaise: 0,
      totalPaise: 120000,
    };

    const summary = computeReceiptSummary(totals, []);
    expect(summary.totalBillAmountPaise).toBe(120000);
    expect(summary.netPaymentsPaise).toBe(0);
    expect(summary.balanceDuePaise).toBe(120000);
    expect(summary.netAmountPaise).toBe(120000);
  });

  describe('room & bedding classification', () => {
    it('classifies room types into General Ward, Private Ward, or Semi-Private Bed', () => {
      expect(classifyRoomType('Female Medical Ward')).toBe('General Ward');
      expect(classifyRoomType('General Ward A')).toBe('General Ward');
      expect(classifyRoomType('Semi-Private Ward')).toBe('Semi-Private Bed');
      expect(classifyRoomType('Semi Special Room')).toBe('Semi-Private Bed');
      expect(classifyRoomType('Private Ward')).toBe('Private Ward');
      expect(classifyRoomType('Special Deluxe Room')).toBe('Private Ward');
      expect(classifyRoomType(null)).toBe('General Ward');
    });

    it('formats bedding display cleanly with room type and bed number', () => {
      const general = formatBeddingInfo({
        wardName: 'Female Medical Ward',
        bedLabel: '12',
      });
      expect(general.roomType).toBe('General Ward');
      expect(general.bedNumber).toBe('12');
      expect(general.display).toBe('General Ward · Bed 12');
      expect(general.categoryTitle).toBe('GENERAL WARD');

      const semi = formatBeddingInfo({
        wardName: 'Semi-Private Room',
        bedLabel: 'Bed 04',
      });
      expect(semi.roomType).toBe('Semi-Private Bed');
      expect(semi.bedNumber).toBe('04');
      expect(semi.display).toBe('Semi-Private Bed · Bed 04');
      expect(semi.categoryTitle).toBe('SEMI (SPECIAL ROOM)');

      const privateWard = formatBeddingInfo({
        wardName: 'Private Room',
        bedLabel: '101',
      });
      expect(privateWard.roomType).toBe('Private Ward');
      expect(privateWard.bedNumber).toBe('101');
      expect(privateWard.display).toBe('Private Ward · Bed 101');
      expect(privateWard.categoryTitle).toBe('PRIVATE WARD');
    });

    it('replaces verbose ward names and bed types with clean room and bed number on bill lines', () => {
      const verboseBedLine: BillLine = {
        id: 'room-1',
        itemType: 'room',
        description: 'Female Medical Ward Bed · Female Medical Ward, bed 12 · 2026-09-24',
        quantity: 4,
        unitPricePaise: 80000,
        subtotalPaise: 320000,
        totalPaise: 320000,
        discountPaise: 0,
        discountReason: null,
        taxPaise: 0,
        day: '2026-09-24',
        at: new Date('2026-09-24T12:00:00Z'),
        voidedAt: null,
        voidReason: null,
        careEntryId: null,
      };

      const groups = categorizeBillLines([verboseBedLine], 'Asia/Kolkata', {
        wardName: 'Semi-Private Room',
        bedLabel: '12',
      });

      expect(groups).toHaveLength(1);
      const roomGroup = groups[0];
      // Category title indicates the room type
      expect(roomGroup.categoryTitle).toBe('SEMI (SPECIAL ROOM)');
      expect(roomGroup.lines).toHaveLength(1);

      const line = roomGroup.lines[0];
      // Does NOT show "Female Medical Ward" or "Female Medical Ward Bed"
      expect(line.particulars).not.toContain('Female Medical Ward');
      // Shows clean bed charges with bed number
      expect(line.particulars).toBe('BED CHARGES (Bed 12)');
      // Shows DAYS instead of generic UNITS
      expect(line.description).toBe('4 DAYS');
    });
  });
});
