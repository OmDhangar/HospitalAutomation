import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { IntakeStickySidebar } from '@/components/ipd/intake/intake-sticky-sidebar';

describe('Unified Intake Form & Sticky Checklist', () => {
  it('disables submit button and shows missing requirements when patient or bed is unselected', () => {
    const html = renderToString(
      <IntakeStickySidebar
        checklist={{
          hasPatient: false,
          hasDoctor: true,
          hasBed: false,
          hasArrived: false,
          hasAttendant: false,
          hasConsent: false,
          hasFinancial: false,
          isMlc: false,
          hasMlcPolice: true,
        }}
        onSubmit={() => {}}
        isSubmitting={false}
      />,
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('Select Patient, Doctor &amp; Bed');
    expect(html).toContain('1 of 7 ready');
  });

  it('enables MVA submit button as soon as patient, doctor, and bed are selected', () => {
    const html = renderToString(
      <IntakeStickySidebar
        checklist={{
          hasPatient: true,
          hasDoctor: true,
          hasBed: true,
          hasArrived: true,
          hasAttendant: false,
          hasConsent: false,
          hasFinancial: false,
          isMlc: false,
          hasMlcPolice: true,
        }}
        onSubmit={() => {}}
        isSubmitting={false}
      />,
    );

    expect(html).not.toContain('disabled=""');
    expect(html).toContain('Ready for Minimum Viable Admission');
    expect(html).toContain('4 of 7 ready');
  });

  it('shows MLC police intimation in checklist when MLC is active', () => {
    const html = renderToString(
      <IntakeStickySidebar
        checklist={{
          hasPatient: true,
          hasDoctor: true,
          hasBed: true,
          hasArrived: true,
          hasAttendant: true,
          hasConsent: true,
          hasFinancial: true,
          isMlc: true,
          hasMlcPolice: false,
        }}
        onSubmit={() => {}}
        isSubmitting={false}
      />,
    );

    expect(html).toContain('MLC Police Intimation');
    expect(html).toContain('7 of 8 ready');
  });
});
