import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { numberToIndianRupeesInWords } from '@/lib/domain/currency';
import { DynamicAdmissionSheet } from '../print/dynamic-admission-sheet';
import { DynamicConsentSheet } from '../print/dynamic-consent-sheet';
import type { AdmissionSummary } from '@/lib/services/ipd-census';
import type { Letterhead } from '@/lib/domain/letterhead';

describe('Print Pack - Currency & Dynamic Sheets', () => {
  it('converts amounts to Indian words correctly', () => {
    expect(numberToIndianRupeesInWords(0)).toBe('Rupees Zero Only');
    expect(numberToIndianRupeesInWords(5000)).toBe('Rupees Five Thousand Only');
    expect(numberToIndianRupeesInWords(25500)).toBe('Rupees Twenty Five Thousand Five Hundred Only');
    expect(numberToIndianRupeesInWords(100000)).toBe('Rupees One Lakh Only');
  });

  const mockLetterhead: Letterhead = {
    hospitalName: 'GURUVED HOSPITAL & CRITICARE CENTER',
    branchName: 'Main Campus',
    address: 'Station Road, Shahada, Nandurbar',
    registrationNo: 'REG/2013/05/1852',
    phones: '02565-224488, 9422788990',
    doctors: [
      {
        name: 'Dr. Vinod Rajesh Pawara',
        qualification: 'M.D. (Medicine)',
        registrationNo: '2013/05/1852',
      },
    ],
  };

  const mockAdmission: AdmissionSummary = {
    admissionId: 'adm-001',
    encounterId: 'enc-001',
    patientId: 'pat-001',
    branchId: 'br-001',
    status: 'admitted',
    ipdNumber: 104,
    admissionNumber: 'ADM/26-27/00042',
    patientName: 'Kailas Bhil',
    mrn: 'MRN-10042',
    qid: 'Q-882194',
    age: 48,
    gender: 'male',
    phoneE164: '+919822334455',
    address: 'Shahada, Dist. Nandurbar',
    doctorId: 'doc-001',
    doctorName: 'Vinod Rajesh Pawara',
    doctorUserId: 'user-001',
    reason: 'Acute Febrile Illness with Severe Thrombocytopenia',
    urgency: 'emergency',
    advisedWardKind: 'icu',
    estimatedStayDays: 4,
    receptionNotes: 'Immediate ICU bed needed',
    requestedAt: new Date('2026-10-19T10:00:00Z'),
    admittedAt: new Date('2026-10-19T10:15:00Z'),
    dischargeReadyAt: null,
    dischargedAt: null,
    vitalsFrequency: 'q2h',
    bed: { id: 'bed-1', label: 'ICU-3', wardId: 'ward-1', wardName: 'Intensive Care Unit' },
    payer: {
      kind: 'self',
      payerName: null,
      policyNumber: null,
      preauthAmountPaise: null,
      approvedAmountPaise: null,
    },
    isMlc: true,
    mlcNumber: 'MLC/26-27/00018',
    policeStationName: 'Shahada City Police Station',
    policeIntimationMode: 'written_slip',
    constableName: 'Sanjay More',
    constableBuckleNo: 'PC-1142',
    attendant: {
      name: 'Pravin Kailas Bhil',
      relation: 'Son',
      phoneE164: '+919822998877',
      address: 'Shahada',
    },
    deposit: {
      amountPaise: 500000,
      receiptNumber: 'REC/26-27/00128',
      method: 'cash',
      paidAt: new Date('2026-10-19T10:20:00Z'),
    },
    consent: {
      templateId: 'tpl-001',
      status: 'attested_paper',
      signatureType: 'physical_paper',
      signerName: 'Pravin Kailas Bhil',
      signerRelationship: 'Son',
      obtainedAt: new Date('2026-10-19T10:25:00Z'),
      doctorConfirmed: true,
    },
  };

  it('renders dynamic admission sheet with hospital letterhead, MLC, and attendant', () => {
    const html = renderToString(
      <DynamicAdmissionSheet admission={mockAdmission} letterhead={mockLetterhead} />,
    );

    expect(html).toContain('GURUVED HOSPITAL &amp; CRITICARE CENTER');
    expect(html).toContain('ADM/26-27/00042');
    expect(html).toContain('KAILAS BHIL');
    expect(html).toContain('ICU-3');
    expect(html).toContain('Intensive Care Unit');
    expect(html).toContain('MEDICO-LEGAL CASE');
    expect(html).toContain('MLC/26-27/00018');
    expect(html).toContain('Shahada City Police Station');
    expect(html).toContain('Pravin Kailas Bhil');
    expect(html).toContain('₹5,000');
    expect(html).toContain('REC/26-27/00128');
  });

  it('renders dynamic consent sheet with Marathi & English legal text and doctor certification', () => {
    const html = renderToString(
      <DynamicConsentSheet admission={mockAdmission} letterhead={mockLetterhead} />,
    );

    expect(html).toContain('संमती व हमीपत्र');
    expect(html).toContain('Pravin Kailas Bhil');
    expect(html).toContain('मी माझ्या रुग्णास उपचारासाठी या रुग्णालयात दाखल करत आहे');
    expect(html).toContain('Doctor Explanation &amp; Counselling Certification');
    expect(html).toContain('Physical Signed Paper Verified &amp; Archived');
  });
});
