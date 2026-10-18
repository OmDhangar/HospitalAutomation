import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MinimalOrdersTab } from '@/components/ipd/orders/minimal-orders-tab';
import { DischargeTab } from '@/components/ipd/discharge/discharge-tab';

describe('Minimal Orders and Discharge Tabs', () => {
  it('renders active orders with Stop and Modify action triggers', () => {
    const html = renderToString(
      <MinimalOrdersTab
        admissionId="adm-101"
        orders={[
          {
            id: 'ord-1',
            medicineName: 'Ceftriaxone 1g',
            doseAmount: '1',
            doseUnit: 'g',
            route: 'iv_push',
            status: 'active',
            frequencyCode: 'BD',
            scheduleTimes: ['08:00', '20:00'],
          } as any,
        ]}
      />,
    );

    expect(html).toContain('Ceftriaxone 1g');
    expect(html).toContain('BD');
    expect(html).toContain('Stop Order');
    expect(html).toContain('Modify');
  });

  it('renders discharge actions: discharge readiness toggle and discharge bill action', () => {
    const html = renderToString(
      <DischargeTab
        admissionId="adm-101"
        status="admitted"
        canDischarge={true}
      />,
    );

    expect(html).toContain('Discharge Workflow');
    expect(html).toContain('Mark Ready for Discharge');
    expect(html).toContain('Finalize Discharge Bill');
  });
});
