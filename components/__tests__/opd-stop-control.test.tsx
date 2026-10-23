import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpdStopControl } from '@/app/(app)/dashboard/opd-stop-control';

// Mock dependencies that client components might invoke
vi.mock('@/components/toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('@/app/(app)/dashboard/opd-actions', () => ({
  stopOpdTodayDynamic: vi.fn(),
  reopenOpdDynamic: vi.fn(),
  stopAllOpdInBranchDynamic: vi.fn(),
}));

describe('OpdStopControl component rendering', () => {
  it('renders "Stop OPD today" button when stoppedAt is null', () => {
    const html = renderToStaticMarkup(
      <OpdStopControl doctorId="doc-1" status={null} timezone="Asia/Kolkata" />
    );
    expect(html).toContain('Stop OPD today');
  });

  it('renders "OPD closed at ... · Reopen" when isStopped is true and canReopen is true', () => {
    // 3:00 PM IST is 09:30:00Z
    const testDate = new Date('2026-10-23T09:30:00Z');
    const html = renderToStaticMarkup(
      <OpdStopControl
        doctorId="doc-1"
        status={{
          stoppedAt: testDate,
          isStopped: true,
          scheduled: false,
          canReopen: true,
        }}
        timezone="Asia/Kolkata"
      />
    );
    expect(html).toMatch(/OPD closed at 3:00\s*pm/i);
    expect(html).toContain('Reopen');
  });

  it('hides "Reopen" button when canReopen is false', () => {
    const testDate = new Date('2026-10-23T09:30:00Z');
    const html = renderToStaticMarkup(
      <OpdStopControl
        doctorId="doc-1"
        status={{
          stoppedAt: testDate,
          isStopped: true,
          scheduled: false,
          canReopen: false,
        }}
        timezone="Asia/Kolkata"
      />
    );
    expect(html).toMatch(/OPD closed at 3:00\s*pm/i);
    expect(html).not.toContain('Reopen');
  });

  it('renders "OPD will stop at ... · Cancel" when scheduled is true', () => {
    const testDate = new Date('2026-10-23T09:30:00Z');
    const html = renderToStaticMarkup(
      <OpdStopControl
        doctorId="doc-1"
        status={{
          stoppedAt: testDate,
          isStopped: false,
          scheduled: true,
          canReopen: true,
        }}
        timezone="Asia/Kolkata"
      />
    );
    expect(html).toMatch(/OPD will stop at 3:00\s*pm/i);
    expect(html).toContain('Cancel');
  });
});
