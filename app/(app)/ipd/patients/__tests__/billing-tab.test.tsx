import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { BillingAndConsumablesTab } from '@/components/ipd/billing/billing-and-consumables-tab';
import type { BillLine, PaymentRow } from '@/lib/services/discharge-billing';

describe('BillingAndConsumablesTab Component', () => {
  const dummyLines: BillLine[] = [
    {
      id: 'line-1',
      itemType: 'room',
      description: 'General Ward Bed Day (Bed 12)',
      quantity: 4,
      unitPricePaise: 150000,
      subtotalPaise: 600000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      totalPaise: 600000,
      day: '2026-10-10',
      at: null,
      voidedAt: null,
      voidReason: null,
      careEntryId: null,
    },
    {
      id: 'line-2',
      itemType: 'medicine',
      description: 'Pantoprazole 40mg IV',
      quantity: 4,
      unitPricePaise: 8500,
      subtotalPaise: 34000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      totalPaise: 34000,
      day: '2026-10-11',
      at: new Date('2026-10-11T08:00:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: 'ce-2',
    },
    {
      id: 'line-3',
      itemType: 'consumable',
      description: 'IV Cannula 20G',
      quantity: 2,
      unitPricePaise: 12000,
      subtotalPaise: 24000,
      discountPaise: 0,
      discountReason: null,
      taxPaise: 0,
      totalPaise: 24000,
      day: '2026-10-09',
      at: new Date('2026-10-09T14:00:00Z'),
      voidedAt: null,
      voidReason: null,
      careEntryId: 'ce-3',
    },
  ];

  const dummyPayments: PaymentRow[] = [
    {
      id: 'pay-1',
      kind: 'payment',
      amountPaise: 300000, // ₹3,000 advance
      method: 'upi',
      receivedAt: new Date('2026-10-09T11:00:00Z'),
      voidedAt: null,
    },
  ];

  it('renders itemized running ledger, financial totals, advance deposits, and interim bill trigger', () => {
    const html = renderToString(
      <BillingAndConsumablesTab
        admissionId="adm-101"
        lines={dummyLines}
        payments={dummyPayments}
        totals={{
          subtotalPaise: 658000,
          discountPaise: 0,
          taxPaise: 0,
          totalPaise: 658000, // ₹6,580
        }}
      />,
    );

    // Expect itemized table lines
    expect(html).toContain('General Ward Bed Day (Bed 12)');
    expect(html).toContain('Pantoprazole 40mg IV');
    expect(html).toContain('IV Cannula 20G');

    // Expect financial totals (₹6,580 total, ₹3,000 paid, ₹3,580 due)
    expect(html).toContain('6,580');
    expect(html).toContain('3,000');
    expect(html).toContain('3,580');

    // Expect button trigger
    expect(html).toContain('Print Interim Bill');
  });
});
