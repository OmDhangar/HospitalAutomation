import { describe, expect, it } from 'vitest';
import {
  STAFF_ROLES,
  can,
  canSwitchDashboardView,
  dashboardViewFor,
  isStaffRole,
} from '../permissions';

describe('can', () => {
  it('lets every current role move the queue', () => {
    for (const role of STAFF_ROLES) expect(can(role, 'queue.mutate')).toBe(true);
  });

  it('keeps configuration with the owner', () => {
    expect(can('owner', 'hospital.configure')).toBe(true);
    expect(can('receptionist', 'hospital.configure')).toBe(false);
    expect(can('doctor', 'hospital.configure')).toBe(false);
  });

  it('hides reports and the plan notice from doctors', () => {
    expect(can('doctor', 'reports.view')).toBe(false);
    expect(can('doctor', 'subscription.notice')).toBe(false);
    expect(can('receptionist', 'reports.view')).toBe(true);
  });

  it('gives the till to reception, not the doctor', () => {
    expect(can('receptionist', 'billing.collect')).toBe(true);
    expect(can('owner', 'billing.collect')).toBe(true);
    expect(can('doctor', 'billing.collect')).toBe(false);
  });

  it('lets only the owner set prices', () => {
    expect(can('owner', 'billing.price')).toBe(true);
    expect(can('receptionist', 'billing.price')).toBe(false);
    expect(can('doctor', 'billing.price')).toBe(false);
  });
});

describe('clinical permissions', () => {
  it('lets doctors and owners write, and never reception', () => {
    expect(can('doctor', 'clinical.write')).toBe(true);
    expect(can('owner', 'clinical.write')).toBe(true);
    expect(can('receptionist', 'clinical.write')).toBe(false);
  });

  it('lets every current role read, because every read is logged', () => {
    for (const role of STAFF_ROLES) expect(can(role, 'clinical.read')).toBe(true);
  });

  it('keeps medicine prices with the owner, but lets a doctor add a missing medicine', () => {
    expect(can('owner', 'medicines.manage')).toBe(true);
    expect(can('doctor', 'medicines.manage')).toBe(false);
    expect(can('receptionist', 'medicines.manage')).toBe(false);
    expect(can('doctor', 'medicines.quickAdd')).toBe(true);
    expect(can('receptionist', 'medicines.quickAdd')).toBe(false);
  });
});

describe('dashboardViewFor', () => {
  it('always puts a doctor in the doctor view', () => {
    expect(dashboardViewFor('doctor', null)).toBe('doctor');
    expect(dashboardViewFor('doctor', 'reception')).toBe('doctor');
  });

  it('keeps reception at the desk even if the URL asks otherwise', () => {
    expect(dashboardViewFor('receptionist', 'doctor')).toBe('reception');
    expect(canSwitchDashboardView('receptionist')).toBe(false);
  });

  it('lets the owner choose, defaulting to the desk', () => {
    expect(dashboardViewFor('owner', null)).toBe('reception');
    expect(dashboardViewFor('owner', 'doctor')).toBe('doctor');
    expect(dashboardViewFor('owner', 'nonsense')).toBe('reception');
    expect(canSwitchDashboardView('owner')).toBe(true);
  });
});

describe('isStaffRole', () => {
  it('accepts only known roles', () => {
    expect(isStaffRole('receptionist')).toBe(true);
    expect(isStaffRole('admin')).toBe(false);
    expect(isStaffRole('')).toBe(false);
  });
});
