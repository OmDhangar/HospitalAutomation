import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { DischargeTab } from '@/components/ipd/discharge/discharge-tab';

describe('Enhanced DischargeTab Component', () => {
  it('renders 4-step clearance workflow: Medical, Pharmacy, Billing, and Discharge Summary', () => {
    const html = renderToString(
      <DischargeTab
        admissionId="adm-101"
        status="discharge_ready"
        canDischarge={true}
        doctorName="Dr. Sarah Jenkins"
        patientName="Rajesh Patel"
        bedLabel="Bed 104"
        wardName="ICU Ward"
        dischargeMedicationsCount={4}
      />,
    );

    // Step 1: Medical Clearance
    expect(html).toContain('Medical Clearance');
    expect(html).toContain('Patient is marked ready for discharge');
    expect(html).toContain('Undo Readiness');

    // Step 2: Pharmacy Return checklist
    expect(html).toContain('Pharmacy Reconciliation');
    expect(html).toContain('Return unused medications to pharmacy');

    // Step 3: Final Bill Settlement
    expect(html).toContain('Final Bill Settlement');
    expect(html).toContain('Finalize Discharge Bill');

    // Step 4: Discharge Summary & Card
    expect(html).toContain('Discharge Summary');
    expect(html).toContain('Print Discharge Card');
    expect(html).toContain('4 take-home medications');
  });

  it('allows marking ready when status is admitted', () => {
    const html = renderToString(
      <DischargeTab
        admissionId="adm-102"
        status="admitted"
        canDischarge={true}
      />,
    );

    expect(html).toContain('Mark Ready for Discharge');
    expect(html).toContain('Admitted');
  });
});
