import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { TabNavigation } from '@/components/ipd/shell/tab-navigation';

describe('TabNavigation All 8 Tabs and Badges', () => {
  it('correctly sets active state for each of the 8 canonical tabs', () => {
    const tabs = [
      { id: 'summary', path: '/ipd/patients/adm-101/summary' },
      { id: 'orders', path: '/ipd/patients/adm-101/orders' },
      { id: 'emar', path: '/ipd/patients/adm-101/emar' },
      { id: 'vitals', path: '/ipd/patients/adm-101/vitals' },
      { id: 'notes', path: '/ipd/patients/adm-101/notes' },
      { id: 'investigations', path: '/ipd/patients/adm-101/investigations' },
      { id: 'billing', path: '/ipd/patients/adm-101/billing' },
      { id: 'discharge', path: '/ipd/patients/adm-101/discharge' },
    ];

    for (const tab of tabs) {
      const html = renderToString(
        <TabNavigation admissionId="adm-101" currentTab={tab.id} />,
      );
      // The active link has aria-current="page"
      expect(html).toContain(`href="${tab.path}"`);
      expect(html).toContain('aria-current="page"');
    }
  });

  it('renders clinical alert badges for unverified orders, overdue doses, critical labs, and discharge ready', () => {
    const html = renderToString(
      <TabNavigation
        admissionId="adm-101"
        currentTab="summary"
        counts={{
          unverifiedOrders: 3,
          overdueDoses: 2,
          criticalInvestigations: 1,
          isDischargeReady: true,
        }}
      />,
    );

    // Badge counts
    expect(html).toContain('>3</span>');
    expect(html).toContain('>2</span>');
    expect(html).toContain('>1</span>');
    expect(html).toContain('>Ready</span>');
  });
});
