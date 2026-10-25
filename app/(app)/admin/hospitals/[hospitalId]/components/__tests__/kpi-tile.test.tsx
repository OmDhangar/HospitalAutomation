import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { KpiTile } from '@/app/(app)/admin/ui';

describe('KpiTile', () => {
  it('renders label, value, and hint', () => {
    const html = renderToString(
      <KpiTile
        label="PLAN"
        value="Clinic · Annual"
        hint="Active"
        tone="brand"
      />,
    );
    expect(html).toContain('PLAN');
    expect(html).toContain('Clinic · Annual');
    expect(html).toContain('Active');
    expect(html).toContain('text-brand-700');
  });

  it('renders progress bar with appropriate color based on usage percent', () => {
    // < 70% -> brand-500
    const htmlUnder70 = renderToString(
      <KpiTile
        label="CAPACITY"
        value="30 / 100"
        progress={{ used: 30, limit: 100 }}
      />,
    );
    expect(htmlUnder70).toContain('bg-brand-500');

    // 70-89% -> amber-500
    const html75 = renderToString(
      <KpiTile
        label="CAPACITY"
        value="75 / 100"
        progress={{ used: 75, limit: 100 }}
      />,
    );
    expect(html75).toContain('bg-amber-500');

    // >= 90% -> rose-500
    const html95 = renderToString(
      <KpiTile
        label="CAPACITY"
        value="95 / 100"
        progress={{ used: 95, limit: 100 }}
      />,
    );
    expect(html95).toContain('bg-rose-500');
  });

  it('renders tone warn and danger properly', () => {
    const htmlWarn = renderToString(
      <KpiTile label="TERM" value="2 days left" tone="warn" />,
    );
    expect(htmlWarn).toContain('text-amber-700');

    const htmlDanger = renderToString(
      <KpiTile label="TERM" value="Expired" tone="danger" />,
    );
    expect(htmlDanger).toContain('text-rose-700');
  });
});
