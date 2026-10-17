import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PatientMedicalReport } from '../patient-medical-report';
import type { PrintableMedicalReport } from '@/lib/services/medical-report';

describe('PatientMedicalReport Component', () => {
  const dummyReport: PrintableMedicalReport = {
    investigations: [
      {
        id: 'inv-1',
        name: 'COMPLETE BLOOD COUNT (CBC)',
        category: 'Diagnostic Lab',
        orderedAt: new Date('2026-09-21T09:00:00Z'),
        status: 'Report Ready',
        result: 'Hb 13.2 g/dL, TLC 7,800 /mcL, Platelets 2.4 Lakhs',
        normalRange: 'Standard reference limits',
        isCritical: false,
      },
    ],
    progressNotes: [
      {
        id: 'note-1',
        authorName: 'DR VINOD R PAWARA',
        authorRole: 'doctor',
        createdAt: new Date('2026-09-22T10:30:00Z'),
        noteType: 'SOAP',
        soapS: 'Patient reports reduced headache, sleeping well.',
        soapO: 'Afebrile, BP 120/80, chest clear.',
        soapA: 'Viral pyrexia resolving.',
        soapP: 'Discontinue IV fluids, maintain oral hydration.',
      },
    ],
    dischargeSummary: {
      primaryDiagnosis: 'Acute Viral Pyrexia with Dehydration',
      secondaryDiagnoses: null,
      conditionAtDischarge: 'Stable, afebrile for 48 hours',
      hospitalCourse: 'Managed with antipyretics and IV fluids.',
      dischargeAdvice: 'Rest at home for 3 days, drink plenty of fluids.',
      dietAdvice: 'Light soft diet, adequate fluids',
      urgentWarningSigns: 'High fever, vomiting, severe dizziness',
      followUpDate: '2026-10-01',
      prescriberDoctorName: 'DR VINOD R PAWARA',
      prescriberRegistrationNo: '2015074070',
      takeHomePrescriptions: [
        {
          medicineName: 'Paracetamol 650mg',
          dosage: '1 tab',
          route: 'Oral',
          frequency: 'TDS (Three times a day)',
          duration: '3 days',
          instructions: 'Take after meals if fever persists',
        },
      ],
    },
  };

  it('renders lab investigations, doctor SOAP notes, discharge summary, and Powered by QuriioHQ', () => {
    const html = renderToString(
      <PatientMedicalReport
        patient={{
          name: 'Dinesh Dhangar',
          age: 35,
          gender: 'M',
          ipdNumber: '6158',
          doctorName: 'DR VINOD R PAWARA',
        }}
        report={dummyReport}
      />,
    );

    // Branding
    expect(html).toContain('Powered by QuriioHQ');
    expect(html).toContain('Dinesh Dhangar');
    expect(html).toContain('IPD-6158');

    // Section 1: Investigations
    expect(html).toContain('Diagnostic Investigations');
    expect(html).toContain('COMPLETE BLOOD COUNT (CBC)');
    expect(html).toContain('Hb 13.2 g/dL');

    // Section 2: Clinical Progress Notes
    expect(html).toContain('Doctor Progress &amp; Rounding Notes');
    expect(html).toContain('Patient reports reduced headache');
    expect(html).toContain('Viral pyrexia resolving.');

    // Section 3: Discharge Summary
    expect(html).toContain('Discharge Summary');
    expect(html).toContain('Acute Viral Pyrexia with Dehydration');
    expect(html).toContain('Paracetamol 650mg');
  });

  it('handles empty medical report gracefully with clean fallback messages', () => {
    const emptyReport: PrintableMedicalReport = {
      investigations: [],
      progressNotes: [],
      dischargeSummary: null,
    };

    const html = renderToString(
      <PatientMedicalReport
        patient={{
          name: 'Dinesh Dhangar',
          age: 35,
          gender: 'M',
          ipdNumber: '6158',
          doctorName: 'DR VINOD R PAWARA',
        }}
        report={emptyReport}
      />,
    );

    expect(html).toContain('No diagnostic investigations recorded for this stay.');
    expect(html).toContain('No clinical progress notes recorded for this stay.');
  });
});
