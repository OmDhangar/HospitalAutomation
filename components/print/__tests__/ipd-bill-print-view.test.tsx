import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { IpdBillPrintView } from '../ipd-bill-print-view';
import type { CategorizedBillGroup } from '@/lib/domain/bill-receipt';
import type { PrintableMedicalReport } from '@/lib/services/medical-report';

describe('IpdBillPrintView Integration Component', () => {
  const dummyProps = {
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
    doctorStamp: {
      name: 'DR. VINOD RAJESH PAWARA',
      qualification: 'MBBS, MD-MEDICINE',
      designation: 'CONSULTANT PHYSICIAN',
      registrationNo: '2015074070',
    },
    groups: [
      {
        categoryKey: 'HOSPITAL_CHARGES' as const,
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
    ],
    summary: {
      totalBillAmountPaise: 20000,
      netPaymentsPaise: 20000,
      balanceDuePaise: 0,
      netAmountPaise: 20000,
    },
    medicalReport: {
      investigations: [
        {
          id: 'inv-1',
          name: 'ECG',
          category: 'Diagnostic Lab',
          orderedAt: new Date('2026-09-24T10:00:00Z'),
          status: 'Report Ready',
          result: 'Normal sinus rhythm',
          normalRange: 'Normal',
          isCritical: false,
        },
      ],
      progressNotes: [],
      dischargeSummary: null,
    } as PrintableMedicalReport,
    defaultIncludeReport: false,
    backHref: '/ipd/patients/adm-1/billing',
  };

  it('renders bill receipt and does not render medical report when defaultIncludeReport is false', () => {
    const html = renderToString(<IpdBillPrintView {...dummyProps} defaultIncludeReport={false} />);

    expect(html).toContain('GURUVED HOSPITAL &amp; CRITICARE CENTRE');
    expect(html).toContain('Bill cum Receipt');
    expect(html).toContain('Powered by QuriioHQ');
    expect(html).toContain('REGISTRATION');
    expect(html).not.toContain('Diagnostic Investigations &amp; Laboratory Findings');
  });

  it('renders medical report when defaultIncludeReport is true', () => {
    const html = renderToString(<IpdBillPrintView {...dummyProps} defaultIncludeReport={true} />);

    expect(html).toContain('Bill cum Receipt');
    expect(html).toContain('Diagnostic Investigations &amp; Laboratory Findings');
    expect(html).toContain('Normal sinus rhythm');
    expect(html).toContain('Powered by QuriioHQ');
  });
});
