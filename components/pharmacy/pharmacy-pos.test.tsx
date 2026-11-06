import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import ExternalPharmacyBanner from './ExternalPharmacyBanner';
import PharmacyReceiptModal from './PharmacyReceiptModal';

describe('Pharmacy UI Components', () => {
  it('renders external pharmacy banner with informative notice', () => {
    const html = renderToString(<ExternalPharmacyBanner />);
    expect(html).toContain('External Pharmacy Mode Active');
    expect(html).toContain('IPD medications and ward stocks');
    expect(html).toContain('external chemist');
  });

  it('renders pharmacy receipt with English-only headers and accurate line items', () => {
    const mockReceipt = {
      title: 'RETAIL PHARMACY CASH MEMO',
      hospitalName: 'Qurio City Hospital',
      hospitalAddress: 'Station Road, Pune',
      drugLicenseNo: 'MH-PUN-123456',
      gstin: '27AAAAA0000A1Z5',
      saleNo: 'PH-2026-00001',
      saleDateFormatted: '2026-11-06 14:30:00',
      cashierName: 'Pharmacy Counter 1',
      customerName: 'Aman Gupta',
      customerPhone: '+919876543210',
      doctorName: 'Dr. A. Verma',
      paymentMode: 'CASH',
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
      subtotalFormatted: '₹900.00',
      cgstFormatted: '₹54.00',
      sgstFormatted: '₹54.00',
      discountFormatted: '₹0.00',
      totalFormatted: '₹1,008.00',
      termsNotice: 'Medicines once sold can only be returned within 7 days with original receipt.',
    };

    const html = renderToString(
      <PharmacyReceiptModal receipt={mockReceipt} onClose={() => {}} />
    );

    expect(html).toContain('RETAIL PHARMACY CASH MEMO');
    expect(html).toContain('Qurio City Hospital');
    expect(html).toContain('PH-2026-00001');
    expect(html).toContain('Paracetamol 650mg');
    expect(html).toContain('BATCH-001');
    expect(html).toContain('₹1,008.00');
    expect(html).toContain('CASH');
  });
});
