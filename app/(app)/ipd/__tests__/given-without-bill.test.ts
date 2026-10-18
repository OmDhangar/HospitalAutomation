import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getGivenWithoutBillReport } from '@/lib/services/discharge-billing';

const mockExecute = vi.fn();

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      execute: mockExecute,
    };
    return fn(tx);
  }),
}));

describe('Given-Without-Bill Audit Report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries administered doses that lack a bill line and returns audit entries', async () => {
    mockExecute.mockResolvedValueOnce([
      {
        administration_id: 'admin-1',
        admission_id: 'adm-100',
        patient_name: 'Ramesh Gupta',
        patient_mrn: 'MRN-101',
        medicine_name: 'Inj Ceftriaxone 1g',
        dose_given: '1g',
        route_given: 'iv_push',
        actual_time: new Date('2026-10-14T10:00:00Z'),
        nurse_name: 'Staff Nurse Sunita',
        outbox_status: 'pending_pricing',
        last_error: 'No selling price configured for formulary medicine',
      },
      {
        administration_id: 'admin-2',
        admission_id: 'adm-100',
        patient_name: 'Ramesh Gupta',
        patient_mrn: 'MRN-101',
        medicine_name: 'Inj Pantoprazole 40mg',
        dose_given: '40mg',
        route_given: 'iv_push',
        actual_time: new Date('2026-10-14T11:00:00Z'),
        nurse_name: 'Staff Nurse Sunita',
        outbox_status: 'failed',
        last_error: 'Connection timeout after 5 attempts',
      },
    ]);

    const report = await getGivenWithoutBillReport({
      hospitalId: 'hosp-1',
      admissionId: 'adm-100',
    });

    expect(report).toHaveLength(2);
    expect(report[0].administrationId).toBe('admin-1');
    expect(report[0].patientName).toBe('Ramesh Gupta');
    expect(report[0].medicineName).toBe('Inj Ceftriaxone 1g');
    expect(report[0].outboxStatus).toBe('pending_pricing');
    expect(report[1].outboxStatus).toBe('failed');
  });

  it('returns empty array when all administered doses are properly billed', async () => {
    mockExecute.mockResolvedValueOnce([]);

    const report = await getGivenWithoutBillReport({
      hospitalId: 'hosp-1',
    });

    expect(report).toHaveLength(0);
  });
});
