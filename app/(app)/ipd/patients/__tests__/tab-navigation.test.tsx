import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TabNavigation } from '@/components/ipd/shell/tab-navigation';

describe('TabNavigation Component', () => {
  it('renders all 8 canonical tabs in fixed sequence with active indicators', () => {
    const html = renderToString(
      <TabNavigation admissionId="adm-101" currentTab="summary" />,
    );

    expect(html).toContain('Summary');
    expect(html).toContain('Prescriptions');
    expect(html).toContain('eMAR');
    expect(html).toContain('Vitals &amp; I/O');
    expect(html).toContain('Notes');
    expect(html).toContain('Investigations');
    expect(html).toContain('Consumables &amp; Billing');
    expect(html).toContain('Discharge');
    expect(html).toContain('/ipd/patients/adm-101/summary');
    expect(html).toContain('/ipd/patients/adm-101/orders');
    expect(html).toContain('/ipd/patients/adm-101/discharge');
  });
});
