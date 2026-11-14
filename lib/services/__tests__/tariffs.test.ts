import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveRatePlanInTx,
  listRatePlansInTx,
  setChargeItemTariffInTx,
  findEffectiveRatePlanForAdmissionInTx,
  resolveChargeItemPriceForStayInTx,
} from '../tariffs';

describe('Tariff Service', () => {
  it('saves rate plan and ensures only one default rate plan exists', async () => {
    let plans: any[] = [
      { id: 'plan-1', hospitalId: 'hosp-1', name: 'Standard Cash', code: 'CASH', isDefault: true, active: true },
    ];

    const txMock: any = {
      update: vi.fn().mockImplementation((table: any) => ({
        set: vi.fn().mockImplementation((vals: any) => ({
          where: vi.fn().mockImplementation(() => {
            plans.forEach((p) => {
              if (vals.isDefault !== undefined) p.isDefault = vals.isDefault;
            });
            return Promise.resolve();
          }),
        })),
      })),
      insert: vi.fn().mockImplementation((table: any) => ({
        values: vi.fn().mockImplementation((vals: any) => ({
          returning: vi.fn().mockImplementation(() => {
            const row = { id: 'plan-2', ...vals, createdAt: new Date() };
            plans.push(row);
            return Promise.resolve([row]);
          }),
        })),
      })),
    };

    const newPlan = await saveRatePlanInTx(
      txMock,
      'hosp-1',
      {
        name: 'Star Health TPA',
        code: 'STAR-TPA',
        payerKind: 'tpa',
        payerName: 'Star Health',
        modifierBp: -1000,
        isDefault: true,
      },
      'user-1',
    );

    expect(newPlan.id).toBe('plan-2');
    expect(newPlan.isDefault).toBe(true);
    // Old plan should have been unset from default
    expect(plans.find((p) => p.id === 'plan-1')?.isDefault).toBe(false);
  });

  it('upserts a charge item tariff override', async () => {
    let tariffs: any[] = [];
    const txMock: any = {
      insert: vi.fn().mockImplementation((table: any) => ({
        values: vi.fn().mockImplementation((vals: any) => ({
          onConflictDoUpdate: vi.fn().mockImplementation((conflictConfig: any) => ({
            returning: vi.fn().mockImplementation(() => {
              const row = { id: 'tariff-1', ...vals };
              tariffs.push(row);
              return Promise.resolve([row]);
            }),
          })),
        })),
      })),
    };

    const tariff = await setChargeItemTariffInTx(
      txMock,
      'hosp-1',
      {
        ratePlanId: 'plan-star',
        chargeItemId: 'item-icu',
        tariffPricePaise: 450000,
      },
      'user-1',
    );

    expect(tariff.tariffPricePaise).toBe(450000);
    expect(tariffs.length).toBe(1);
  });

  it('resolves item price using explicit override when present', async () => {
    const txMock: any = {
      select: vi.fn().mockImplementation((fields?: any) => ({
        from: vi.fn().mockImplementation((table: any) => ({
          where: vi.fn().mockImplementation(() => {
            // First query checks tariff override in chargeItemTariffs
            // Second query checks base price in chargeItems
            return {
              limit: vi.fn().mockImplementation((n: number) => {
                return Promise.resolve([{ tariffPricePaise: 400000 }]);
              }),
              then: (fn: any) => Promise.resolve([{ tariffPricePaise: 400000 }]).then(fn),
            };
          }),
        })),
      })),
    };

    const price = await resolveChargeItemPriceForStayInTx(txMock, {
      hospitalId: 'hosp-1',
      chargeItemId: 'item-deluxe-room',
      ratePlanId: 'plan-tpa',
    });

    expect(price).toBe(400000);
  });

  it('resolves item price using rate plan modifier when no explicit override exists', async () => {
    let callCount = 0;
    const txMock: any = {
      select: vi.fn().mockImplementation((fields?: any) => ({
        from: vi.fn().mockImplementation((table: any) => ({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              // No override in chargeItemTariffs
              return Promise.resolve([]);
            }
            if (callCount === 2) {
              // Rate plan with +10% modifier
              return Promise.resolve([{ modifierBp: 1000 }]);
            }
            // Base item sellingPricePaise = 50000 (Rs 500)
            return Promise.resolve([{ sellingPricePaise: 50000 }]);
          }),
        })),
      })),
    };

    const price = await resolveChargeItemPriceForStayInTx(txMock, {
      hospitalId: 'hosp-1',
      chargeItemId: 'item-dressing',
      ratePlanId: 'plan-corporate',
    });

    // 50000 * 1.1 = 55000
    expect(price).toBe(55000);
  });
});
