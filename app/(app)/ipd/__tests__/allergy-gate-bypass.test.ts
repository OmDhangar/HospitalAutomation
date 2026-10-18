import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  signRoundOrders,
  AllergyAssessmentRequiredError,
  AllergyConflictError,
} from '@/lib/services/ipd-medication-orders';

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockWhere = vi.fn();

let mockAllergyStatus = 'unreviewed';
let mockAllergens: Array<{ substance: string }> = [];

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      insert: () => ({
        values: (val: any) => {
          mockInsert(val);
          return {
            returning: () => Promise.resolve([{ id: 'order-101' }]),
          };
        },
      }),
      update: () => ({
        set: (...args: any[]) => {
          mockUpdate(...args);
          return {
            where: () => Promise.resolve([{ id: 'order-101' }]),
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => {
            const rows = [
              {
                id: 'adm-1',
                encounterId: 'enc-1',
                patientId: 'pat-1',
                status: mockAllergyStatus,
                allergens: mockAllergens,
                isCurrent: true,
              },
            ];
            const p = Promise.resolve(rows);
            return Object.assign(p, {
              for: () => Promise.resolve(rows),
              orderBy: () => Promise.resolve(rows),
              limit: () => Promise.resolve(rows),
            });
          },
        }),
      }),
      execute: vi.fn().mockResolvedValue([]),
    };
    return fn(tx);
  }),
}));

vi.mock('@/lib/services/ipd-rounding-cockpit', () => ({
  getLatestAllergyAssessmentInTx: vi.fn(async () => ({
    status: mockAllergyStatus,
    allergens: mockAllergens,
  })),
}));

describe('Server-Side Allergy Gate & Direct API Bypass Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAllergyStatus = 'unreviewed';
    mockAllergens = [];
  });

  it('strictly blocks signRoundOrders if allergy status is unreviewed', async () => {
    mockAllergyStatus = 'unreviewed';

    await expect(
      signRoundOrders({
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        doctorId: 'doc-1',
        authorUserId: 'user-doc-1',
        resolutions: [
          {
            type: 'new',
            order: {
              medicineId: 'med-1',
              medicineName: 'Amoxicillin 500mg',
              doseAmount: '500',
              doseUnit: 'mg',
              route: 'oral',
              scheduleType: 'scheduled',
              frequencyCode: 'TDS',
              scheduleTimes: ['08:00', '14:00', '20:00'],
              startsAt: new Date(),
              endsAt: new Date(Date.now() + 86400000 * 3),
              durationDays: 3,
            },
          },
        ],
      }),
    ).rejects.toThrow(AllergyAssessmentRequiredError);
  });

  it('strictly blocks prescribing an allergen without explicit override reason', async () => {
    mockAllergyStatus = 'allergies_documented';
    mockAllergens = [{ substance: 'Penicillin' }];

    await expect(
      signRoundOrders({
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        doctorId: 'doc-1',
        authorUserId: 'user-doc-1',
        resolutions: [
          {
            type: 'new',
            order: {
              medicineId: 'med-1',
              medicineName: 'Amoxicillin 500mg',
              genericName: 'Amoxicillin Trihydrate (Penicillin class)',
              doseAmount: '500',
              doseUnit: 'mg',
              route: 'oral',
              scheduleType: 'scheduled',
              frequencyCode: 'TDS',
              scheduleTimes: ['08:00', '14:00', '20:00'],
              startsAt: new Date(),
              endsAt: new Date(Date.now() + 86400000 * 3),
              durationDays: 3,
            },
          },
        ],
      }),
    ).rejects.toThrow(AllergyConflictError);
  });

  it('allows prescribing allergen when valid clinical override reason is provided and logs audit', async () => {
    mockAllergyStatus = 'allergies_documented';
    mockAllergens = [{ substance: 'Penicillin' }];

    const res = await signRoundOrders({
      hospitalId: 'hosp-1',
      admissionId: 'adm-1',
      doctorId: 'doc-1',
      authorUserId: 'user-doc-1',
      allergyOverrideReason: 'Desensitization protocol completed under ICU supervision; benefits outweigh risk',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: 'med-1',
            medicineName: 'Amoxicillin 500mg',
            genericName: 'Amoxicillin',
            doseAmount: '500',
            doseUnit: 'mg',
            route: 'oral',
            scheduleType: 'scheduled',
            frequencyCode: 'TDS',
            scheduleTimes: ['08:00', '14:00', '20:00'],
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 86400000 * 3),
            durationDays: 3,
          },
        },
      ],
    });

    expect(res.signedOrderIds).toHaveLength(1);
    expect(mockInsert).toHaveBeenCalled();
  });
});
