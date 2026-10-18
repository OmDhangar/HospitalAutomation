import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { DailyMedicationMatrix } from '@/components/ipd/summary/daily-medication-matrix';
import { TprFlowsheet } from '@/components/ipd/summary/tpr-flowsheet';
import { SummaryAdministeredCard } from '@/components/ipd/summary/summary-administered-card';
import { DoctorQuickActions } from '@/components/ipd/summary/doctor-quick-actions';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
}));

describe('Doctor Summary Cockpit Components', () => {
  it('renders medication schedule with checkmark for given dose and pending box for due dose', () => {
    const mockMeds = [
      {
        orderId: 'ord-1',
        medicineName: 'Inj. Ceftriaxone 1g',
        route: 'IV',
        frequency: 'BD',
        slots: [
          { time: '08:00', status: 'GIVEN' as const, givenAt: '08:15', nurseName: 'Nurse Rita' },
          { time: '20:00', status: 'DUE' as const },
        ],
      },
    ];

    const html = renderToString(<DailyMedicationMatrix medications={mockMeds} />);
    expect(html).toContain('Inj. Ceftriaxone 1g');
    expect(html).toContain('08:15');
    expect(html).toContain('Given');
    expect(html).toContain('20:00');
    expect(html).toContain('Due');
  });

  it('renders TPR flowsheet with temp, pulse, BP, resp, and NEWS2 columns', () => {
    const mockVitals = [
      {
        time: 'Today 08:00',
        tempF: '100.4',
        pulse: 88,
        bp: '120/80',
        resp: 18,
        spo2: 98,
        news2: 1,
      },
    ];

    const html = renderToString(<TprFlowsheet readings={mockVitals} />);
    expect(html).toContain('100.4');
    expect(html).toContain('120/80');
    expect(html).toContain('88');
    expect(html).toContain('NEWS2');
    expect(html).toContain('Pulse');
  });

  it('renders empty fallback cleanly with Create Treatment Plan button', () => {
    const htmlMeds = renderToString(
      <DailyMedicationMatrix medications={[]} admissionId="adm-101" canPrescribe={true} />,
    );
    expect(htmlMeds).toContain('No active prescriptions recorded yet');
    expect(htmlMeds).toContain('Create Treatment Plan &amp; Prescribe');

    const htmlVitals = renderToString(<TprFlowsheet readings={[]} />);
    expect(htmlVitals).toContain('No vital readings recorded yet');
  });

  it('renders summary administered card with doses given today', () => {
    const mockDoses = [
      {
        id: 'dose-1',
        doseGiven: 'Paracetamol 650mg',
        routeGiven: 'oral',
        actualTime: new Date('2026-10-15T08:00:00Z'),
        outcome: 'administered',
      },
    ];

    const html = renderToString(
      <SummaryAdministeredCard admissionId="adm-101" doses={mockDoses} />,
    );
    expect(html).toContain('Given Medicines Today');
    expect(html).toContain('1 given');
    expect(html).toContain('Paracetamol 650mg');
    expect(html).toContain('By Mouth (Oral)');
  });

  it('renders doctor quick actions buttons for note, prescribe, and order tests', () => {
    const html = renderToString(
      <DoctorQuickActions
        admissionId="adm-101"
        patientName="Kavita Shinde"
        canPrescribe={true}
        testChips={[{ id: 'test-1', name: 'Complete Blood Count (CBC)' }]}
      />,
    );
    expect(html).toContain('+ Progress Note');
    expect(html).toContain('+ Prescribe Medicine');
    expect(html).toContain('+ Order Test');
  });
});
