import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postBedDaysForAdmissionInTx } from '../bed-days';
import { postCareEntryLineInTx } from '../ipd-billing';

vi.mock('@/lib/services/tariffs', () => ({
  findEffectiveRatePlanForAdmissionInTx: vi.fn(),
  resolveChargeItemPriceForStayInTx: vi.fn(),
}));

vi.mock('@/lib/services/patient-billing', () => ({
  getOrCreateDraftBillInTx: vi.fn().mockResolvedValue({ id: 'bill-1', hospitalId: 'hosp-1' }),
}));

import {
  findEffectiveRatePlanForAdmissionInTx,
  resolveChargeItemPriceForStayInTx,
} from '../tariffs';

describe('Tariff-Aware Inpatient Billing Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('charges bed days using room tariff price override when rate plan has specific override', async () => {
    vi.mocked(findEffectiveRatePlanForAdmissionInTx).mockResolvedValue({
      id: 'plan-tpa',
      modifierBp: -1000,
    });
    vi.mocked(resolveChargeItemPriceForStayInTx).mockResolvedValue(350000); // 3500 INR overridden tariff

    let insertedValues: any = null;

    const txMock: any = {
      select: vi.fn().mockImplementation((fields?: any) => ({
        from: vi.fn().mockImplementation((tbl: any) => ({
          where: vi.fn().mockImplementation(() => ({
            for: vi.fn().mockResolvedValue([
              {
                id: 'adm-1',
                status: 'admitted',
                admittedAt: new Date('2026-11-01T10:00:00Z'),
                dischargedAt: null,
                encounterId: 'enc-1',
              },
            ]),
            then: (fn: any) => Promise.resolve([{ id: 'enc-1', hospitalId: 'hosp-1' }]).then(fn),
          })),
          innerJoin: vi.fn().mockImplementation(() => ({
            innerJoin: vi.fn().mockImplementation(() => ({
              leftJoin: vi.fn().mockImplementation(() => ({
                where: vi.fn().mockResolvedValue([
                  {
                    assignmentId: 'assign-1',
                    fromAt: new Date('2026-11-01T10:00:00Z'),
                    toAt: null,
                    bedLabel: '101',
                    wardName: 'General Ward',
                    chargeItemId: 'item-gen-bed',
                    chargeName: 'General Bed Charge',
                    pricePaise: 200000, // base 2000 INR
                    taxRateBp: 0,
                  },
                ]),
              })),
            })),
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: any) => {
          insertedValues = vals;
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'bill-item-1' }]),
            }),
          };
        }),
      })),
    };

    const added = await postBedDaysForAdmissionInTx(txMock, {
      admissionId: 'adm-1',
      timezone: 'Asia/Kolkata',
      now: new Date('2026-11-02T12:00:00Z'),
    });

    expect(added).toBe(2);
    expect(findEffectiveRatePlanForAdmissionInTx).toHaveBeenCalledWith(
      txMock,
      'hosp-1',
      'adm-1',
    );
    expect(resolveChargeItemPriceForStayInTx).toHaveBeenCalledWith(txMock, {
      hospitalId: 'hosp-1',
      chargeItemId: 'item-gen-bed',
      ratePlanId: 'plan-tpa',
    });
    // Check that bill item snapshotted the tariff rate (350000 paise) rather than base (200000 paise)
    expect(insertedValues.configuredUnitPricePaise).toBe(350000);
    expect(insertedValues.unitPricePaise).toBe(350000);
  });

  it('charges bedside procedure care entry using tariff rate resolution', async () => {
    vi.mocked(findEffectiveRatePlanForAdmissionInTx).mockResolvedValue({
      id: 'plan-corp',
      modifierBp: 1000,
    });
    vi.mocked(resolveChargeItemPriceForStayInTx).mockResolvedValue(55000); // 550 INR (+10% corporate modifier)

    let insertedValues: any = null;

    const txMock: any = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation((tbl: any) => ({
          where: vi.fn().mockImplementation(() => {
            // Check if querying chargeItems or encounters or admissions
            return Promise.resolve([
              {
                kind: 'procedure',
                sellingPricePaise: 50000,
                taxRateBp: 0,
                id: 'adm-1',
                hospitalId: 'hosp-1',
              },
            ]);
          }),
        })),
      })),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: any) => {
          insertedValues = vals;
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'bill-item-2' }]),
            }),
          };
        }),
      })),
    };

    const posted = await postCareEntryLineInTx(txMock, {
      entry: {
        id: 'entry-1',
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        encounterId: 'enc-1',
        chargeItemId: 'item-dressing',
        medicineId: null,
        description: 'Wound Dressing',
        quantity: 1,
        occurredAt: new Date(),
        enteredByUserId: 'nurse-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        voidedAt: null,
        voidedByUserId: null,
        voidReason: null,
      } as any,
      actorUserId: 'nurse-1',
    });

    expect(posted).toBe(true);
    expect(resolveChargeItemPriceForStayInTx).toHaveBeenCalledWith(txMock, {
      hospitalId: 'hosp-1',
      chargeItemId: 'item-dressing',
      ratePlanId: 'plan-corp',
    });
    expect(insertedValues.configuredUnitPricePaise).toBe(55000);
    expect(insertedValues.unitPricePaise).toBe(55000);
  });

  it('bypasses tariff resolution for bedside medicine care entries and charges medicine price', async () => {
    let insertedValues: any = null;

    const txMock: any = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => {
            return Promise.resolve([
              {
                price: 15000, // 150 INR medicine
                tax: 500,
                id: 'adm-1',
                hospitalId: 'hosp-1',
              },
            ]);
          }),
        })),
      })),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: any) => {
          insertedValues = vals;
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'bill-item-3' }]),
            }),
          };
        }),
      })),
    };

    const posted = await postCareEntryLineInTx(txMock, {
      entry: {
        id: 'entry-2',
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        encounterId: 'enc-1',
        chargeItemId: null,
        medicineId: 'med-paracetamol',
        description: 'Paracetamol IV 100ml',
        quantity: 1,
        occurredAt: new Date(),
        enteredByUserId: 'nurse-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        voidedAt: null,
        voidedByUserId: null,
        voidReason: null,
      } as any,
      actorUserId: 'nurse-1',
    });

    expect(posted).toBe(true);
    // Tariff resolution should NOT be called for medicines
    expect(resolveChargeItemPriceForStayInTx).not.toHaveBeenCalled();
    expect(insertedValues.configuredUnitPricePaise).toBe(15000);
    expect(insertedValues.unitPricePaise).toBe(15000);
  });
});
