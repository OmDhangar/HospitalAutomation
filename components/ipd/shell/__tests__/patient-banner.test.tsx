import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PatientBanner } from '../patient-banner';

describe('PatientBanner Component', () => {
  it('renders essential patient demographics, consultant, diagnosis, history and print actions', () => {
    const html = renderToString(
      <PatientBanner
        admissionId="adm-101"
        patient={{
          name: 'RAJ PATIL',
          age: 45,
          gender: 'Male',
          uhid: 'UHID-2024-0012',
          ipdNumber: 1042,
          wardName: 'General Ward A',
          bedLabel: '12',
          dayOfStay: 4,
          doctorName: 'Dr. Anand Sharma',
          diagnosis: 'Acute Gastroenteritis',
          allergyStatus: 'allergies_documented',
          allergies: ['Penicillin', 'Sulfa'],
          status: 'Admitted',
        }}
      />,
    );

    expect(html).toContain('Raj Patil');
    expect(html).toContain('45 yrs · Male');
    expect(html).toContain('UHID-2024-0012');
    expect(html).toContain('IPD #1042');
    expect(html).toContain('General Ward A · Bed 12');
    expect(html).toContain('Day 4');
    expect(html).toContain('Dr. Anand Sharma');
    expect(html).not.toContain('Dr. Dr.');
    expect(html).toContain('Acute Gastroenteritis');
    expect(html).toContain('Back');
    expect(html).toContain('href="/ipd/my-patients"');
    expect(html).toContain('History');
    expect(html).toContain('Print file');

    // Asserts top banner omits allergy chips, weight chips, and redundant Record TPR button
    expect(html).not.toContain('Allergies:');
    expect(html).not.toContain('Weight:');
    expect(html).not.toContain('+ Record TPR');
  });

  it('renders cleanly without clutter when allergies or measurements are present or absent', () => {
    const html = renderToString(
      <PatientBanner
        admissionId="adm-102"
        patient={{
          name: 'Sunita Roy',
          age: 32,
          gender: 'Female',
          uhid: 'UHID-2024-0015',
          ipdNumber: 1045,
          wardName: 'ICU',
          bedLabel: '3',
          dayOfStay: 1,
          doctorName: 'Ramesh Kulkarni',
          diagnosis: null,
          allergyStatus: 'unreviewed',
          allergies: [],
          status: 'Admitted',
        }}
      />,
    );

    expect(html).toContain('Sunita Roy');
    expect(html).toContain('Dr. Ramesh Kulkarni');
    expect(html).not.toContain('Allergies not recorded');
    expect(html).not.toContain('Weight: Not recorded');
  });

  it('renders critical NEWS2 escalation banner and chip when news2Score >= 5', () => {
    const html = renderToString(
      <PatientBanner
        admissionId="adm-104"
        patient={{
          name: 'Vikas Deshmukh',
          age: 62,
          gender: 'Male',
          uhid: 'UHID-2024-0120',
          ipdNumber: 1120,
          wardName: 'ICU',
          bedLabel: 'ICU-02',
          dayOfStay: 3,
          doctorName: 'Dr. Ramesh Kulkarni',
          diagnosis: 'Severe Pneumonia',
          allergyStatus: 'nkda',
          allergies: [],
          weightKg: 72,
          heightCm: 170,
          bmi: 24.9,
          news2Score: 6,
          isNews2Escalated: true,
          status: 'Admitted',
        }}
      />,
    );

    expect(html).toContain('CRITICAL NEWS2: Score 6 (High Risk Clinical Escalation)');
    expect(html).toContain('Doctor bedside review required');
    expect(html).toContain('NEWS2: 6 (Escalated)');
  });

  it('hides History and Print file buttons for nurses and points Back to medication chart', () => {
    const html = renderToString(
      <PatientBanner
        admissionId="adm-101"
        userRole="nurse"
        patient={{
          name: 'RAJ PATIL',
          uhid: 'UHID-2024-0012',
          ipdNumber: 1042,
          wardName: 'General Ward A',
          bedLabel: '12',
          status: 'Admitted',
        }}
      />,
    );

    expect(html).not.toContain('History');
    expect(html).not.toContain('Print file');
    expect(html).toContain('href="/ipd/patients/adm-101/emar"');
    expect(html).toContain('Back to Medication Chart');
  });

  it('renders Back to Ward link when backHref points to a ward path', () => {
    const html = renderToString(
      <PatientBanner
        admissionId="adm-101"
        userRole="nurse"
        backHref="/ipd/ward/ward-icu/bed/b-1"
        patient={{
          name: 'RAJ PATIL',
          uhid: 'UHID-2024-0012',
          ipdNumber: 1042,
          wardName: 'General Ward A',
          bedLabel: '12',
          status: 'Admitted',
        }}
      />,
    );

    expect(html).toContain('href="/ipd/ward/ward-icu/bed/b-1"');
    expect(html).toContain('Back to Ward');
  });
});

