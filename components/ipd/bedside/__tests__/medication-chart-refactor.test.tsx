import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BedsideTreatmentChart, MedicationChart } from '../bedside-treatment-chart';
import type { BedsideEmarView } from '@/lib/services/ipd-emar';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('MedicationChart UI/UX Optimization', () => {
  const mockEmar: BedsideEmarView = {
    dueNow: [
      {
        orderId: 'ord-1',
        orderChainId: 'chain-1',
        medicineId: 'med-1',
        medicineName: 'Pantoprazole 40mg',
        doseAmount: '40',
        doseUnit: 'mg',
        route: 'iv_push',
        scheduleType: 'scheduled',
        scheduledTime: new Date('2026-10-18T10:00:00Z'),
        status: 'dueNow',
      },
    ],
    overdue: [
      {
        orderId: 'ord-overdue',
        orderChainId: 'chain-overdue',
        medicineId: 'med-overdue',
        medicineName: 'Amoxicillin 500mg',
        doseAmount: '500',
        doseUnit: 'mg',
        route: 'oral',
        scheduleType: 'scheduled',
        scheduledTime: new Date('2026-10-18T08:00:00Z'),
        status: 'overdue',
      },
    ],
    upcoming: [
      {
        orderId: 'ord-2',
        orderChainId: 'chain-2',
        medicineId: 'med-2',
        medicineName: 'Ceftriaxone 1g',
        doseAmount: '1',
        doseUnit: 'g',
        route: 'iv_push',
        scheduleType: 'scheduled',
        scheduledTime: new Date('2026-10-18T14:00:00Z'),
        status: 'upcoming',
      },
    ],
    prn: [
      {
        orderId: 'ord-3',
        orderChainId: 'chain-3',
        medicineId: 'med-3',
        medicineName: 'Paracetamol 500mg',
        doseAmount: '500',
        doseUnit: 'mg',
        route: 'oral',
        prnIndication: 'Fever or headache',
        prnMinIntervalHours: 4,
        prnMaxDailyDoses: 4,
        eligibility: {
          eligible: true,
          dosesRemainingToday: 3,
        },
      },
    ],
    onHold: [],
    recentHistory: [
      {
        id: 'hist-1',
        doseGiven: 'Pantoprazole 40mg',
        routeGiven: 'iv_push',
        actualTime: new Date('2026-10-18T06:00:00Z'),
        outcome: 'administered',
      } as any,
    ],
  };

  const patient = {
    name: 'Kavita Shinde',
    ageSex: '33 yrs · Female',
    bedLabel: '12',
    wardName: 'General Ward A',
    wardId: 'w-1',
    day: 11,
    doctorName: 'Dr. Amit Mehra',
    diagnosis: 'Acute viral hepatitis',
    ipdNumber: '6159',
  };

  it('exports MedicationChart as an alias for BedsideTreatmentChart', () => {
    expect(MedicationChart).toBeDefined();
    expect(MedicationChart).toBe(BedsideTreatmentChart);
  });

  it('renders a collapsed, streamlined patient header with key identifiers and allergy pill', () => {
    const html = renderToString(
      <MedicationChart
        admissionId="adm-kavita"
        patient={patient}
        emarData={mockEmar}
        allergyStatus="nkda"
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />,
    );

    expect(html).toContain('Kavita Shinde');
    expect(html).toContain('Bed 12');
    expect(html).toContain('Admitted by Dr. Amit Mehra');
    expect(html).toContain('Acute viral hepatitis');
    expect(html).toContain('No allergies');
  });

  it('renders compact medication items with pill-shaped status badges and inline button groups', () => {
    const html = renderToString(
      <MedicationChart
        admissionId="adm-kavita"
        patient={patient}
        emarData={mockEmar}
        allergyStatus="nkda"
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />,
    );

    // Pill badges for status
    expect(html).toContain('Overdue');
    expect(html).toContain('Due Now');

    // Inline button group actions
    expect(html).toContain('Change Time');
    expect(html).toContain('Skip Dose');
    expect(html).toContain('Give Medicine');

    // Check for 2-column layout and scroll container
    expect(html).toContain('overflow-y-auto');
  });

  it('supports high-density compact single-line actions and responsive text handling', () => {
    const html = renderToString(
      <MedicationChart
        admissionId="adm-kavita"
        patient={patient}
        emarData={mockEmar}
        allergyStatus="nkda"
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />,
    );

    // Checks for compact 28px-32px action bar buttons
    expect(html).toContain('h-7 sm:h-8');
    // Checks for whitespace-nowrap to prevent button text wraps
    expect(html).toContain('whitespace-nowrap');
    // Checks for flex-wrap on medicine name and dose badges
    expect(html).toContain('flex-wrap items-baseline gap-1.5');
  });

  it('redirects nurses directly to the dedicated TPR sheet via + Record TPR link', () => {
    const html = renderToString(
      <MedicationChart
        admissionId="adm-kavita"
        patient={patient}
        emarData={mockEmar}
        allergyStatus="nkda"
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />,
    );

    expect(html).toContain('+ Record TPR');
    expect(html).toContain('href="/ipd/patients/adm-kavita/vitals"');
  });
});

