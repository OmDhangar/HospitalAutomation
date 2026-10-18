import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BedsideTreatmentWorkspace } from '../bedside-treatment-workspace';
import type { BedsideEmarView } from '@/lib/services/ipd-emar';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('BedsideTreatmentWorkspace Component', () => {
  const dummyEmarData: BedsideEmarView = {
    dueNow: [
      {
        orderId: 'ord-10',
        orderChainId: 'chain-10',
        medicineId: 'med-10',
        medicineName: 'Amoxicillin 500mg',
        doseAmount: '500',
        doseUnit: 'mg',
        route: 'oral',
        scheduleType: 'scheduled',
        scheduledTime: new Date(),
        status: 'dueNow',
      },
    ],
    overdue: [],
    upcoming: [],
    prn: [
      {
        orderId: 'ord-11',
        orderChainId: 'chain-11',
        medicineId: 'med-11',
        medicineName: 'Ondansetron 4mg',
        doseAmount: '4',
        doseUnit: 'mg',
        route: 'iv_push',
        prnIndication: 'Nausea or vomiting',
        prnMinIntervalHours: 8,
        prnMaxDailyDoses: 3,
        eligibility: {
          eligible: true,
          dosesRemainingToday: 3,
        },
      },
    ],
    onHold: [],
    recentHistory: [],
  };

  it('renders unified workspace with patient information, tabs, and allergy indicators', () => {
    const html = renderToString(
      <BedsideTreatmentWorkspace
        admissionId="adm-200"
        patient={{
          name: 'PRIYA DESHMUKH',
          ageSex: '32 yrs · Female',
          bedLabel: 'ICU-3',
          wardName: 'Intensive Care Unit',
          wardId: 'ward-icu',
          day: 2,
          doctorName: 'Dr. Kulkarni',
          diagnosis: 'Post-operative monitoring',
        }}
        emarData={dummyEmarData}
        allergyStatus="allergies_documented"
        allergies={[{ substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe' }]}
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />,
    );

    expect(html).toContain('PRIYA DESHMUKH');
    expect(html).toContain('Bed ICU-3');
    expect(html).toContain('Post-operative monitoring');
    expect(html).toContain('Allergic to');
    expect(html).toContain('Penicillin');
    expect(html).toContain('Amoxicillin 500mg');
    expect(html).toContain('1. Daily Medicines');
    expect(html).toContain('2. As Needed (SOS)');
    expect(html).toContain('+ Syringes &amp; Items');
  });
});
