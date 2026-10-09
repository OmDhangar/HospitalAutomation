import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STAFF_ROLES,
  can,
  canSwitchDashboardView,
  dashboardViewFor,
  homePathFor,
  isStaffRole,
  type Permission,
} from '../permissions';

const OPD_ROLES = ['owner', 'receptionist', 'doctor'] as const;

describe('can', () => {
  it('lets every OPD role move the queue', () => {
    for (const role of OPD_ROLES) expect(can(role, 'queue.mutate')).toBe(true);
  });

  it('keeps configuration with the owner', () => {
    expect(can('owner', 'hospital.configure')).toBe(true);
    expect(can('receptionist', 'hospital.configure')).toBe(false);
    expect(can('doctor', 'hospital.configure')).toBe(false);
  });

  it('hides reports from doctors', () => {
    expect(can('doctor', 'reports.view')).toBe(false);
    expect(can('receptionist', 'reports.view')).toBe(true);
  });

  it('shows the renewal notice to the owner and doctors, not the desk or the ward', () => {
    expect(can('owner', 'subscription.notice')).toBe(true);
    expect(can('doctor', 'subscription.notice')).toBe(true);
    expect(can('receptionist', 'subscription.notice')).toBe(false);
    expect(can('nurse', 'subscription.notice')).toBe(false);
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

  it('lets every role read, because every read is logged', () => {
    for (const role of STAFF_ROLES) expect(can(role, 'clinical.read')).toBe(true);
  });

  it('never lets a nurse write a consultation or add medicines', () => {
    expect(can('nurse', 'clinical.write')).toBe(false);
    expect(can('nurse', 'medicines.manage')).toBe(false);
    expect(can('nurse', 'medicines.quickAdd')).toBe(false);
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

describe('nurse', () => {
  it('cannot mutate the queue', () => {
    expect(can('nurse', 'queue.mutate')).toBe(false);
  });

  it('cannot change prices, take money, or see reports and configuration', () => {
    expect(can('nurse', 'billing.price')).toBe(false);
    expect(can('nurse', 'billing.collect')).toBe(false);
    expect(can('nurse', 'reports.view')).toBe(false);
    expect(can('nurse', 'subscription.notice')).toBe(false);
    expect(can('nurse', 'hospital.configure')).toBe(false);
  });

  it('works on the ward: views IPD and records at the bedside, nothing more', () => {
    expect(can('nurse', 'ipd.view')).toBe(true);
    expect(can('nurse', 'ipd.record')).toBe(true);
    expect(can('nurse', 'ipd.shift')).toBe(false);
    expect(can('nurse', 'ipd.admit')).toBe(false);
    expect(can('nurse', 'ipd.correct')).toBe(false);
    expect(can('nurse', 'ipd.dischargeReady')).toBe(false);
    expect(can('nurse', 'ipd.discharge')).toBe(false);
    expect(can('nurse', 'ipd.configure')).toBe(false);
  });

  it('starts on the ward, everyone else on the queue', () => {
    expect(homePathFor('nurse')).toBe('/ipd/ward');
    for (const role of OPD_ROLES) expect(homePathFor(role)).toBe('/dashboard');
  });
});

describe('IPD permissions', () => {
  it('lets every role see the IPD section', () => {
    for (const role of STAFF_ROLES) expect(can(role, 'ipd.view')).toBe(true);
  });

  it('lets the doctor shift a patient to IPD, and not reception', () => {
    expect(can('doctor', 'ipd.shift')).toBe(true);
    expect(can('owner', 'ipd.shift')).toBe(true);
    expect(can('receptionist', 'ipd.shift')).toBe(false);
  });

  it('gives admission paperwork to reception, not the doctor', () => {
    expect(can('receptionist', 'ipd.admit')).toBe(true);
    expect(can('owner', 'ipd.admit')).toBe(true);
    expect(can('doctor', 'ipd.admit')).toBe(false);
  });

  it('lets reception record and correct entries, but a doctor neither', () => {
    expect(can('receptionist', 'ipd.record')).toBe(true);
    expect(can('receptionist', 'ipd.correct')).toBe(true);
    expect(can('doctor', 'ipd.record')).toBe(false);
    expect(can('doctor', 'ipd.correct')).toBe(false);
  });

  it('splits discharge: the doctor says ready, the desk bills', () => {
    expect(can('doctor', 'ipd.dischargeReady')).toBe(true);
    expect(can('doctor', 'ipd.discharge')).toBe(false);
    expect(can('receptionist', 'ipd.dischargeReady')).toBe(false);
    expect(can('receptionist', 'ipd.discharge')).toBe(true);
  });

  it('lets the doctor order tests, and nobody else on the ward', () => {
    expect(can('doctor', 'ipd.orderTests')).toBe(true);
    expect(can('owner', 'ipd.orderTests')).toBe(true);
    expect(can('nurse', 'ipd.orderTests')).toBe(false);
    expect(can('receptionist', 'ipd.orderTests')).toBe(false);
  });

  it('keeps ward set-up with the owner', () => {
    expect(can('owner', 'ipd.configure')).toBe(true);
    expect(can('receptionist', 'ipd.configure')).toBe(false);
    expect(can('doctor', 'ipd.configure')).toBe(false);
  });
});

describe('isStaffRole', () => {
  it('accepts only known roles', () => {
    expect(isStaffRole('receptionist')).toBe(true);
    expect(isStaffRole('nurse')).toBe(true);
    expect(isStaffRole('admin')).toBe(false);
    expect(isStaffRole('')).toBe(false);
  });
});

describe('identity permissions match the database', () => {
  /**
   * The identity definer functions in 0039 check the staff role themselves,
   * so a role list here and in SQL can drift apart silently: the button shows
   * and the database refuses, or worse, the other way round.
   */
  const migration = readFileSync(join(__dirname, '../../../drizzle/0039_persons_qid.sql'), 'utf8');

  const sqlRoles = (fn: string): string[] => {
    const start = migration.indexOf(`CREATE FUNCTION public.${fn}(`);
    expect(start, `${fn} not found in 0039`).toBeGreaterThanOrEqual(0);
    const body = migration.slice(start, migration.indexOf('END $fn$', start));
    const match = body.match(/qurio_identity_context\(ARRAY\[([^\]]*)\]\)/);
    expect(match, `${fn} does not check a staff role list`).not.toBeNull();
    return match![1].split(',').map((r) => r.trim().replace(/'/g, '')).sort();
  };

  const appRoles = (permission: Permission) => STAFF_ROLES.filter((r) => can(r, permission)).sort();

  it.each([
    ['verify_person_by_qid', 'patients.link_identity'],
    ['correct_person_identity', 'patients.correct_identity'],
    ['merge_person_local', 'patients.merge'],
    ['request_person_merge', 'patients.merge'],
  ] as const)('%s accepts exactly the roles of %s', (fn, permission) => {
    expect(sqlRoles(fn)).toEqual(appRoles(permission));
  });
});
