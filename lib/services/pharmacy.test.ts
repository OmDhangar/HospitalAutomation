import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processPharmacySale,
  type ProcessSaleInput,
} from './pharmacy';

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn(async (hospitalId, callback) => {
    const defaultRows = [{ id: 'loc-1', count: 0, name: 'Paracetamol 650mg', batchNo: 'B-001', expiryDate: '2027-12-31' }];

    const makeChain = () => {
      const obj: any = {
        from: vi.fn(() => obj),
        where: vi.fn(() => obj),
        orderBy: vi.fn(() => obj),
        limit: vi.fn(() => obj),
        returning: vi.fn(() => obj),
        leftJoin: vi.fn(() => obj),
        innerJoin: vi.fn(() => obj),
        set: vi.fn(() => obj),
        values: vi.fn(() => obj),
        then: (resolve: any) => Promise.resolve(defaultRows).then(resolve),
      };
      return obj;
    };

    const tx = {
      select: vi.fn(() => makeChain()),
      insert: vi.fn(() => makeChain()),
      update: vi.fn(() => makeChain()),
    };
    return callback(tx);
  }),
}));

vi.mock('@/lib/services/entitlements', () => ({
  getEntitlements: vi.fn(async () => ({
    maxBranches: null,
    maxDoctors: null,
    maxStaffLogins: null,
    hasDisplayBoard: true,
    hasOwnerReport: true,
    hasAdvancedReports: true,
    hasDataExport: true,
    hasAuditLog: true,
    hasInhousePharmacy: true,
    supportTier: 'email',
  })),
}));

describe('Pharmacy Service Layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects sale when hospital lacks in-house pharmacy entitlement', async () => {
    const { getEntitlements } = await import('@/lib/services/entitlements');
    vi.mocked(getEntitlements).mockResolvedValueOnce({
      maxBranches: null,
      maxDoctors: null,
      maxStaffLogins: null,
      hasDisplayBoard: true,
      hasOwnerReport: true,
      hasAdvancedReports: false,
      hasDataExport: false,
      hasAuditLog: false,
      hasInhousePharmacy: false,
      supportTier: 'email',
    });

    const input: ProcessSaleInput = {
      saleType: 'counter',
      customerName: 'Suresh Patel',
      paymentMode: 'cash',
      items: [],
      dispensedByUserId: 'user-1',
    };

    await expect(processPharmacySale('hosp-1', input)).rejects.toThrow(
      /In-house retail pharmacy module is not enabled for this hospital/
    );
  });

  it('processes sale and returns sequential sale number and receipt', async () => {
    const input: ProcessSaleInput = {
      saleType: 'counter',
      customerName: 'Suresh Patel',
      paymentMode: 'cash',
      items: [
        {
          medicineId: 'med-1',
          batchId: 'batch-1',
          batchNo: 'B-001',
          expiryDate: '2027-12-31',
          quantity: 2,
          unitPricePaise: 5000,
          mrpPaise: 6000,
          discountPercent: 0,
          gstRate: 12,
        },
      ],
      dispensedByUserId: 'user-1',
    };

    const result = await processPharmacySale('hosp-1', input);
    expect(result.saleNo).toContain('PH-');
    expect(result.totalPaise).toBe(11200); // 10000 + 600 CGST + 600 SGST
    expect(result.receipt.title).toBe('RETAIL PHARMACY CASH MEMO');
  });
});
