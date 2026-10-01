/**
 * Who may do what, in one place.
 *
 * Every check here is an allow-list. The checks this replaced were written as
 * negations — "anyone who is not a doctor sees Reports" — which silently grants
 * a new role everything the author did not think to exclude. Adding a nurse or
 * lab role is a planned change, so the failure mode had to be "sees nothing"
 * rather than "sees the till".
 *
 * The matrix is typed as `Record<Permission, readonly StaffRole[]>` and the
 * view choice as `Record<StaffRole, …>`, so adding a role to STAFF_ROLES does not
 * compile until someone has decided what that role can see.
 */

/** Built into the database enum, so a role cannot exist in one and not the other. */
export const STAFF_ROLES = ['owner', 'receptionist', 'doctor'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const isStaffRole = (value: string): value is StaffRole =>
  (STAFF_ROLES as readonly string[]).includes(value);

const PERMISSIONS = {
  /** Add walk-ins and move tokens through the queue. */
  'queue.mutate': ['owner', 'receptionist', 'doctor'],
  /** Branches, doctors, staff, WhatsApp, subscription. */
  'hospital.configure': ['owner'],
  'reports.view': ['owner', 'receptionist'],
  /** The plan-expiry strip; renewing from it is `hospital.configure`. */
  'subscription.notice': ['owner', 'receptionist'],
  /**
   * Take money at the desk and mark a visit paid or unpaid. Deliberately not
   * the doctor: reception owns the till, and a doctor flipping a patient to
   * "paid" is a reconciliation problem at the end of the day.
   */
  'billing.collect': ['owner', 'receptionist'],
  /**
   * Set what the hospital charges. Separate from collecting, because the
   * person at the desk should not be the person who decides the price.
   */
  'billing.price': ['owner'],
  /**
   * Read a patient's diagnoses, notes and prescriptions. Reception is included
   * because in a small hospital the desk handles follow-ups and IPD care
   * (decision D9). Every read of a history is logged in record_access_logs.
   */
  'clinical.read': ['owner', 'receptionist', 'doctor'],
  /**
   * Write or revise a consultation. Necessary but not sufficient: the service
   * also requires the user to be linked to the visit's attending doctor
   * (doctors.user_id), so an owner can write their own patients' records and
   * nobody else's. If the pilot decides staff will type prescriptions from
   * the paper slip, this line and that check are the two places to change.
   */
  'clinical.write': ['owner', 'doctor'],
  /** Add, price, rename and deactivate medicines in the catalogue. */
  'medicines.manage': ['owner'],
  /**
   * Add a missing medicine from the prescription screen, without a price, so
   * a doctor is never blocked by an incomplete catalogue. The owner prices it.
   */
  'medicines.quickAdd': ['owner', 'doctor'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}

/**
 * Which dashboard a role lands on, and whether it may switch.
 *
 * The owner of a small hospital is often also its doctor, so they get both.
 */
const DASHBOARD_VIEWS: Record<
  StaffRole,
  { default: 'doctor' | 'reception'; canSwitch: boolean }
> = {
  owner: { default: 'reception', canSwitch: true },
  receptionist: { default: 'reception', canSwitch: false },
  doctor: { default: 'doctor', canSwitch: false },
};

export function dashboardViewFor(
  role: StaffRole,
  requested: string | null,
): 'doctor' | 'reception' {
  const view = DASHBOARD_VIEWS[role];
  if (view.canSwitch && (requested === 'doctor' || requested === 'reception')) {
    return requested;
  }
  return view.default;
}

export const canSwitchDashboardView = (role: StaffRole): boolean =>
  DASHBOARD_VIEWS[role].canSwitch;
