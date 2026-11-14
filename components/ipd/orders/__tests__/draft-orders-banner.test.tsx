import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { MinimalOrdersTab, type DraftMedicationOrderItem } from '../minimal-orders-tab';

vi.mock('@/app/(app)/ipd/actions', () => ({
  cosignVerbalOrderAction: vi.fn(),
  rejectVerbalOrderAction: vi.fn(),
  approveDraftMedicationOrderAction: vi.fn(),
  approveAllDraftMedicationOrdersAction: vi.fn(),
  rejectDraftMedicationOrderAction: vi.fn(),
}));

describe('MinimalOrdersTab with Draft OPD Orders', () => {
  const mockDraftOrders: DraftMedicationOrderItem[] = [
    {
      id: 'draft-1',
      orderChainId: 'chain-1',
      medicineId: 'med-1',
      medicineName: 'Amoxicillin 500mg',
      strength: '500 mg',
      doseAmount: '500',
      doseUnit: 'mg',
      route: 'oral',
      frequencyCode: 'TDS',
      scheduleTimes: ['08:00', '14:00', '20:00'],
      scheduleType: 'scheduled',
      isPrn: false,
      specialInstructions: 'After food with plenty of water',
      origin: 'opd_prescription',
      status: 'draft',
      createdAt: new Date('2026-11-04T10:00:00Z'),
    },
    {
      id: 'draft-2',
      orderChainId: 'chain-2',
      medicineId: 'med-2',
      medicineName: 'Paracetamol 650mg',
      strength: '650 mg',
      doseAmount: '650',
      doseUnit: 'mg',
      route: 'oral',
      frequencyCode: 'SOS',
      scheduleTimes: [],
      scheduleType: 'prn',
      isPrn: true,
      specialInstructions: 'If fever > 100 F',
      origin: 'opd_prescription',
      status: 'draft',
      createdAt: new Date('2026-11-04T10:00:00Z'),
    },
  ];

  it('renders amber draft orders review banner when draft orders exist', () => {
    const html = renderToString(
      <MinimalOrdersTab
        admissionId="adm-101"
        orders={[]}
        draftOrders={mockDraftOrders}
        patientName="Rajesh Sharma"
        uhid="UHID-9876"
      />,
    );

    // Banner header and counter
    expect(html).toContain('Pending Admission Orders from OPD (2)');
    expect(html).toContain('Ported from outpatient doctor consultation during admission');
    expect(html).toContain('Approve All Valid Orders');

    // Item 1
    expect(html).toContain('Amoxicillin 500mg');
    expect(html).toContain('500 mg');
    expect(html).toContain('oral');
    expect(html).toContain('TDS');
    expect(html).toContain('After food with plenty of water');

    // Item 2
    expect(html).toContain('Paracetamol 650mg');
    expect(html).toContain('650 mg');
    expect(html).toContain('PRN (SOS)');
    expect(html).toContain('If fever &gt; 100 F');

    // Line actions
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
  });

  it('does not render amber draft orders banner when draftOrders is empty', () => {
    const html = renderToString(
      <MinimalOrdersTab
        admissionId="adm-101"
        orders={[]}
        draftOrders={[]}
        patientName="Rajesh Sharma"
        uhid="UHID-9876"
      />,
    );

    expect(html).not.toContain('Pending Admission Orders from OPD');
    expect(html).not.toContain('Approve All Valid Orders');
  });
});
