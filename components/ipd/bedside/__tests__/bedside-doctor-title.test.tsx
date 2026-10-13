import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { BedsideTreatmentChart } from '../bedside-treatment-chart';
import type { BedsideEmarView } from '@/lib/services/ipd-emar';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('Bedside Treatment Chart - Doctor Name Sanitization', () => {
  const dummyEmar: BedsideEmarView = {
    dueNow: [],
    overdue: [],
    upcoming: [],
    prn: [],
    onHold: [],
    recentHistory: [],
  };

  it('prevents Dr. Dr. prefix duplication when doctorName has Dr. prefix', () => {
    const html = renderToString(
      <BedsideTreatmentChart
        admissionId="adm-1"
        patient={{
          name: 'Patient Name',
          ageSex: '25 yrs · Male',
          wardName: 'General Ward A',
          wardId: 'w-1',
          bedLabel: '13',
          day: 8,
          doctorName: 'Dr. Dr. Amit Mehra',
          diagnosis: 'Viral Pyrexia',
        }}
        emarData={dummyEmar}
        allergyStatus="nkda"
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />,
    );

    expect(html).toContain('Admitted by Dr. Amit Mehra');
    expect(html).not.toContain('Dr. Dr.');
  });
});
