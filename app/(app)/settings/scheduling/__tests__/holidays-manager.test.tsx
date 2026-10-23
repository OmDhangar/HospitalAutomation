import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HolidaysAndBlackoutsManager } from '../holidays-manager';
import type { BlackoutPeriodItem } from '@/lib/services/blackout';

vi.mock('@/components/toast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('../blackout-actions', () => ({
  previewBlackoutAction: vi.fn(),
  createBlackoutAction: vi.fn(),
  revokeBlackoutAction: vi.fn(),
  listBlackoutPeriodsAction: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));

describe('HolidaysAndBlackoutsManager Component', () => {
  const dummyDoctors = [
    { id: 'doc-1', name: 'Rohan Deshmukh', branchId: 'b-1', branchName: 'Main' },
  ];
  const dummyBranches = [{ id: 'b-1', name: 'Main' }];

  it('renders title, hint, and empty state when no blackouts exist', () => {
    const html = renderToStaticMarkup(
      <HolidaysAndBlackoutsManager
        doctors={dummyDoctors}
        branches={dummyBranches}
        initialBlackouts={[]}
      />,
    );

    expect(html).toContain('Holiday Shutdowns &amp; Multi-Day Blackouts');
    expect(html).toContain('Add Holiday / Blackout');
    expect(html).toContain('No active blackout periods');
  });

  it('renders active blackouts table with dates, reopen date, and public reason', () => {
    const activeBlackouts: BlackoutPeriodItem[] = [
      {
        id: 'blk-1',
        hospitalId: 'h-1',
        branchId: null,
        branchName: null,
        doctorId: null,
        doctorName: null,
        startDate: '2026-10-26',
        endDate: '2026-10-28',
        reopenDate: '2026-10-29',
        reason: 'Diwali Festival Maintenance',
        publicReason: 'Diwali Holidays',
        createdByUserId: 'usr-1',
        cancelledAt: null,
        cancelledByUserId: null,
        createdAt: new Date(),
      },
      {
        id: 'blk-2',
        hospitalId: 'h-1',
        branchId: 'b-1',
        branchName: 'Main',
        doctorId: 'doc-1',
        doctorName: 'Rohan Deshmukh',
        startDate: '2026-11-05',
        endDate: '2026-11-06',
        reopenDate: '2026-11-07',
        reason: 'Conference leave',
        publicReason: 'Doctor attending medical conference',
        createdByUserId: 'usr-1',
        cancelledAt: null,
        cancelledByUserId: null,
        createdAt: new Date(),
      },
    ];

    const html = renderToStaticMarkup(
      <HolidaysAndBlackoutsManager
        doctors={dummyDoctors}
        branches={dummyBranches}
        initialBlackouts={activeBlackouts}
      />,
    );

    // Assert table content
    expect(html).toContain('2026-10-26 to 2026-10-28');
    expect(html).toContain('2026-10-29');
    expect(html).toContain('Hospital-wide (All Doctors)');
    expect(html).toContain('Diwali Holidays');

    expect(html).toContain('2026-11-05 to 2026-11-06');
    expect(html).toContain('2026-11-07');
    expect(html).toContain('Dr. Rohan Deshmukh');
    expect(html).toContain('Doctor attending medical conference');
    expect(html).toContain('Revoke');
  });

  it('renders revoked/past history section when cancelled blackouts exist', () => {
    const mixedBlackouts: BlackoutPeriodItem[] = [
      {
        id: 'blk-revoked',
        hospitalId: 'h-1',
        branchId: null,
        branchName: null,
        doctorId: null,
        doctorName: null,
        startDate: '2026-09-01',
        endDate: '2026-09-02',
        reopenDate: '2026-09-03',
        reason: 'Cancelled shutdown',
        publicReason: 'Cancelled holiday',
        createdByUserId: 'usr-1',
        cancelledAt: new Date('2026-09-01T10:00:00Z'),
        cancelledByUserId: 'usr-1',
        createdAt: new Date('2026-08-25T10:00:00Z'),
      },
    ];

    const html = renderToStaticMarkup(
      <HolidaysAndBlackoutsManager
        doctors={dummyDoctors}
        branches={dummyBranches}
        initialBlackouts={mixedBlackouts}
      />,
    );

    expect(html).toContain('Revoked / Past Blackout History');
    expect(html).toContain('2026-09-01 to 2026-09-02');
    expect(html).toContain('Cancelled holiday');
  });
});
