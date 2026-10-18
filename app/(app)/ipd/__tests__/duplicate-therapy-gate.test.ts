import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  signRoundOrders,
  DuplicateTherapyError,
} from '@/lib/services/ipd-medication-orders';

const mockInsert = vi.fn();
const mockUpdate = vi.fn();

let mockActiveOrders: Array<{ id: string; medicineId: string; medicineName: string; genericName?: string }> = [];

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      insert: () => ({
        values: (val: any) => {
          mockInsert(val);
          return {
            returning: () => Promise.resolve([{ id: 'order-202' }]),
          };
        },
      }),
      update: () => ({
        set: (...args: any[]) => {
          mockUpdate(...args);
          return {
            where: () => Promise.resolve([{ id: 'order-202' }]),
          };
        },
      }),
      select: () => ({
        from: (table: any) => ({
          where: () => {
            const rows = [
              {
                admissionId: 'adm-1',
                encounterId: 'enc-1',
                patientId: 'pat-1',
                status: 'nkda',
                allergens: [],
                isCurrent: true,
                ...mockActiveOrders[0],
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
    status: 'nkda',
    allergens: [],
  })),
  getActiveOrdersInTx: vi.fn(async () => mockActiveOrders),
}));

describe('Server-Side Duplicate Active Therapy Gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveOrders = [];
  });

  it('rejects prescribing duplicate active medication without override reason', async () => {
    mockActiveOrders = [
      {
        id: 'ord-existing-1',
        medicineId: 'med-panto',
        medicineName: 'Inj Pantoprazole 40mg',
        genericName: 'Pantoprazole',
      },
    ];

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
              medicineId: 'med-panto',
              medicineName: 'Tab Pantoprazole 40mg',
              genericName: 'Pantoprazole',
              doseAmount: '40',
              doseUnit: 'mg',
              route: 'oral',
              scheduleType: 'scheduled',
              frequencyCode: 'OD',
              scheduleTimes: ['08:00'],
              startsAt: new Date(),
              endsAt: new Date(Date.now() + 86400000 * 3),
              durationDays: 3,
            },
          },
        ],
      }),
    ).rejects.toThrow(DuplicateTherapyError);
  });

  it('allows duplicate therapy when explicit clinical override reason is supplied', async () => {
    mockActiveOrders = [
      {
        id: 'ord-existing-1',
        medicineId: 'med-panto',
        medicineName: 'Inj Pantoprazole 40mg',
        genericName: 'Pantoprazole',
      },
    ];

    const res = await signRoundOrders({
      hospitalId: 'hosp-1',
      admissionId: 'adm-1',
      doctorId: 'doc-1',
      authorUserId: 'user-doc-1',
      duplicateOverrideReason: 'Step-down transition: overlapping oral test dose prior to IV discontinuation',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: 'med-panto',
            medicineName: 'Tab Pantoprazole 40mg',
            genericName: 'Pantoprazole',
            doseAmount: '40',
            doseUnit: 'mg',
            route: 'oral',
            scheduleType: 'scheduled',
            frequencyCode: 'OD',
            scheduleTimes: ['08:00'],
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
