import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { SettingsClientView } from '../settings-client-view';

// Mock Next.js navigation hooks
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('SettingsClientView Component', () => {
  const mockSession = {
    hospitalId: 'hosp-1',
    hospitalName: 'Apollo Care Hospital',
    timezone: 'Asia/Kolkata',
    role: 'owner',
    userId: 'user-admin-1',
  };

  const mockBranches = [
    { id: 'branch-1', name: 'Main Hospital Building', address: 'Station Road' },
    { id: 'branch-2', name: 'North City OPD Wing', address: 'Market Square' },
  ];

  const mockDoctors = [
    {
      id: 'doc-1',
      name: 'Dr. Anjali Deshmukh',
      specialty: 'Cardiology',
      branchId: 'branch-1',
      branchName: 'Main Hospital Building',
      userId: 'user-doc-1',
      defaultConsultMinutes: 15,
      mode: 'both' as const,
      active: true,
      dailyTokenQuota: 40,
      walkInReserved: 10,
      onlineOpensMinutesBefore: 120,
      walkInReleaseMinutes: 0,
    },
    {
      id: 'doc-2',
      name: 'Dr. Rahul Sharma',
      specialty: 'Paediatrics',
      branchId: 'branch-2',
      branchName: 'North City OPD Wing',
      userId: null,
      defaultConsultMinutes: 10,
      mode: 'slot' as const,
      active: true,
      dailyTokenQuota: null,
      walkInReserved: 5,
      onlineOpensMinutesBefore: 60,
      walkInReleaseMinutes: null,
    },
  ];

  const mockStaff = [
    {
      id: 'staff-1',
      name: 'Priya Kulkarni',
      email: 'priya@hospital.com',
      role: 'receptionist' as const,
      branchId: 'branch-1',
      branchName: 'Main Hospital Building',
      active: true,
      userId: 'user-rec-1',
    },
    {
      id: 'staff-2',
      name: 'Nurse Sneha Patil',
      email: 'sneha@hospital.com',
      role: 'nurse' as const,
      branchId: 'branch-1',
      branchName: 'Main Hospital Building',
      active: true,
      userId: 'user-nurse-1',
    },
  ];

  const mockFees: Record<string, number> = {
    'doc-1': 50000,
  };

  it('renders the 4 primary tabs in the navigation bar', () => {
    const html = renderToString(
      <SettingsClientView
        session={mockSession}
        branches={mockBranches}
        doctors={mockDoctors}
        staff={mockStaff}
        fees={mockFees}
        limitHit={null}
        today="2026-10-18"
        searchParams={{}}
      />,
    );

    expect(html).toContain('System &amp; Modules');
    expect(html).toContain('Clinic &amp; Doctors');
    expect(html).toContain('Staff &amp; RBAC');
    expect(html).toContain('Scheduling Rules');
  });

  it('renders Tab 1 Bento Grid with WhatsApp featured and 6 standard modules by default', () => {
    const html = renderToString(
      <SettingsClientView
        session={mockSession}
        branches={mockBranches}
        doctors={mockDoctors}
        staff={mockStaff}
        fees={mockFees}
        limitHit={null}
        today="2026-10-18"
        searchParams={{ tab: 'system' }}
      />,
    );

    // Featured WhatsApp Card
    expect(html).toContain('WhatsApp Patient Communications');
    expect(html).toContain('Configure WhatsApp Integration');
    expect(html).toContain('/settings/whatsapp');

    // 6 Standard Bento Cards
    expect(html).toContain('Medicines Catalogue');
    expect(html).toContain('/settings/medicines');
    expect(html).toContain('IPD Wards, Beds &amp; Rates');
    expect(html).toContain('/settings/ipd');
    expect(html).toContain('Letterhead &amp; IPD Numbers');
    expect(html).toContain('/settings/letterhead');
    expect(html).toContain('Risk-Class Stock &amp; Stores');
    expect(html).toContain('/settings/stock');
    expect(html).toContain('Staff Access &amp; Device Lock');
    expect(html).toContain('/settings/staff-access');
    expect(html).toContain('Hospital Modules &amp; Features');
    expect(html).toContain('/settings/modules');
  });

  it('renders Tab 2 with horizontal branch cards, doctor summary rows and walk-in reservation policy', () => {
    const html = renderToString(
      <SettingsClientView
        session={mockSession}
        branches={mockBranches}
        doctors={mockDoctors}
        staff={mockStaff}
        fees={mockFees}
        limitHit={null}
        today="2026-10-18"
        searchParams={{ tab: 'doctors' }}
      />,
    );

    // Branches section
    expect(html).toContain('Hospital Branches');
    expect(html).toContain('Main Hospital Building');
    expect(html).toContain('North City OPD Wing');
    expect(html).toContain('Add Branch');

    // Doctors section
    expect(html).toContain('Doctor Directory &amp; Capacities');
    expect(html).toContain('Walk-in &amp; Quota Policy:');
    expect(html).toContain('Dr. Anjali Deshmukh');
    expect(html).toContain('Cardiology');
    expect(html).toContain('₹500');
    expect(html).toContain('Add Doctor');
  });

  it('renders Tab 3 with Staff Directory table, role badges, and Add Staff trigger', () => {
    const html = renderToString(
      <SettingsClientView
        session={mockSession}
        branches={mockBranches}
        doctors={mockDoctors}
        staff={mockStaff}
        fees={mockFees}
        limitHit={null}
        today="2026-10-18"
        searchParams={{ tab: 'staff' }}
      />,
    );

    expect(html).toContain('Hospital Staff Directory');
    expect(html).toContain('Add Staff Member');
    expect(html).toContain('Priya Kulkarni');
    expect(html).toContain('priya@hospital.com');
    expect(html).toContain('receptionist');
    expect(html).toContain('Nurse Sneha Patil');
    expect(html).toContain('nurse');
    expect(html).toContain('Deactivate');
  });

  it('auto-activates relevant tab when redirected with action results', () => {
    // When redirected with fee saved, it should activate doctors tab
    const feeSavedHtml = renderToString(
      <SettingsClientView
        session={mockSession}
        branches={mockBranches}
        doctors={mockDoctors}
        staff={mockStaff}
        fees={mockFees}
        limitHit={null}
        today="2026-10-18"
        searchParams={{ saved: 'fee', id: 'doc-1' }}
      />,
    );
    expect(feeSavedHtml).toContain('Consultation fee saved');
    expect(feeSavedHtml).toContain('Doctor Directory &amp; Capacities');

    // When redirected with role error, it should activate staff tab
    const roleErrorHtml = renderToString(
      <SettingsClientView
        session={mockSession}
        branches={mockBranches}
        doctors={mockDoctors}
        staff={mockStaff}
        fees={mockFees}
        limitHit={null}
        today="2026-10-18"
        searchParams={{ error: 'role' }}
      />,
    );
    expect(roleErrorHtml).toContain('Choose a role for the new staff member');
    expect(roleErrorHtml).toContain('Hospital Staff Directory');
  });
});
