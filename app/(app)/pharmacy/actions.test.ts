import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  completeSaleAction,
  getQueueAction,
  searchMedicinesAction,
  processReturnAction,
} from './actions';

// Mock session and auth
vi.mock('@/lib/auth/session', () => ({
  requireWritableSession: vi.fn(async () => ({
    hospitalId: 'hosp-1',
    userId: 'user-1',
    role: 'receptionist',
  })),
}));

// Mock services
vi.mock('@/lib/services/pharmacy', () => ({
  getPrescriptionFulfillmentQueue: vi.fn(async () => []),
  getAvailableBatchesForMedicine: vi.fn(async () => []),
  processPharmacySale: vi.fn(async (hospitalId, input) => ({
    saleId: 'sale-1',
    saleNo: 'PH-2026-00001',
    totalPaise: 10000,
    receipt: {} as any,
  })),
  processPharmacyReturn: vi.fn(async (hospitalId, input) => ({
    returnId: 'ret-1',
    returnNo: 'RET-2026-00001',
    refundAmountPaise: 5000,
  })),
}));

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn(async (hospitalId, cb) => {
    return cb({
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        { id: 'med-1', name: 'Paracetamol 650mg', sellingPricePaise: 2000, taxRateBp: 1200 },
      ]),
    });
  }),
}));

describe('Pharmacy Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthorized roles from dispensing', async () => {
    const { requireWritableSession } = await import('@/lib/auth/session');
    // Doctor cannot dispense / handle retail till
    vi.mocked(requireWritableSession).mockResolvedValueOnce({
      hospitalId: 'hosp-1',
      userId: 'doc-1',
      role: 'doctor',
    });

    const res = await completeSaleAction({
      saleType: 'counter',
      customerName: 'Aman',
      paymentMode: 'cash',
      items: [],
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Your login cannot do this');
  });

  it('allows receptionist / nurse / owner to complete a sale', async () => {
    const res = await completeSaleAction({
      saleType: 'counter',
      customerName: 'Aman Gupta',
      customerPhone: '+919876543210',
      paymentMode: 'cash',
      items: [
        {
          medicineId: 'med-1',
          batchId: 'batch-1',
          quantity: 2,
          unitPricePaise: 2000,
          mrpPaise: 2500,
        },
      ],
    });

    expect(res.success).toBe(true);
    expect(res.saleNo).toBe('PH-2026-00001');
  });

  it('fetches the prescription fulfillment queue', async () => {
    const res = await getQueueAction();
    expect(res.success).toBe(true);
    expect(Array.isArray(res.queue)).toBe(true);
  });
});
