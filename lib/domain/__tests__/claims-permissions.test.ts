import { describe, it, expect } from 'vitest';
import { can, type Permission } from '../permissions';
import { maskClaimFinancialsForRole } from '@/lib/services/claims-masking';

describe('Claims Permissions & Nurse Financial Masking', () => {
  it('enforces role-based permissions matrix for claims', () => {
    // claims.view: owner, receptionist, doctor, nurse
    expect(can('owner', 'claims.view')).toBe(true);
    expect(can('receptionist', 'claims.view')).toBe(true);
    expect(can('doctor', 'claims.view')).toBe(true);
    expect(can('nurse', 'claims.view')).toBe(true);

    // claims.edit: owner, receptionist
    expect(can('owner', 'claims.edit')).toBe(true);
    expect(can('receptionist', 'claims.edit')).toBe(true);
    expect(can('doctor', 'claims.edit')).toBe(false);
    expect(can('nurse', 'claims.edit')).toBe(false);

    // claims.packet: owner, receptionist, doctor
    expect(can('owner', 'claims.packet')).toBe(true);
    expect(can('receptionist', 'claims.packet')).toBe(true);
    expect(can('doctor', 'claims.packet')).toBe(true);
    expect(can('nurse', 'claims.packet')).toBe(false);

    // claims.admin: owner only
    expect(can('owner', 'claims.admin')).toBe(true);
    expect(can('receptionist', 'claims.admin')).toBe(false);
    expect(can('doctor', 'claims.admin')).toBe(false);
    expect(can('nurse', 'claims.admin')).toBe(false);
  });

  it('masks all monetary amount fields when viewed by nurse', () => {
    const claim = {
      id: 'claim-1',
      status: 'preauth_approved',
      payerName: 'Star Health',
      estimatedCostPaise: 5000000,
      preauthAmountPaise: 3000000,
      approvedAmountPaise: 3000000,
      claimedAmountPaise: 4500000,
      settledAmountPaise: 4000000,
      deductionAmountPaise: 500000,
      coPayAmountPaise: 300000,
      amountPaise: 3000000,
    };

    const nurseView = maskClaimFinancialsForRole(claim, 'nurse');
    expect(nurseView.id).toBe('claim-1');
    expect(nurseView.status).toBe('preauth_approved');
    expect(nurseView.payerName).toBe('Star Health');

    // All financial amounts nullified
    expect(nurseView.estimatedCostPaise).toBeNull();
    expect(nurseView.preauthAmountPaise).toBeNull();
    expect(nurseView.approvedAmountPaise).toBeNull();
    expect(nurseView.claimedAmountPaise).toBeNull();
    expect(nurseView.settledAmountPaise).toBeNull();
    expect(nurseView.deductionAmountPaise).toBeNull();
    expect(nurseView.coPayAmountPaise).toBeNull();
    expect(nurseView.amountPaise).toBeNull();
  });

  it('preserves monetary amount fields when viewed by receptionist, doctor, or owner', () => {
    const claim = {
      id: 'claim-1',
      preauthAmountPaise: 3000000,
      approvedAmountPaise: 3000000,
    };

    expect(maskClaimFinancialsForRole(claim, 'receptionist').preauthAmountPaise).toBe(3000000);
    expect(maskClaimFinancialsForRole(claim, 'doctor').preauthAmountPaise).toBe(3000000);
    expect(maskClaimFinancialsForRole(claim, 'owner').preauthAmountPaise).toBe(3000000);
  });
});
