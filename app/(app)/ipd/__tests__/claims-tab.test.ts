import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdmissionClaimsPage from '../admissions/[id]/(file)/claims/page';
import { claimActionHandler } from '@/app/(app)/ipd/claims/actions';

let mockSession = {
  hospitalId: 'hosp-1',
  branchId: 'branch-1',
  userId: 'user-desk',
  role: 'receptionist' as const,
  readOnly: false,
};

let mockAdmission: any = {
  id: 'adm-100',
  hospitalId: 'hosp-1',
  patientId: 'pat-1',
  encounterId: 'enc-1',
  patientName: 'Sunita Sharma',
  status: 'admitted',
};

let mockClaim: any = null;
let mockEvents: any[] = [];
let mockQueries: any[] = [];
let mockDocs: any[] = [];

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(() => Promise.resolve(mockSession)),
  requireWritableSession: vi.fn(() => Promise.resolve(mockSession)),
}));

vi.mock('@/lib/auth/modules', () => ({
  requireModule: vi.fn(() => Promise.resolve(new Map())),
  assertModule: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/modules/registry', () => ({
  moduleAllows: vi.fn(() => true),
}));

vi.mock('../admissions/[id]/(file)/data', () => ({
  loadAdmission: vi.fn(() => Promise.resolve(mockAdmission)),
}));

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => fn({})),
}));

vi.mock('@/lib/services/claims', () => ({
  getClaimCaseByAdmissionId: vi.fn(() => Promise.resolve(mockClaim)),
  listClaimEventsForCase: vi.fn(() => Promise.resolve(mockEvents)),
  listClaimQueriesForCase: vi.fn(() => Promise.resolve(mockQueries)),
  listClaimDocumentsForCase: vi.fn(() => Promise.resolve(mockDocs)),
  recordClaimQueryInTx: vi.fn().mockResolvedValue({ id: 'q-1' }),
  replyClaimQueryInTx: vi.fn().mockResolvedValue({ id: 'q-1', status: 'replied' }),
  transitionClaimStatusInTx: vi.fn().mockResolvedValue({ id: 'c-1' }),
  upsertClaimDocumentRecordInTx: vi.fn().mockResolvedValue({ id: 'doc-1' }),
}));

describe('Inpatient Admission Claims Tab & Custody Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = {
      hospitalId: 'hosp-1',
      branchId: 'branch-1',
      userId: 'user-desk',
      role: 'receptionist',
      readOnly: false,
    };
    mockAdmission = {
      id: 'adm-100',
      hospitalId: 'hosp-1',
      patientId: 'pat-1',
      encounterId: 'enc-1',
      patientName: 'Sunita Sharma',
      status: 'admitted',
    };
    mockClaim = null;
    mockEvents = [];
    mockQueries = [];
    mockDocs = [];
  });

  it('renders "No Insurance Claim Linked" banner when admission has no active claim case', async () => {
    mockClaim = null;
    const jsx = await AdmissionClaimsPage({ params: Promise.resolve({ id: 'adm-100' }) });
    expect(jsx).toBeDefined();
    // Verify it renders the empty banner
    expect(JSON.stringify(jsx)).toContain('No Insurance Claim Linked');
  });

  it('renders claim details and document checklist when claim exists', async () => {
    mockClaim = {
      id: 'claim-1',
      hospitalId: 'hosp-1',
      admissionId: 'adm-100',
      payerName: 'Star Health',
      claimType: 'cashless',
      status: 'preauth_approved',
      priority: 'standard',
      policyNumberBidx: 'bidx_1234567890abcdef',
      memberIdBidx: null,
      approvedAmountPaise: 5000000,
      settledAmountPaise: null,
      deductionAmountPaise: null,
      coPayAmountPaise: null,
      version: 1,
      createdAt: new Date('2026-10-21T10:00:00Z'),
      updatedAt: new Date('2026-10-21T10:00:00Z'),
    };
    mockEvents = [
      {
        id: 'ev-1',
        eventType: 'preauth_approved',
        previousStatus: 'preauth_submitted',
        newStatus: 'preauth_approved',
        amountPaise: 5000000,
        submissionChannel: 'portal',
        externalReference: 'REF-9988',
        notes: 'Approved for ₹50,000',
        createdAt: new Date('2026-10-21T11:00:00Z'),
      },
    ];
    mockDocs = [
      {
        id: 'd-1',
        docCategory: 'aadhaar_card',
        isPaperFiled: true,
        paperFiledAt: new Date('2026-10-21T10:15:00Z'),
        physicalBoxOrFileNo: 'BOX-A-12',
        notes: 'Original verified',
      },
    ];

    const jsx = await AdmissionClaimsPage({ params: Promise.resolve({ id: 'adm-100' }) });
    expect(jsx).toBeDefined();
    const str = JSON.stringify(jsx);
    expect(str).toContain('BOX-A-12');
    expect(str).toContain('aadhaar_card');
  });

  it('handles updateCustodyRecord server action safely and revalidates paths', async () => {
    const { upsertClaimDocumentRecordInTx } = await import('@/lib/services/claims');
    const { revalidatePath } = await import('next/cache');

    await claimActionHandler('updateCustodyRecord', {
      claimCaseId: 'claim-1',
      admissionId: 'adm-100',
      docCategory: 'aadhaar_card',
      isPaperFiled: true,
      physicalBoxOrFileNo: 'BOX-22',
      notes: 'Stored in record room',
    });

    expect(upsertClaimDocumentRecordInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        claimCaseId: 'claim-1',
        docCategory: 'aadhaar_card',
        isPaperFiled: true,
        physicalBoxOrFileNo: 'BOX-22',
      })
    );
    expect(revalidatePath).toHaveBeenCalledWith('/ipd/claims');
    expect(revalidatePath).toHaveBeenCalledWith('/ipd/admissions/adm-100/claims');
  });

  it('calls notFound if admission is not found', async () => {
    const { loadAdmission } = await import('../admissions/[id]/(file)/data');
    vi.mocked(loadAdmission).mockResolvedValueOnce(null as any);
    await expect(
      AdmissionClaimsPage({ params: Promise.resolve({ id: 'adm-100' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
