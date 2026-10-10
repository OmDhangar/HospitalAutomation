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
export const STAFF_ROLES = ['owner', 'receptionist', 'doctor', 'nurse'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const isStaffRole = (value: string): value is StaffRole =>
  (STAFF_ROLES as readonly string[]).includes(value);

const PERMISSIONS = {
  /** Add walk-ins and move tokens through the queue. */
  'queue.mutate': ['owner', 'receptionist', 'doctor'],
  /**
   * Past the daily quota: issue an EXTRA token, or release unused reserved
   * walk-in capacity to online booking. The owner's call, not the desk's.
   */
  'capacity.manage': ['owner'],
  /** Branches, doctors, staff, WhatsApp, subscription. */
  'hospital.configure': ['owner'],
  'reports.view': ['owner', 'receptionist'],
  /**
   * The plan-renewal strip, on the dashboard only. The owner pays; doctors
   * are told too, because in a small hospital the doctor is often the one
   * who gets it done. Not the desk or the ward. Renewing is hospital.configure.
   */
  'subscription.notice': ['owner', 'doctor'],
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
  'clinical.read': ['owner', 'receptionist', 'doctor', 'nurse'],
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

  /* IPD (docs/plans/ipd-mvp-implementation-plan.md §4) */

  /** The IPD section: its nav entry, home screen and each patient's IPD page. */
  'ipd.view': ['owner', 'receptionist', 'doctor', 'nurse'],
  /**
   * The one-click Shift to IPD on the OPD dashboard. The doctor decides to
   * admit; reception then does the paperwork under `ipd.admit`.
   */
  'ipd.shift': ['owner', 'doctor'],
  /** Emergency admission, assign a bed and the payer, transfer, cancel a request. */
  'ipd.admit': ['owner', 'receptionist'],
  /**
   * Record what was given or used at the bedside, and undo one's own entry
   * within two minutes. Every entry becomes a server-priced bill line, so this
   * is a billing act too — but the nurse never sees the price.
   */
  'ipd.record': ['owner', 'receptionist', 'nurse'],
  /** Void any entry or bill line after the undo window, with a reason (D-UN). */
  'ipd.correct': ['owner', 'receptionist'],
  /** Tell the desk the patient may go home; billing starts from here. */
  'ipd.dischargeReady': ['owner', 'doctor'],
  /**
   * Order tests for an admitted patient from the doctor's phone view (T3.1).
   * Narrower than ipd.record: only items flagged as tests, so a doctor never
   * records the ward's consumables by accident.
   */
  'ipd.orderTests': ['owner', 'doctor'],
  /** Review, finalise and print the discharge bill. */
  'ipd.discharge': ['owner', 'receptionist'],
  /** Wards, beds, ward devices and nurse PINs. Prices stay `billing.price`. */
  'ipd.configure': ['owner'],
  /**
   * Record and correct readings on the T.P.R. chart (IPD sheets plan B1).
   * Clinical staff only: the desk does not take vitals.
   */
  'ipd.chart': ['owner', 'doctor', 'nurse'],
  /**
   * The Accountability page: the evidence log, its seals and checks (IPD
   * sheets plan §7.6). Owner only until the quality-officer role exists
   * (plan §4.4); everyone's activity is on it, so it is not for staff.
   */
  'acct.view': ['owner'],
  /**
   * Risk-class stock (IPD sheets plan B4a). Seeing it and counting it are
   * for anyone on the clinical or desk side; moving it (receive, send, take
   * delivery, ask for an adjustment) for those who keep stock; approving a
   * count or an adjustment for the owner and doctors — never the same person
   * who counted or asked (the database refuses that too).
   */
  'stock.view': ['owner', 'doctor', 'nurse', 'receptionist'],
  'stock.move': ['owner', 'nurse', 'receptionist'],
  'stock.count': ['owner', 'doctor', 'nurse', 'receptionist'],
  'stock.approve': ['owner', 'doctor'],
  'stock.configure': ['owner'],

  /**
   * The treatment card and the MAR (IPD sheets plan B3-min). A doctor writes
   * and stops lines on the card (signed when the line names them); a nurse
   * may write a telephone or verbal order, which waits for that doctor's
   * countersign (only the named doctor's own login can countersign — the
   * service checks it). Doses are recorded by clinical staff, and a
   * risk-class give is witnessed by a second clinical person — never the
   * same one (the database refuses that too).
   */
  'ipd.order': ['owner', 'doctor'],
  'ipd.transcribe': ['owner', 'nurse'],
  'ipd.countersign': ['owner', 'doctor'],
  'ipd.administer': ['owner', 'doctor', 'nurse'],
  'ipd.witness': ['owner', 'doctor', 'nurse'],
  /** Print the bed codes that prove a nurse is at the bedside. */
  'ipd.bedCodes': ['owner'],

  /**
   * Test orders and follow-up (IPD sheets plan C4a). The doctor sends a
   * patient for tests from OPD (on the ward it stays `ipd.orderTests`). Any
   * staff member can be assigned to a lab or room and work its list — the
   * service checks they are assigned there (the owner works every list). The
   * day view per lab and per person, and the tasks raised to the admin, are
   * the owner's; so is setting up the labs, rooms and their staff.
   */
  'tests.order': ['owner', 'doctor'],
  'tests.work': ['owner', 'receptionist', 'doctor', 'nurse'],
  'tests.oversee': ['owner'],
  'tests.configure': ['owner'],

  /*
   * Patient identity (0039). Each list must equal the staff roles the matching
   * definer function accepts in SQL; permissions.test.ts compares them.
   */

  /** Verify a presented QID and link this hospital's record to that person. */
  'patients.link_identity': ['owner', 'receptionist', 'doctor'],
  /** Correct a person's platform identity data (name, gender, birth year). */
  'patients.correct_identity': ['owner'],
  /** Merge duplicate patient records of this hospital, and undo a merge. */
  'patients.merge': ['owner'],
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
  /**
   * Nurses never see the OPD dashboard: the page redirects them to the ward
   * (dashboard/page.tsx). The entry exists only because every role needs one.
   */
  nurse: { default: 'reception', canSwitch: false },
};

/**
 * Where a role starts. Everyone lands on the OPD queue except nurses, whose
 * only work is on the ward.
 */
export const homePathFor = (role: StaffRole): '/dashboard' | '/ipd/ward' =>
  role === 'nurse' ? '/ipd/ward' : '/dashboard';

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
