import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { DischargeTab } from '@/components/ipd/discharge/discharge-tab';

describe('Enhanced DischargeTab Component', () => {
  it('renders 5-card multi-department clearance matrix with progress and gate pass', () => {
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
        initialClearance={{
          dischargeType: 'regular',
          clinicalFitAt: new Date(),
          pharmacyReturnedAt: new Date(),
          pharmacyCreditNoteNo: 'CR-2026-0042',
          pharmacyCreditAmountPaise: 150000,
          takeHomeCounseled: true,
          ivCannulaRemoved: true,
          foleyCatheterRemoved: true,
          belongingsAndReportsHandedOver: true,
          dischargeVitalsTaken: true,
          nursingClearedAt: new Date(),
          billingClearedAt: new Date(),
          gatePassNumber: 'GP-2026-1049',
          gatePassIssuedAt: new Date(),
        } as any}
      />,
    );

    // Progress counter
    expect(html).toContain('Discharge Clearance Cockpit');
    expect(html).toContain('Cleared');

    // Step 1: Medical Clearance
    expect(html).toContain('Medical Clearance');
    expect(html).toContain('Dr. Sarah Jenkins');

    // Step 2: Pharmacy Return checklist & MedRec
    expect(html).toContain('Pharmacy Clearance');
    expect(html).toContain('Bedside Return');
    expect(html).toContain('CR-2026-0042');

    // Step 3: Nursing Handover & Line Removal
    expect(html).toContain('Nursing &amp; Bedside Handover');
    expect(html).toContain('IV Cannula &amp; lines removed');
    expect(html).toContain('Belongings &amp; original reports handed over');

    // Step 4: Discharge Summary
    expect(html).toContain('Discharge Summary');
    expect(html).toContain('Print Card');

    // Step 5: Billing & Exit Gate Pass
    expect(html).toContain('Billing Settlement &amp; Gate Pass');
    expect(html).toContain('GP-2026-1049');
    expect(html).toContain('View Gate Pass');
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
