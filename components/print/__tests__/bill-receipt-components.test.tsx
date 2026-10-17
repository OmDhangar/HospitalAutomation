import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BillReceiptHeader } from '../bill-receipt-header';
import { BillReceiptTable } from '../bill-receipt-table';
import { BillReceiptFooter } from '../bill-receipt-footer';
import type { CategorizedBillGroup } from '@/lib/domain/bill-receipt';

describe('BillReceipt Components', () => {
  const dummyHeaderProps = {
    hospitalName: 'GURUVED HOSPITAL & CRITICARE CENTRE',
    registrationNo: 'GHD/BNH/136/2022',
    isFinal: true,
    patient: {
      name: 'Dinesh Dhangar',
      age: 35,
      gender: 'M',
      address: 'PIMPARI',
      location: 'SHIRPUR',
      phone: '9922247281',
      patientId: '15804',
      roomBed: 'General Ward · Bed 12',
      doctorName: 'DR VINOD R PAWARA',
      department: 'MEDICINE',
    },
    bill: {
      billNumber: '#6097',
      billDate: '24-Sep-2026',
      ipdNumber: '6158',
      admissionDate: '20-Sep-2026',
      admissionTime: '08:00 PM',
      dischargeDate: '24-Sep-2026',
      dischargeTime: '12:35 PM',
    },
  };

  const dummyGroups: CategorizedBillGroup[] = [
    {
      categoryKey: 'HOSPITAL_CHARGES',
      categoryTitle: 'HOSPITAL CHARGES',
      subtotalPaise: 20000,
      lines: [
        {
          id: 'l1',
          sNo: 1,
          date: '24-Sep-2026',
          particulars: 'REGISTRATION',
          description: '4 DAYS',
          ratePaise: 20000,
          quantity: 1,
          discountPaise: 0,
          discountReason: null,
          amountPaise: 20000,
        },
      ],
    },
    {
      categoryKey: 'INVESTIGATION',
      categoryTitle: 'INVESTIGATION',
      subtotalPaise: 20000,
      lines: [
        {
          id: 'l2',
          sNo: 1,
          date: '24-Sep-2026',
          particulars: 'ECG',
          description: '4 DAYS',
          ratePaise: 20000,
          quantity: 1,
          discountPaise: 0,
          discountReason: null,
          amountPaise: 20000,
        },
      ],
    },
  ];

  const dummySummary = {
    totalBillAmountPaise: 40000,
    netPaymentsPaise: 40000,
    balanceDuePaise: 0,
    netAmountPaise: 40000,
  };

  it('renders BillReceiptHeader with hospital name, no tagline, Powered by QuriioHQ, and 2-column info grid', () => {
    const html = renderToString(<BillReceiptHeader {...dummyHeaderProps} />);

    expect(html).toContain('GURUVED HOSPITAL &amp; CRITICARE CENTRE');
    expect(html).toContain('Bill cum Receipt');
    expect(html).toContain('Powered by QuriioHQ');
    // Ensure NO tagline
    expect(html).not.toContain('DEVOTION TO HEALING');

    // Left Column
    expect(html).toContain('Dinesh Dhangar (35y, M)');
    expect(html).toContain('PIMPARI');
    expect(html).toContain('SHIRPUR');
    expect(html).toContain('9922247281');
    expect(html).toContain('15804');
    expect(html).toContain('Room / Bed');
    expect(html).toContain('General Ward · Bed 12');
    expect(html).toContain('DR VINOD R PAWARA');
    expect(html).toContain('MEDICINE');

    // Right Column
    expect(html).toContain('#6097');
    expect(html).toContain('6158');
    expect(html).toContain('20-Sep-2026');
    expect(html).toContain('08:00 PM');
    expect(html).toContain('24-Sep-2026');
    expect(html).toContain('12:35 PM');
  });

  it('renders BillReceiptTable with categorized rows, sub-totals, and summary block', () => {
    const html = renderToString(
      <BillReceiptTable groups={dummyGroups} summary={dummySummary} />,
    );

    expect(html).toContain('HOSPITAL CHARGES');
    expect(html).toContain('REGISTRATION');
    expect(html).toContain('INVESTIGATION');
    expect(html).toContain('ECG');
    expect(html).toContain('Sub Total:');
    expect(html).toContain('Total Bill Amount:');
    expect(html).toContain('Less Net Payments:');
    expect(html).toContain('Balance Due:');
    expect(html).toContain('Net Amount:');
  });

  it('renders BillReceiptFooter with patient signature, hospital seal, and doctor stamp', () => {
    const html = renderToString(
      <BillReceiptFooter
        patientName="Dinesh Dhangar"
        doctorName="DR. VINOD RAJESH PAWARA"
        doctorQualification="MBBS, MD-MEDICINE"
        doctorDesignation="CONSULTANT PHYSICIAN"
        doctorRegistrationNo="2015074070"
        hospitalRegistrationNo="GHD/BNH/136/2022"
      />,
    );

    expect(html).toContain('Dinesh Dhangar');
    expect(html).toContain('Signature');
    expect(html).toContain('DR. VINOD RAJESH PAWARA');
    expect(html).toContain('MBBS, MD-MEDICINE');
    expect(html).toContain('CONSULTANT PHYSICIAN');
    expect(html).toContain('REG.NO.2015074070');
    expect(html).toContain('Powered by QuriioHQ');
    expect(html).toContain('Page 1 of 1');
  });
});
