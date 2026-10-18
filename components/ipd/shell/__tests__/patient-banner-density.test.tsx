import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PatientBanner } from '../patient-banner';
import { TabNavigation } from '../tab-navigation';

describe('PatientBanner & TabNavigation Density', () => {
  const mockPatient = {
    name: 'RAJ PATIL',
    age: 25,
    gender: 'Male',
    uhid: 'UHID-6160',
    ipdNumber: 6160,
    wardName: 'General Ward A',
    bedLabel: '13',
    dayOfStay: 8,
    doctorName: 'Dr. Amit Mehra',
    diagnosis: 'Viral Pyrexia',
    allergyStatus: 'nkda' as const,
    allergies: [],
    status: 'Admitted',
  };

  it('renders ultra-compact single-row patient demographics with high density classes', () => {
    const html = renderToString(
      <PatientBanner admissionId="test-adm-id" patient={mockPatient} />
    );

    // Doctor title normalized without double title
    expect(html).toContain('Dr. Amit Mehra');
    expect(html).not.toContain('Dr. Dr.');

    // High density / compact padding classes on banner
    expect(html).toContain('py-1.5');
    expect(html).toContain('text-xs');
    expect(html).toContain('General Ward A · Bed 13');
    expect(html).toContain('Day 8');
  });

  it('renders compact tab navigation with high-density padding and simple English labels', () => {
    const html = renderToString(
      <TabNavigation admissionId="test-adm-id" currentTab="summary" />
    );

    // Verify compact height & padding
    expect(html).toContain('py-1.5');
    expect(html).toContain('Summary');
    expect(html).toContain('Prescriptions');
    expect(html).toContain('Medication Chart');
    expect(html).toContain('Vitals &amp; I/O');
  });
});
