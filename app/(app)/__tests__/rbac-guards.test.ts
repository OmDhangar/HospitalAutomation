import { describe, expect, it, vi, beforeEach } from 'vitest';
import { notFound, redirect } from 'next/navigation';
import type { StaffRole } from '@/lib/domain/permissions';

let mockSession = {
  hospitalId: 'hosp-1',
  branchId: 'branch-1',
  userId: 'user-1',
  role: 'nurse' as StaffRole,
  timezone: 'Asia/Kolkata',
  mustChangePassword: false,
};

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(() => Promise.resolve(mockSession)),
  requireWritableSession: vi.fn(() => Promise.resolve(mockSession)),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`);
    (err as any).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw err;
  }),
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND');
    (err as any).digest = 'NEXT_NOT_FOUND';
    throw err;
  }),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    };
    return fn(tx);
  }),
}));

vi.mock('@/lib/services/hospital', () => ({
  getHospital: vi.fn().mockResolvedValue({ planTierCode: 'standard' }),
}));

vi.mock('@/lib/services/auth', () => ({
  listBranches: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/services/reports', () => ({
  getMonthlyUsage: vi.fn().mockResolvedValue({
    visits: 0,
    appointments: 0,
    completedAppointments: 0,
    activeDoctors: 0,
    billableVisits: 0,
  }),
  getDoctorDayStats: vi.fn().mockResolvedValue([]),
  getDailyTrend: vi.fn().mockResolvedValue([]),
  getHourlyLoad: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/services/discharge-billing', () => ({
  getDischargeBillView: vi.fn().mockResolvedValue({
    lines: [],
    payments: [],
    totals: { grossRupees: 0, discountRupees: 0, advanceRupees: 0, netRupees: 0, balanceRupees: 0 },
  }),
  getBillForPrint: vi.fn().mockResolvedValue({
    admission: {
      id: 'adm-101',
      doctorName: 'Dr. Test',
      admittedAt: new Date(),
      bed: { wardName: 'Ward A', label: '1' },
    },
    hospital: { branchName: 'Main Branch' },
    patient: { id: 'pat-1', name: 'Test Patient', uhid: 'UHID-1' },
    bill: { id: 'bill-1', status: 'final' },
    lines: [],
    payments: [],
    totals: { totalPaise: 0 },
  }),
}));

vi.mock('@/lib/services/ipd-summary', () => ({
  getDoctorSummaryCockpitData: vi.fn().mockResolvedValue({
    admission: {},
    medications: [],
    vitals: {},
    fluidBalance: {
      totalIntakeMl: 0,
      totalOutputMl: 0,
      balanceMl: 0,
      breakdown: { oralMl: 0, ivMl: 0, urineMl: 0, drainMl: 0 },
    },
    attentionItems: [],
  }),
}));

vi.mock('@/lib/services/doctor-ipd', () => ({
  getTestChips: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/services/ipd-census', () => ({
  getAdmissionSummary: vi.fn().mockResolvedValue({ id: 'adm-101' }),
}));

vi.mock('@/lib/services/ipd-medication-orders', () => ({
  listActiveOrders: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/services/ipd-discharge-summary', () => ({
  getLatestDischargeSummary: vi.fn().mockResolvedValue(null),
  listHomeMedications: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/services/letterhead', () => ({
  getLetterheadSettings: vi.fn().mockResolvedValue({
    doctors: [
      {
        name: 'Dr. Test',
        qualification: 'MBBS, MD',
        registrationNo: '12345',
      },
    ],
  }),
}));

vi.mock('@/lib/services/medical-report', () => ({
  getMedicalReportForPrint: vi.fn().mockResolvedValue(null),
}));

// Import page components
import ReportsPage from '@/app/(app)/reports/page';
import PatientBillingPage from '@/app/(app)/ipd/patients/[id]/billing/page';
import SummaryPage from '@/app/(app)/ipd/patients/[id]/summary/page';
import OrdersPage from '@/app/(app)/ipd/patients/[id]/orders/page';
import DischargePage from '@/app/(app)/ipd/patients/[id]/discharge/page';
import IpdBillPrintPage from '@/app/print/ipd-bill/[billId]/page';
import {
  recordVitalReadingAction,
  recordClinicalNoteAction,
  reconcileHomeMedicationAction,
} from '@/app/(app)/ipd/actions';

describe('Universal RBAC Route and Action Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('/reports page guard', () => {
    it('redirects nurse to /ipd/ward', async () => {
      mockSession.role = 'nurse';
      await expect(ReportsPage()).rejects.toThrow('NEXT_REDIRECT:/ipd/ward');
      expect(redirect).toHaveBeenCalledWith('/ipd/ward');
    });

    it('redirects doctor to /dashboard', async () => {
      mockSession.role = 'doctor';
      await expect(ReportsPage()).rejects.toThrow('NEXT_REDIRECT:/dashboard');
      expect(redirect).toHaveBeenCalledWith('/dashboard');
    });

    it('allows owner without redirect', async () => {
      mockSession.role = 'owner';
      await expect(ReportsPage()).resolves.toBeDefined();
      expect(redirect).not.toHaveBeenCalled();
    });
  });

  describe('/ipd/patients/[id]/billing page guard', () => {
    it('redirects nurse away from financial billing', async () => {
      mockSession.role = 'nurse';
      await expect(
        PatientBillingPage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).rejects.toThrow('NEXT_REDIRECT:/ipd/ward');
      expect(redirect).toHaveBeenCalledWith('/ipd/ward');
    });

    it('redirects doctor without billing permissions', async () => {
      mockSession.role = 'doctor';
      await expect(
        PatientBillingPage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).rejects.toThrow('NEXT_REDIRECT:/dashboard');
      expect(redirect).toHaveBeenCalledWith('/dashboard');
    });

    it('allows receptionist to access billing', async () => {
      mockSession.role = 'receptionist';
      await expect(
        PatientBillingPage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).resolves.toBeDefined();
      expect(redirect).not.toHaveBeenCalled();
    });
  });

  describe('/ipd/patients/[id]/summary page guard', () => {
    it('redirects nurse to /ipd/patients/[id]/emar', async () => {
      mockSession.role = 'nurse';
      await expect(
        SummaryPage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).rejects.toThrow('NEXT_REDIRECT:/ipd/patients/adm-101/emar');
      expect(redirect).toHaveBeenCalledWith('/ipd/patients/adm-101/emar');
    });

    it('redirects receptionist to home path', async () => {
      mockSession.role = 'receptionist';
      await expect(
        SummaryPage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).rejects.toThrow('NEXT_REDIRECT:/dashboard');
      expect(redirect).toHaveBeenCalledWith('/dashboard');
    });

    it('allows doctor to access summary cockpit', async () => {
      mockSession.role = 'doctor';
      await expect(
        SummaryPage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).resolves.toBeDefined();
      expect(redirect).not.toHaveBeenCalled();
    });
  });

  describe('/ipd/patients/[id]/orders page guard', () => {
    it('redirects nurse to /ipd/patients/[id]/emar', async () => {
      mockSession.role = 'nurse';
      await expect(
        OrdersPage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).rejects.toThrow('NEXT_REDIRECT:/ipd/patients/adm-101/emar');
      expect(redirect).toHaveBeenCalledWith('/ipd/patients/adm-101/emar');
    });

    it('allows doctor to access orders', async () => {
      mockSession.role = 'doctor';
      await expect(
        OrdersPage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).resolves.toBeDefined();
      expect(redirect).not.toHaveBeenCalled();
    });
  });

  describe('/ipd/patients/[id]/discharge page guard', () => {
    it('redirects nurse to /ipd/patients/[id]/emar', async () => {
      mockSession.role = 'nurse';
      await expect(
        DischargePage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).rejects.toThrow('NEXT_REDIRECT:/ipd/patients/adm-101/emar');
      expect(redirect).toHaveBeenCalledWith('/ipd/patients/adm-101/emar');
    });

    it('allows doctor to access discharge tab', async () => {
      mockSession.role = 'doctor';
      await expect(
        DischargePage({ params: Promise.resolve({ id: 'adm-101' }) }),
      ).resolves.toBeDefined();
      expect(redirect).not.toHaveBeenCalled();
    });
  });

  describe('/print/ipd-bill/[billId] print page guard', () => {
    it('triggers notFound() when accessed by a nurse', async () => {
      mockSession.role = 'nurse';
      await expect(
        IpdBillPrintPage({
          params: Promise.resolve({ billId: 'bill-1' }),
          searchParams: Promise.resolve({}),
        }),
      ).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled();
    });

    it('allows receptionist to print IPD bill', async () => {
      mockSession.role = 'receptionist';
      await expect(
        IpdBillPrintPage({
          params: Promise.resolve({ billId: 'bill-1' }),
          searchParams: Promise.resolve({}),
        }),
      ).resolves.toBeDefined();
      expect(notFound).not.toHaveBeenCalled();
    });

    it('allows owner to print IPD bill', async () => {
      mockSession.role = 'owner';
      await expect(
        IpdBillPrintPage({
          params: Promise.resolve({ billId: 'bill-1' }),
          searchParams: Promise.resolve({}),
        }),
      ).resolves.toBeDefined();
      expect(notFound).not.toHaveBeenCalled();
    });
  });

  describe('Server Actions RBAC checks in ipd/actions.ts', () => {
    it('blocks receptionist from recording bedside vitals (requires ipd.chart)', async () => {
      mockSession.role = 'receptionist';
      await expect(
        recordVitalReadingAction({
          admissionId: 'adm-101',
          temperatureF: 98.6,
        }),
      ).rejects.toThrow('You cannot do this from your login');
    });

    it('blocks receptionist from recording SOAP notes (requires clinical.write)', async () => {
      mockSession.role = 'receptionist';
      await expect(
        recordClinicalNoteAction({
          admissionId: 'adm-101',
          noteType: 'SOAP',
          body: 'Attending physician notes',
        }),
      ).rejects.toThrow('You cannot do this from your login');
    });

    it('blocks receptionist from recording nursing notes (requires ipd.chart)', async () => {
      mockSession.role = 'receptionist';
      await expect(
        recordClinicalNoteAction({
          admissionId: 'adm-101',
          noteType: 'NURSING',
          body: 'Shift nursing notes',
        }),
      ).rejects.toThrow('You cannot do this from your login');
    });

    it('blocks nurse from recording doctor SOAP notes (requires clinical.write)', async () => {
      mockSession.role = 'nurse';
      await expect(
        recordClinicalNoteAction({
          admissionId: 'adm-101',
          noteType: 'SOAP',
          body: 'Physician assessment',
        }),
      ).rejects.toThrow('You cannot do this from your login');
    });

    it('blocks nurse from reconciling home medications (requires ipd.prescribe)', async () => {
      mockSession.role = 'nurse';
      await expect(
        reconcileHomeMedicationAction({
          admissionId: 'adm-101',
          medicineName: 'Amlodipine 5mg',
          reconciliationStatus: 'continued',
        }),
      ).rejects.toThrow('You cannot do this from your login');
    });
  });
});

