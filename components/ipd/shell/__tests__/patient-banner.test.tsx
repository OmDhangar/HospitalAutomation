import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PatientBanner } from '../patient-banner';

describe('PatientBanner Component', () => {
  it('renders title-cased patient name, age/sex, UHID, IPD no, bed, consultant and allergy chip', () => {
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
    expect(html).toContain('Allergies: Penicillin, Sulfa');
    expect(html).toContain('Acute Gastroenteritis');
    expect(html).toContain('Admitted');
    expect(html).toContain('History');
    expect(html).toContain('Print file');
  });

  it('renders clickable amber chips when allergies or diagnosis are not recorded', () => {
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

    expect(html).toContain('Diagnosis not recorded');
    expect(html).toContain('Allergies not recorded');
    expect(html).toContain('Dr. Ramesh Kulkarni');
  });
});
