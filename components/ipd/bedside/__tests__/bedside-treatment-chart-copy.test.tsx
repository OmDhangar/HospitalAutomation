import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/ipd/ward/w1/bed/b1',
}));

import { BedsideTreatmentChart } from '../bedside-treatment-chart';

describe('Nurse Bedside Simplified Experience', () => {
  const mockPatient = {
    name: 'Raj Patil',
    ageSex: '25 yrs · Male',
    wardId: 'ward-1',
    wardName: 'General Ward A',
    bedLabel: '13',
    day: 8,
    doctorName: 'Amit Mehra',
    diagnosis: 'Viral Pyrexia',
    ipdNumber: '6160',
  };

  const mockEmar = {
    dueNow: [
      {
        orderId: 'ord-1',
        medicineId: 'med-1',
        medicineName: 'Paracetamol',
        strength: '500mg',
        form: 'Tablet',
        doseAmount: '500',
        doseUnit: 'mg',
        route: 'oral',
        scheduleType: 'scheduled' as const,
        scheduledSlot: new Date().toISOString(),
        frequencyCode: 'TDS',
        scheduleTimes: ['08:00', '14:00', '20:00'],
      },
    ],
    overdue: [],
    upcoming: [],
    onHold: [],
    prn: [],
    recentHistory: [],
  };

  it('renders plain-English "+ Give Extra Medicine" button and no bulky alarm banner', () => {
    const html = renderToString(
      <BedsideTreatmentChart
        admissionId="adm-123"
        patient={mockPatient}
        emarData={mockEmar}
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />
    );

    // Simple plain English button exists
    expect(html).toContain('+ Give Extra Medicine');

    // Bulky alarming banner copy is removed
    expect(html).not.toContain('Acute Patient Condition Change');

    // Plain English action labels
    expect(html).toContain('Give Medicine');
    expect(html).toContain('Change Time');
    expect(html).toContain('Syringes &amp; Items');
  });
});
