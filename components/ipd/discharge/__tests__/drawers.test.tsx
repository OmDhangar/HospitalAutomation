import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { PharmacyReturnDrawer } from '@/components/ipd/discharge/drawers/pharmacy-return-drawer';
import { MedicalClearanceModal } from '@/components/ipd/discharge/drawers/medical-clearance-modal';
import { GatePassModal } from '@/components/ipd/discharge/drawers/gate-pass-modal';

describe('Discharge Drawers & Modals', () => {
  it('renders PharmacyReturnDrawer with return items and credit note input', () => {
    const html = renderToString(
      <PharmacyReturnDrawer
        isOpen={true}
        onClose={() => {}}
        admissionId="adm-101"
        initialItems={[
          {
            medicineName: 'Inj Ceftriaxone 1g',
            dispensedQty: 6,
            returnedQty: 2,
            unitPricePaise: 12000,
            creditPaise: 24000,
            reason: 'unconsumed',
          },
        ]}
        activeOrders={[]}
        initialCreditNoteNo="CR-2026-001"
        initialCreditAmountPaise={24000}
        initialCounseled={true}
        onSave={async () => {}}
      />,
    );

    expect(html).toContain('Pharmacy Returns &amp; Dispensing Clearance');
    expect(html).toContain('Inj Ceftriaxone 1g');
    expect(html).toContain('CR-2026-001');
    expect(html).toContain('Sign off Pharmacy Clearance');
  });

  it('renders MedicalClearanceModal with discharge type selector', () => {
    const html = renderToString(
      <MedicalClearanceModal
        isOpen={true}
        onClose={() => {}}
        admissionId="adm-101"
        doctorName="Dr. Rajesh Kulkarni"
        initialDischargeType="regular"
        isReady={false}
        onSave={async () => {}}
      />,
    );

    expect(html).toContain('Medical Clearance &amp; Stability');
    expect(html).toContain('Regular Discharge');
    expect(html).toContain('Dr. Rajesh Kulkarni');
    expect(html).toContain('Certify Fit to Discharge');
  });

  it('renders GatePassModal with patient and clearance summary', () => {
    const html = renderToString(
      <GatePassModal
        isOpen={true}
        onClose={() => {}}
        admissionId="adm-101"
        patientName="Ramesh Sharma"
        gatePassNumber="GP-2026-9041"
        issuedAt={new Date()}
        clearanceStatus={{
          isMedicalCleared: true,
          isPharmacyCleared: true,
          isNursingCleared: true,
          isSummaryFinalized: true,
          isBillingCleared: true,
          canIssueGatePass: true,
          completedCount: 5,
        }}
        onIssue={async () => {}}
      />,
    );

    expect(html).toContain('PATIENT DISCHARGE EXIT GATE PASS');
    expect(html).toContain('GP-2026-9041');
    expect(html).toContain('Ramesh Sharma');
    expect(html).toContain('Print Gate Pass');
  });
});
