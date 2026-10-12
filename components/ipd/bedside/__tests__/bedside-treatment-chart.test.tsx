import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BedsideTreatmentChart } from '../bedside-treatment-chart';
import type { BedsideEmarView } from '@/lib/services/ipd-emar';
import type { SelectIpdMedicationOrder, SelectIpdMedicationAdministration } from '@/lib/db/schema';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('BedsideTreatmentChart Component', () => {
  const dummyEmarData: BedsideEmarView = {
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
        scheduledTime: new Date(),
        status: 'dueNow',
      },
    ],
    overdue: [],
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
        scheduledTime: new Date(Date.now() + 4 * 3600 * 1000),
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
        prnIndication: 'Fever above 100.5F or severe body ache',
        prnMinIntervalHours: 4,
        prnMaxDailyDoses: 4,
        eligibility: {
          eligible: true,
          dosesRemainingToday: 3,
        },
      },
    ],
    onHold: [],
    recentHistory: [],
  };

  it('renders patient name, bed number, diagnosis, and no allergies badge', () => {
    const html = renderToString(
      <BedsideTreatmentChart
        admissionId="adm-101"
        patient={{
          name: 'RAJ PATIL',
          ageSex: '25 yrs · Male',
          bedLabel: '2',
          wardName: 'Ward B',
          wardId: 'ward-b',
          day: 4,
          doctorName: 'Dr. Sharma',
          diagnosis: 'Acute Gastroenteritis with dehydration',
        }}
        emarData={dummyEmarData}
        allergyStatus="nkda"
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />,
    );

    expect(html).toContain('RAJ PATIL');
    expect(html).toContain('Bed 2');
    expect(html).toContain('Acute Gastroenteritis with dehydration');
    expect(html).toContain('No allergies');
    expect(html).toContain('1. Daily Scheduled Medicines');
    expect(html).toContain('2. As Needed (SOS)');
    expect(html).toContain('+ Supplies &amp; Consumables');
  });

  it('renders scheduled medications to give with Mark Given button', () => {
    const html = renderToString(
      <BedsideTreatmentChart
        admissionId="adm-101"
        patient={{
          name: 'RAJ PATIL',
          ageSex: '25 yrs · Male',
          bedLabel: '2',
          wardName: 'Ward B',
          wardId: 'ward-b',
          day: 4,
          doctorName: 'Dr. Sharma',
          diagnosis: 'Acute Gastroenteritis with dehydration',
        }}
        emarData={dummyEmarData}
        allergyStatus="nkda"
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />,
    );

    expect(html).toContain('Pantoprazole 40mg');
    expect(html).toContain('IV Injection (Direct)');
    expect(html).toContain('Mark Given');
    expect(html).toContain('Did Not Give');
  });
});
