import { describe, it, expect } from 'vitest';
import { ipdDischargeClearances } from '@/lib/db/schema';

describe('ipdDischargeClearances schema', () => {
  it('defines the discharge clearances table with required columns and types', () => {
    expect(ipdDischargeClearances).toBeDefined();
    expect(ipdDischargeClearances.dischargeType).toBeDefined();
    expect(ipdDischargeClearances.pharmacyReturnItems).toBeDefined();
    expect(ipdDischargeClearances.pharmacyCreditNoteNo).toBeDefined();
    expect(ipdDischargeClearances.pharmacyCreditAmountPaise).toBeDefined();
    expect(ipdDischargeClearances.takeHomeCounseled).toBeDefined();
    expect(ipdDischargeClearances.ivCannulaRemoved).toBeDefined();
    expect(ipdDischargeClearances.foleyCatheterRemoved).toBeDefined();
    expect(ipdDischargeClearances.woundDressingDone).toBeDefined();
    expect(ipdDischargeClearances.belongingsAndReportsHandedOver).toBeDefined();
    expect(ipdDischargeClearances.dischargeVitalsTaken).toBeDefined();
    expect(ipdDischargeClearances.gatePassNumber).toBeDefined();
  });
});
