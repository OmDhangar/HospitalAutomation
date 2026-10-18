import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CompactPatientBar } from '../compact-patient-bar';

describe('CompactPatientBar Component', () => {
  const defaultProps = {
    name: 'Ramesh Kumar',
    age: 48,
    gender: 'male',
    phoneE164: '+919876543210',
    bed: { label: '04', wardName: 'Male Medical Ward' },
    admittedAt: new Date(Date.now() - 2 * 86400000), // Day 3
    doctorName: 'Dr. Anand Sharma',
    status: 'admitted' as const,
    timezone: 'Asia/Kolkata',
    now: new Date(),
    ipdNumber: 108,
    backHref: '/ipd',
    backLabel: '← IPD',
  };

  it('renders patient identity and bed information cleanly', () => {
    const html = renderToString(<CompactPatientBar {...defaultProps} />);
    expect(html).toContain('Ramesh Kumar');
    expect(html).toContain('Male Medical Ward · Bed 04');
    expect(html).toContain('48 M');
    expect(html).toContain('IPD #108');
    expect(html).toContain('Day 3');
    expect(html).toContain('Dr. Anand Sharma');
    expect(html).toContain('Admitted');
    expect(html).toContain('← IPD');
  });

  it('handles unassigned beds gracefully', () => {
    const html = renderToString(
      <CompactPatientBar
        {...defaultProps}
        bed={null}
        status="awaiting_bed"
        admittedAt={null}
      />,
    );
    expect(html).toContain('No bed yet');
    expect(html).toContain('Awaiting bed');
  });

  it('renders optional action buttons when provided', () => {
    const html = renderToString(
      <CompactPatientBar
        {...defaultProps}
        actions={
          <>
            <a href="/print">Print file</a>
            <a href="/history">History</a>
          </>
        }
      />,
    );
    expect(html).toContain('Print file');
    expect(html).toContain('History');
  });
});
