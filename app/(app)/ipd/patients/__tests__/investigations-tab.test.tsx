import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { InvestigationsTab, type InvestigationItem } from '@/components/ipd/investigations/investigations-tab';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('InvestigationsTab Component', () => {
  const dummyTests: InvestigationItem[] = [
    {
      id: 'inv-1',
      name: 'Complete Blood Count (CBC)',
      category: 'Hematology',
      orderedAt: new Date('2026-10-13T09:00:00Z'),
      status: 'reported',
      result: 'Hb 13.2 g/dL, WBC 11,400 /mcL, Platelets 2.4L',
      normalRange: 'Hb: 12-16 g/dL, WBC: 4,000-11,000',
      isCritical: false,
    },
    {
      id: 'inv-2',
      name: 'Serum Potassium',
      category: 'Biochemistry',
      orderedAt: new Date('2026-10-13T10:00:00Z'),
      status: 'reported',
      result: '2.8 mEq/L (Critical Low)',
      normalRange: '3.5 - 5.0 mEq/L',
      isCritical: true,
    },
    {
      id: 'inv-3',
      name: 'Chest X-Ray (PA View)',
      category: 'Radiology',
      orderedAt: new Date('2026-10-13T11:00:00Z'),
      status: 'sample_collected',
      result: null,
      isCritical: false,
    },
  ];

  it('renders diagnostic investigations table, critical highlights, specimen tracking, and order button', () => {
    const html = renderToString(
      <InvestigationsTab
        admissionId="adm-101"
        investigations={dummyTests}
        testChips={[{ id: 't-1', name: 'Serum Creatinine' }]}
        canOrder={true}
      />,
    );

    // Expect test names and categories
    expect(html).toContain('Complete Blood Count (CBC)');
    expect(html).toContain('Serum Potassium');
    expect(html).toContain('Chest X-Ray (PA View)');
    expect(html).toContain('Hematology');
    expect(html).toContain('Biochemistry');

    // Expect critical badge
    expect(html).toContain('CRITICAL');

    // Expect order button
    expect(html).toContain('+ Order Tests');
  });
});
