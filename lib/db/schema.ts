import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { STAFF_ROLES, type StaffRole } from '@/lib/domain/permissions';
import type { CallOutcome, ClockFrom, ClosingOutcome, ServicePointKind, TestOrderStatus } from '@/lib/domain/test-orders';
import type { ControlFlag, DoseState, ReasonCode, Route, WasteReason } from '@/lib/domain/mar';
import type { TaskKind, TimingMode } from '@/lib/domain/due';
import type { AllergyCategory, AllergySeverity, AllergySource, DrugClass } from '@/lib/domain/allergy';
import type { MedRecDecision, MedRecPhase, MedRecSource } from '@/lib/domain/medrec';
import type { Complaint, GeneralExam, NoteKind, NoteVitals, SystemicExam } from '@/lib/domain/notes';
import type { SummaryContent } from '@/lib/domain/discharge-summary';
import type {
  AuthDecision,
  AuthType,
  ClaimStatus,
  DeadlineType,
  PaymentMethod,
  QueryStatus,
  RemittanceType,
  SettlementStatus,
  SubmissionStage,
} from '@/lib/domain/claims';
import { APPOINTMENT_STATUSES, QUEUE_ACTIONS } from '@/lib/domain/types';

/**
 * The database enums are built from the domain constants, so a status can never
 * exist in the state machine without existing in Postgres, or vice versa.
 */
export const appointmentStatus = pgEnum('appointment_status', APPOINTMENT_STATUSES);
export const queueAction = pgEnum('queue_action', QUEUE_ACTIONS);

export const staffRole = pgEnum('staff_role', STAFF_ROLES);
export const appointmentSource = pgEnum('appointment_source', ['walk_in', 'reception', 'whatsapp']);
export const locale = pgEnum('locale', ['mr', 'hi', 'en']);
export const notificationChannel = pgEnum('notification_channel', ['whatsapp', 'sms']);
export const notificationStatus = pgEnum('notification_status', [
  'pending',
  'sending',
  'sent',
  'failed',
  'suppressed',
]);
export const jobStatus = pgEnum('job_status', ['pending', 'running', 'done', 'failed']);

export const billingCycle = pgEnum('billing_cycle', ['monthly', 'annual']);
export const subscriptionStatus = pgEnum('subscription_status', [
  'trial',
  'active',
  'expired',
  'cancelled',
  'suspended',
]);

export const whatsappNumberStatus = pgEnum('whatsapp_number_status', [
  'pending',
  'registered',
  'flagged',
  'suspended',
  'released',
]);

/**
 * One attempt to collect money, and how it ended.
 *
 * `created` is a link that exists and has not been paid — the normal resting
 * state of an unpaid renewal, and distinct from `failed`, which means someone
 * tried and the payment did not go through.
 */
export const paymentStatus = pgEnum('payment_status', [
  'created',
  'paid',
  'failed',
  'cancelled',
  'expired',
  'refunded',
]);

export const paymentPurpose = pgEnum('payment_purpose', [
  'renewal',
  'upgrade',
  'setup_fee',
  'other',
]);

/**
 * Whether QueueCare can talk to this hospital's WhatsApp provider at all.
 *
 * Deliberately not the same thing as `whatsappNumberStatus`, which says whether
 * a particular sender is live. An integration can be `connected` while its
 * number is still `pending` — that is precisely the state a hospital sits in
 * between credentials working and Meta finishing number registration, and
 * collapsing the two into one column would make that state unrepresentable.
 */
export const whatsappIntegrationStatus = pgEnum('whatsapp_integration_status', [
  'not_configured',
  'pending',
  'validating',
  'connected',
  'error',
  'disconnected',
]);

/**
 * Who holds the Meta business assets behind this integration.
 *
 * 'platform' is the default and today the only one in use: we own the Business
 * Manager, the verification and the WABA, and the hospital never signs in to
 * Meta. 'hospital' is here so that a customer who already owns a verified WABA
 * can keep it without the platform needing a second architecture.
 */
export const whatsappOwnership = pgEnum('whatsapp_ownership', ['platform', 'hospital']);

/** How the credential was obtained. Only 'manual' is implemented today. */
export const whatsappOnboardingMethod = pgEnum('whatsapp_onboarding_method', [
  'manual',
  'embedded_signup',
  'bsp',
]);

export const conversationState = pgEnum('conversation_state', [
  'idle',
  'awaiting_language',
  'awaiting_active_choice',
  'awaiting_patient_choice',
  'awaiting_patient_name_age',
  'awaiting_doctor',
  'awaiting_queue_choice',
  'awaiting_slot',
]);

export const doctorScheduleMode = pgEnum('doctor_schedule_mode', ['queue', 'slot', 'both']);


const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ tenancy */

/**
 * The rate card. Prices live here rather than in code so that repricing never
 * requires a deploy — the single most important constraint on the billing side.
 */
export const planTiers = pgTable('plan_tiers', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  /** Nameplate outpatients per day this tier is sold against. */
  patientsPerDay: integer('patients_per_day').notNull().default(0),
  includedAppointments: integer('included_appointments').notNull(),
  /**
   * Where message volume itself becomes billable — set well above the alert
   * threshold, because an abnormal ratio is nearly always our defect rather
   * than the hospital's behaviour.
   */
  includedMessages: integer('included_messages').notNull().default(0),
  monthlyPricePaise: integer('monthly_price_paise').notNull(),
  /** Ten months for twelve, and waives the setup fee. */
  annualPricePaise: integer('annual_price_paise').notNull().default(0),
  /** One-time, charged on setup. Per tier, because a multi-branch install is a bigger job. */
  setupFeePaise: integer('setup_fee_paise').notNull().default(500_000),
  overagePaisePerAppointment: integer('overage_paise_per_appointment').notNull().default(100),
  overagePaisePerMessage: integer('overage_paise_per_message').notNull().default(25),
  /**
   * What the plan entitles a hospital to, beyond volume.
   *
   * `null` on a limit means unlimited, not zero — the top tier is sold on it,
   * and it saves needing a sentinel number that someone later mistakes for a
   * real cap. Every one of these is counted from a table that already exists,
   * which is why these three axes were chosen over inventing new ones.
   */
  maxBranches: integer('max_branches'),
  maxDoctors: integer('max_doctors'),
  maxStaffLogins: integer('max_staff_logins'),
  hasDisplayBoard: boolean('has_display_board').notNull().default(true),
  hasOwnerReport: boolean('has_owner_report').notNull().default(true),
  hasAdvancedReports: boolean('has_advanced_reports').notNull().default(true),
  hasDataExport: boolean('has_data_export').notNull().default(true),
  hasAuditLog: boolean('has_audit_log').notNull().default(true),
  supportTier: text('support_tier').notNull().default('email'),
  sortOrder: smallint('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const hospitals = pgTable('hospitals', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  defaultLocale: locale('default_locale').notNull().default('mr'),
  planTierCode: text('plan_tier_code').references(() => planTiers.code),
  /** Founding-customer discount, reverting per contract. */
  discountPercent: smallint('discount_percent').notNull().default(0),
  /**
   * Where the monthly summary goes. The product's value is invisible to an
   * owner after month one — patients are happier, but that never shows up on a
   * P&L — so this one message a month is the cheapest churn insurance there is.
   */
  ownerPhoneE164: text('owner_phone_e164'),
  /** How many present patients a late returner is placed behind (0034). */
  lateRejoinAfterPatients: smallint('late_rejoin_after_patients').notNull().default(2),
  /** MRN configuration (0039): optional prefix and the first number issued. Fixed once MRNs exist. */
  mrnPrefix: text('mrn_prefix'),
  mrnStart: integer('mrn_start').notNull().default(10001),
  /** Text letterhead on printed IPD sheets (0041); the address is the branch's. */
  registrationNo: text('registration_no'),
  letterheadPhones: text('letterhead_phones'),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const branches = pgTable(
  'branches',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address: text('address'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('branches_hospital_idx').on(t.hospitalId)],
);

/**
 * One row per subscription *period*, not one per hospital.
 *
 * Changing tier supersedes the current row and inserts a new one, so history
 * falls out of the design rather than needing a separate audit table: the
 * previous row still holds the tier, price, cycle and dates that applied at the
 * time.
 *
 * Price and allowances are copied onto the row rather than read through to
 * `plan_tiers`. That is the important decision here. A hospital on a
 * founding-customer rate, or one that signed before a repricing, must keep what
 * they agreed — and an invoice for August has to stay reproducible after
 * September's price change. Pointing at the live rate card would silently
 * rewrite both.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    planTierCode: text('plan_tier_code')
      .notNull()
      .references(() => planTiers.code),
    billingCycle: billingCycle('billing_cycle').notNull().default('monthly'),
    status: subscriptionStatus('status').notNull().default('active'),

    /** What this hospital actually agreed to pay, captured at signing. */
    pricePaise: integer('price_paise').notNull(),
    /** ₹5,000 on monthly, nil on annual prepay. */
    setupFeePaise: integer('setup_fee_paise').notNull().default(0),

    /** Allowances as they stood when the subscription began. */
    dailyAppointmentCapacity: integer('daily_appointment_capacity').notNull(),
    includedAppointments: integer('included_appointments').notNull(),
    includedMessages: integer('included_messages').notNull(),

    /**
     * Entitlements as they stood when the subscription began, snapshotted for
     * the same reason the allowances above are. Repricing a tier, or tightening
     * a limit on the rate card, must not reach backwards and change what an
     * existing customer was sold — "which plan covered this hospital, and what
     * did that plan permit" has to be answerable from this row alone.
     */
    maxBranches: integer('max_branches'),
    maxDoctors: integer('max_doctors'),
    maxStaffLogins: integer('max_staff_logins'),
    hasDisplayBoard: boolean('has_display_board').notNull().default(true),
    hasOwnerReport: boolean('has_owner_report').notNull().default(true),
    hasAdvancedReports: boolean('has_advanced_reports').notNull().default(true),
    hasDataExport: boolean('has_data_export').notNull().default(true),
    hasAuditLog: boolean('has_audit_log').notNull().default(true),
    supportTier: text('support_tier').notNull().default('email'),

    /** Usage periods are monthly windows anchored on this date. */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    /** End of the paid term: one month out on monthly, twelve on annual. */
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    /** Why this row exists: initial, upgrade, downgrade, renewal, cycle_change… */
    changeReason: text('change_reason'),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Set when a later subscription replaces this one. Null means current. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Exactly one current subscription per hospital, enforced by the database
     * rather than by remembering to supersede the old row first.
     */
    uniqueIndex('subscriptions_one_current_per_hospital')
      .on(t.hospitalId)
      .where(sql`superseded_at is null`),
    index('subscriptions_hospital_idx').on(t.hospitalId, t.startsAt),
    index('subscriptions_expiry_idx').on(t.status, t.endsAt),
  ],
);

/* ----------------------------------------------------------------- identity */

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  active: boolean('active').notNull().default(true),
  /**
   * Set when an operator issues a replacement password. The credential works
   * exactly once, for the sign-in that changes it — a reset the customer never
   * gets round to changing is otherwise a password we know indefinitely.
   */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Counted events for throttling sign-in and public booking (0030).
 *
 * Shared across server instances, which an in-memory limiter is not. Holds
 * only a hash of each key, never the email, phone or IP itself. No RLS: these
 * checks run before any hospital is known.
 */
export const rateLimitEvents = pgTable(
  'rate_limit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    keyHash: text('key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rate_limit_events_key_idx').on(t.keyHash, t.createdAt)],
);

/**
 * Opaque session tokens are stored hashed, so a database leak cannot be
 * replayed as a live session.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * A session is scoped to one hospital. Without this the session could not
     * be resolved at all: reading the membership that says which hospital a
     * user belongs to is itself gated by row-level security on that hospital.
     * It is also how a user who works at two hospitals will pick one at login.
     */
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Who opened this session on someone else's behalf, null on an ordinary
     * login. Support access is then distinguishable from the customer's own
     * activity in the audit trail, which is the only reason it is tolerable to
     * offer at all.
     */
    impersonatedByUserId: uuid('impersonated_by_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    /**
     * Read by the `app_read_only()` Postgres function through a transaction
     * setting, and tested by a restrictive policy on every tenant table. The
     * flag is enforced by the database, not by remembering to check it in each
     * of the server actions that write.
     */
    readOnly: boolean('read_only').notNull().default(false),
    /** Where ending an impersonation puts the operator back. */
    returnHospitalId: uuid('return_hospital_id').references(() => hospitals.id, {
      onDelete: 'set null',
    }),
    /**
     * How this person signed in (0042, ADR-022): their own device, or a PIN on
     * an enrolled ward tablet. Recorded on every entry made in the session.
     */
    channel: text('channel').$type<'personal' | 'ward_device'>().notNull().default('personal'),
    wardDeviceId: uuid('ward_device_id'),
    /** The browser's `qurio_device` cookie, or the ward device's id. */
    deviceId: text('device_id'),
    /** Written at most once a minute; drives the idle lock. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** Set when the session locks; cleared by a PIN or password unlock. */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_impersonation_idx')
      .on(t.impersonatedByUserId)
      .where(sql`impersonated_by_user_id is not null`),
  ],
);

export const staffMemberships = pgTable(
  'staff_memberships',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    role: staffRole('role').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('staff_memberships_user_hospital_key').on(t.userId, t.hospitalId),
    index('staff_memberships_hospital_idx').on(t.hospitalId),
  ],
);

/* ---------------------------------------------------- doctors and schedules */

export const doctors = pgTable(
  'doctors',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    specialty: text('specialty'),
    /** Seeds the ETA before enough real consultations have been observed. */
    defaultConsultMinutes: smallint('default_consult_minutes').notNull().default(10),
    /**
     * Daily token quota (0034). Null: no quota, tokens issue exactly as before.
     * A workload target set by the hospital, not a plan limit.
     */
    dailyTokenQuota: integer('daily_token_quota'),
    /** Tokens 1..N kept for patients who physically reach the hospital early. */
    walkInReserved: integer('walk_in_reserved').notNull().default(0),
    /** Same-day online queue booking opens this long before the scheduled start. */
    onlineOpensMinutesBefore: integer('online_opens_minutes_before').notNull().default(120),
    /** Unused reserved capacity goes to the shared pool this long after the start; null = manual only. */
    walkInReleaseMinutes: integer('walk_in_release_minutes'),
    /** Printed under the name on letterheads and signatures (0041). */
    qualification: text('qualification'),
    registrationNo: text('registration_no'),
    onLetterhead: boolean('on_letterhead').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    index('doctors_hospital_idx').on(t.hospitalId),
    index('doctors_branch_idx').on(t.branchId),
    /** One login is at most one doctor per hospital (0028). */
    uniqueIndex('doctors_hospital_user_key')
      .on(t.hospitalId, t.userId)
      .where(sql`user_id is not null`),
  ],
);

export const doctorSchedules = pgTable(
  'doctor_schedules',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'cascade' }),
    /** 0 = Sunday, matching Postgres `extract(dow ...)`. */
    weekday: smallint('weekday').notNull(),
    mode: doctorScheduleMode('mode').notNull().default('queue'),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    slotMinutes: smallint('slot_minutes').notNull().default(10),
    breakStartTime: time('break_start_time'),
    breakEndTime: time('break_end_time'),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    createdAt: createdAt(),
  },
  (t) => [index('doctor_schedules_doctor_idx').on(t.doctorId, t.weekday)],
);

/** One-off closures and changed hours; always wins over the weekly schedule. */
export const doctorScheduleExceptions = pgTable(
  'doctor_schedule_exceptions',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'cascade' }),
    serviceDate: date('service_date').notNull(),
    closed: boolean('closed').notNull().default(false),
    startTime: time('start_time'),
    endTime: time('end_time'),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('doctor_schedule_exceptions_key').on(t.doctorId, t.serviceDate)],
);

/** Specific slot activation/deactivation overrides set by doctor/admin. */
export const doctorSlotOverrides = pgTable(
  'doctor_slot_overrides',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'cascade' }),
    serviceDate: date('service_date').notNull(),
    slotTime: time('slot_time').notNull(),
    isAvailable: boolean('is_available').notNull().default(true),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('doctor_slot_overrides_key').on(t.doctorId, t.serviceDate, t.slotTime)],
);

/** Emergency / temporary unavailability interval blocks. */
export const doctorIntervalBlocks = pgTable(
  'doctor_interval_blocks',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'cascade' }),
    serviceDate: date('service_date').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    reason: text('reason'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('doctor_interval_blocks_idx').on(t.doctorId, t.serviceDate)],
);

/** Multi-day calendar shutdowns and holiday blackouts (0071, ADR-040). */
export const blackoutPeriods = pgTable(
  'blackout_periods',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id').references(() => doctors.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    reopenDate: date('reopen_date').notNull(),
    reason: text('reason').notNull(),
    publicReason: text('public_reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('blackout_periods_lookup_idx')
      .on(t.hospitalId, t.branchId, t.doctorId, t.startDate, t.endDate)
      .where(sql`cancelled_at IS NULL`),
    check('blackout_date_range_valid', sql`${t.endDate} >= ${t.startDate}`),
    check('blackout_reopen_date_valid', sql`${t.reopenDate} > ${t.endDate}`),
  ],
);

/* ------------------------------------------------------------------ persons */

/**
 * Qurio's platform-wide person identity (0039). Not tenant-readable: the app
 * role has no privileges on it and reaches it only through the identity
 * definer functions (register_person, verify_person_by_qid, ...). Declared
 * here for the admin connection and for types.
 *
 * Two independent lifecycle attributes: merge (merged_into_person_id) and
 * minimization (erased_at). The QID never changes, rows are never deleted, and
 * identity_name_key is always derived by the database.
 */
export const persons = pgTable('persons', {
  id: id(),
  qid: text('qid').notNull().unique(),
  identityName: text('identity_name'),
  identityNameKey: text('identity_name_key'),
  identityGender: text('identity_gender'),
  identityBirthYear: smallint('identity_birth_year'),
  createdByHospitalId: uuid('created_by_hospital_id').references(() => hospitals.id, { onDelete: 'set null' }),
  abhaNumber: text('abha_number'),
  abhaAddress: text('abha_address'),
  abhaLinkedAt: timestamp('abha_linked_at', { withTimezone: true }),
  abhaVerifiedAt: timestamp('abha_verified_at', { withTimezone: true }),
  mergedIntoPersonId: uuid('merged_into_person_id'),
  mergedAt: timestamp('merged_at', { withTimezone: true }),
  mergedByUserId: uuid('merged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const personMerges = pgTable('person_merges', {
  id: id(),
  fromPersonId: uuid('from_person_id').notNull().references(() => persons.id),
  toPersonId: uuid('to_person_id').notNull().references(() => persons.id),
  fromQid: text('from_qid').notNull(),
  toQid: text('to_qid').notNull(),
  flattenedPersonIds: uuid('flattened_person_ids').array().notNull().default(sql`'{}'`),
  initiatedBy: text('initiated_by').$type<'platform' | 'hospital_local'>().notNull(),
  initiatedByHospitalId: uuid('initiated_by_hospital_id').references(() => hospitals.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(),
  mergedByUserId: uuid('merged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  undoneByUserId: uuid('undone_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

export const personIdentityCorrections = pgTable('person_identity_corrections', {
  id: id(),
  personId: uuid('person_id').notNull().references(() => persons.id),
  field: text('field').$type<'name' | 'gender' | 'birth_year'>().notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  reason: text('reason').notNull(),
  correctedByUserId: uuid('corrected_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  correctedByHospitalId: uuid('corrected_by_hospital_id').references(() => hospitals.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const personVerificationAttempts = pgTable('person_verification_attempts', {
  id: id(),
  qid: text('qid').notNull(),
  hospitalId: uuid('hospital_id').notNull().references(() => hospitals.id, { onDelete: 'cascade' }),
  staffUserId: uuid('staff_user_id').references(() => users.id, { onDelete: 'set null' }),
  outcome: text('outcome').$type<'match' | 'no_match' | 'rate_limited'>().notNull(),
  /** Set exactly when outcome is 'match'; patients_link_guard checks a fresh one before a desk link. */
  matchedPersonId: uuid('matched_person_id').references(() => persons.id),
  createdAt: createdAt(),
});

/* ----------------------------------------------------------------- patients */

/**
 * Deliberately minimal: enough to message someone and greet them by name, and
 * nothing more. This is not a shadow EMR, and keeping it that way is the
 * cheapest privacy control available to us.
 *
 * `locale` lives here rather than on the conversation, so a returning patient
 * never spends a billable message re-picking their language.
 */
export const patients = pgTable(
  'patients',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    phoneE164: text('phone_e164').notNull(),
    name: text('name').notNull(),
    age: smallint('age'),
    gender: text('gender'),
    /** Free text, for finding a family in an emergency. Bills snapshot it. */
    address: text('address'),
    locale: locale('locale'),
    whatsappOptInAt: timestamp('whatsapp_opt_in_at', { withTimezone: true }),
    /**
     * Identity (0039). On an ACTIVE row (merged_into_id null) person_id and qid
     * are the canonical person and QID; a HOSPITAL-MERGED row keeps the ones it
     * had when merged. Set once; changed only by a recorded person merge.
     * Nullable until the backfill and 0040 make them required.
     */
    personId: uuid('person_id').references(() => persons.id),
    qid: text('qid'),
    /** Hospital medical record number; never changes. */
    mrn: text('mrn'),
    /** Always qurio_name_key(name), derived by trigger. Never write it. */
    nameKey: text('name_key'),
    birthYear: smallint('birth_year'),
    personLinkMethod: text('person_link_method').$type<
      'registered_here' | 'qid_verified_at_desk' | 'qid_otp_verified' | 'abha_verified' | 'person_merge'
    >(),
    /** The exact QID presented when the link was verified at the desk; may be an alias. */
    personLinkQid: text('person_link_qid'),
    personLinkedAt: timestamp('person_linked_at', { withTimezone: true }),
    personLinkedByUserId: uuid('person_linked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set on a HOSPITAL-MERGED row: the ACTIVE row in this hospital it resolves to. */
    mergedIntoId: uuid('merged_into_id'),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    mergedByUserId: uuid('merged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('patients_hospital_phone_name_key').on(t.hospitalId, t.phoneE164, t.name),
    index('patients_hospital_phone_idx').on(t.hospitalId, t.phoneE164),
  ],
);

/** A hospital-level merge of one patient row into another (0039). Tenant table. */
export const patientMerges = pgTable('patient_merges', {
  id: id(),
  hospitalId: uuid('hospital_id').notNull().references(() => hospitals.id, { onDelete: 'cascade' }),
  fromPatientId: uuid('from_patient_id').notNull(),
  toPatientId: uuid('to_patient_id').notNull(),
  repointedPatientIds: uuid('repointed_patient_ids').array().notNull().default(sql`'{}'`),
  personMergeId: uuid('person_merge_id').references(() => personMerges.id),
  reason: text('reason').notNull(),
  mergedByUserId: uuid('merged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  undoneByUserId: uuid('undone_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

/** Former QIDs of a patient row, left behind by person merges (0039). Read-only to the app. */
export const patientQidAliases = pgTable(
  'patient_qid_aliases',
  {
    hospitalId: uuid('hospital_id').notNull().references(() => hospitals.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').notNull(),
    qid: text('qid').notNull(),
    personMergeId: uuid('person_merge_id').notNull().references(() => personMerges.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('patient_qid_aliases_hospital_qid_key').on(t.hospitalId, t.qid)],
);

export const personMergeItems = pgTable('person_merge_items', {
  mergeId: uuid('merge_id').notNull().references(() => personMerges.id),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  hospitalId: uuid('hospital_id').notNull(),
  oldPersonId: uuid('old_person_id').notNull(),
  oldQid: text('old_qid').notNull(),
});

export const personMergeRequests = pgTable('person_merge_requests', {
  id: id(),
  hospitalId: uuid('hospital_id').notNull().references(() => hospitals.id, { onDelete: 'cascade' }),
  patientMergeId: uuid('patient_merge_id').references(() => patientMerges.id, { onDelete: 'set null' }),
  fromPersonId: uuid('from_person_id').notNull().references(() => persons.id),
  toPersonId: uuid('to_person_id').notNull().references(() => persons.id),
  reason: text('reason').notNull(),
  requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  status: text('status').$type<'pending' | 'merged' | 'rejected' | 'withdrawn'>().notNull().default('pending'),
  resolvedPersonMergeId: uuid('resolved_person_merge_id').references(() => personMerges.id),
  createdAt: createdAt(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

/* ------------------------------------------------------- appointments/queue */

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    serviceDate: date('service_date').notNull(),
    tokenNumber: integer('token_number').notNull(),
    status: appointmentStatus('status').notNull().default('CREATED'),
    /** Higher sorts earlier. Reception raises it for an explicit priority insert. */
    priority: smallint('priority').notNull().default(0),
    /** Flagged when admitted as an emergency. Highest queue priority and red alert UI. */
    isEmergency: boolean('is_emergency').notNull().default(false),
    /** Predefined reason for emergency (e.g. Heart Attack, Head Pain, Accident). */
    emergencyReason: text('emergency_reason'),
    /** Additional clinical or symptom notes entered by the patient or staff. */
    emergencyNotes: text('emergency_notes'),
    /** When the emergency patient was attended / handled by clinic staff. */
    emergencyHandledAt: timestamp('emergency_handled_at', { withTimezone: true }),
    emergencyHandledByUserId: uuid('emergency_handled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    source: appointmentSource('source').notNull(),
    /** Unguessable, never sequential; the patient's only credential. */
    publicToken: text('public_token').notNull().unique(),
    publicTokenExpiresAt: timestamp('public_token_expires_at', { withTimezone: true }).notNull(),
    scheduledSlotAt: timestamp('scheduled_slot_at', { withTimezone: true }),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    calledAt: timestamp('called_at', { withTimezone: true }),
    consultStartedAt: timestamp('consult_started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** FIFO order in which priority was given, per doctor-day. */
    prioritySeq: integer('priority_seq'),
    /** Late-return marker: served right after this token's place in line. */
    queueAfterToken: integer('queue_after_token'),
    rejoinSeq: integer('rejoin_seq'),
    /**
     * The day's serving sequence: 1, 2, 3… in the order patients are called
     * (0035). What patients see as the queue; the token stays their identity.
     */
    callNumber: integer('call_number'),
    /** Capacity pool that issued the token; null when no quota applied. */
    quotaPool: text('quota_pool').$type<'reserved' | 'shared' | 'extra'>(),
    /**
     * Which session the appointment belongs to (0038). `slot` appointments
     * are numbered S1, S2… by slot time in their own number space and join
     * the line only when their session starts.
     */
    sessionKind: text('session_kind').$type<'queue' | 'slot'>().notNull().default('queue'),
    /** When the doctor paused this appointment. Null unless status is HELD. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Earliest time the scheduled resume job should fire. Null unless status is HELD. */
    resumeAt: timestamp('resume_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('appointments_token_key').on(t.doctorId, t.serviceDate, t.sessionKind, t.tokenNumber),
    /**
     * At most one live token per patient per doctor per day. Enforced by the
     * database rather than by a check-then-insert, so a double-tapped Book
     * button cannot produce two tokens.
     */
    uniqueIndex('appointments_one_active_per_patient_key')
      .on(t.doctorId, t.serviceDate, t.patientId)
      .where(sql`status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED')`),
    index('appointments_queue_idx').on(t.doctorId, t.serviceDate, t.status),
    index('appointments_hospital_date_idx').on(t.hospitalId, t.serviceDate),
    index('appointments_patient_status_idx').on(t.patientId, t.status),
    uniqueIndex('appointments_priority_seq_key')
      .on(t.doctorId, t.serviceDate, t.prioritySeq)
      .where(sql`priority_seq is not null`),
    /** Booked evening slots awaiting their session: all the tick sweep reads (0038). */
    index('appointments_slot_awaiting_session_idx')
      .on(t.scheduledSlotAt)
      .where(sql`status = 'CONFIRMED' and session_kind = 'slot'`),
  ],
);

/**
 * Append-only. Nothing updates or deletes these rows; they are how we answer
 * "who moved this token, when, and what did the queue look like at the time".
 */
export const queueEvents = pgTable(
  'queue_events',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'cascade' }),
    action: queueAction('action').notNull(),
    fromStatus: appointmentStatus('from_status').notNull(),
    toStatus: appointmentStatus('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('queue_events_appointment_idx').on(t.appointmentId, t.createdAt),
    index('queue_events_doctor_idx').on(t.doctorId, t.createdAt),
  ],
);

/**
 * One row per doctor per day. Every queue mutation takes `select ... for update`
 * on this row first, which is what makes two receptionists clicking Next at the
 * same instant safe: they serialise here instead of racing.
 *
 * `lastTokenNumber` is allocated from here so tokens are never reused, even
 * after cancellations.
 */
export const doctorDayStates = pgTable(
  'doctor_day_states',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'cascade' }),
    serviceDate: date('service_date').notNull(),
    mode: doctorScheduleMode('mode'),
    paused: boolean('paused').notNull().default(false),
    pausedReason: text('paused_reason'),
    /** When the current break began. Null whenever `paused` is false. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }),
    sessionStartedAt: timestamp('session_started_at', { withTimezone: true }),
    lastTokenNumber: integer('last_token_number').notNull().default(0),
    /** Last call number issued today (0035). */
    lastCallNumber: integer('last_call_number').notNull().default(0),
    /** Counter for priority_seq and rejoin_seq (0034). */
    lastQueueSeq: integer('last_queue_seq').notNull().default(0),
    /**
     * Deprecated (0038): the old per-day quota snapshot. Capacity now reads
     * the doctor's standing settings live; these are dropped in a follow-up.
     */
    tokenQuota: integer('token_quota'),
    walkInReserved: integer('walk_in_reserved'),
    walkInReleaseMinutes: integer('walk_in_release_minutes'),
    onlineOpensMinutesBefore: integer('online_opens_minutes_before'),
    /** Today's extra capacity on top of the doctor's standing quota (0038). */
    extraCapacity: integer('extra_capacity').notNull().default(0),
    /**
     * Observed minutes per patient, call to call (0038). Updated by the same
     * statement that issues each call number, so the ETA costs no extra write
     * and no read of consultation history.
     */
    paceMinutes: real('pace_minutes'),
    paceSamples: integer('pace_samples').notNull().default(0),
    /** Last call today; cleared by a break so the break is never a sample. */
    lastCalledAt: timestamp('last_called_at', { withTimezone: true }),
    lastReservedToken: integer('last_reserved_token').notNull().default(0),
    /** Owner released unused reserved walk-in capacity to the shared pool. */
    reservedReleasedAt: timestamp('reserved_released_at', { withTimezone: true }),
    /** Today's OPD intake stopped (0070). Null = open; past = stopped; future = scheduled stop. */
    opdStoppedAt: timestamp('opd_stopped_at', { withTimezone: true }),
    opdStoppedByUserId: uuid('opd_stopped_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('doctor_day_states_key').on(t.doctorId, t.serviceDate)],
);

/**
 * One WhatsApp sender number.
 *
 * These live on OUR WhatsApp Business Account, one per hospital, and that
 * arrangement is the whole multi-tenant strategy:
 *
 *   - One Meta business verification for us, none for the hospital. A
 *     semi-urban hospital cannot produce incorporation documents and chase Meta
 *     for three weeks, and asking them to is where onboarding dies.
 *   - Templates are approved per WABA, not per number, so twelve approvals
 *     cover every hospital rather than twelve each.
 *   - Each number carries its own display name, so the patient sees their
 *     hospital's name and not ours. On a message about a medical appointment
 *     that difference decides whether the link gets opened.
 *   - Quality rating is per number, so one hospital's patients blocking
 *     messages does not poison everyone else's sender reputation.
 *   - One consolidated Meta bill arrives to us. The hospital never sees a
 *     message count, which is the point.
 *
 * A row with no hospital is unassigned inventory: a number we hold ready for
 * the next customer. Meta allows 20 numbers per WABA, so past twenty hospitals
 * we add another WABA under the same verified business — `wabaId` is here so
 * that day needs no migration.
 */
export const whatsappNumbers = pgTable(
  'whatsapp_numbers',
  {
    id: id(),
    hospitalId: uuid('hospital_id').references(() => hospitals.id, {
      onDelete: 'set null',
    }),
    /** Which WhatsApp Business Account holds this number. */
    wabaId: text('waba_id'),
    /** Meta's id for the number. Inbound webhooks carry this and nothing else. */
    phoneNumberId: text('phone_number_id').notNull().unique(),
    /** The number itself, for humans. */
    displayPhoneNumber: text('display_phone_number'),
    /** The name patients see. Meta approves this separately from the number. */
    verifiedName: text('verified_name'),
    status: whatsappNumberStatus('status').notNull().default('pending'),
    /** GREEN, YELLOW or RED, as reported by Meta. Watch it per hospital. */
    qualityRating: text('quality_rating'),
    /** Meta's throughput tier for this number, e.g. TIER_1K. */
    messagingTier: text('messaging_tier'),
    registeredAt: timestamp('registered_at', { withTimezone: true }),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [index('whatsapp_numbers_hospital_idx').on(t.hospitalId)],
);

/**
 * How QueueCare authenticates with one hospital's WhatsApp provider.
 *
 * The split from `whatsappNumbers` is the whole point of this table. A number
 * answers "which sender can this hospital use, and is it live"; an integration
 * answers "can we reach the provider at all, and as whom". They fail
 * independently — a valid credential with an unregistered number, or a
 * suspended number under a perfectly good credential — and a single table
 * cannot express either without lying about the other.
 *
 * Related by `hospitalId` rather than by a foreign key from `whatsappNumbers`,
 * because there is exactly one integration per hospital and adding
 * `integration_id` to the numbers table would duplicate a link that already
 * exists. The day a hospital needs two WABAs, the unique index below comes off
 * and that column goes on — a migration, made deliberately, not a shape carried
 * speculatively for years.
 *
 * Credentials are sealed, never stored plain, and are NULL for every
 * platform-owned row. A database check constraint enforces that rather than
 * this comment.
 */
export const whatsappIntegrations = pgTable(
  'whatsapp_integrations',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('meta'),
    ownership: whatsappOwnership('ownership').notNull().default('platform'),
    onboardingMethod: whatsappOnboardingMethod('onboarding_method')
      .notNull()
      .default('manual'),
    status: whatsappIntegrationStatus('status').notNull().default('not_configured'),

    /** Meta business id, informational under platform ownership. */
    businessId: text('business_id'),
    /** The WABA this integration's numbers must belong to. */
    wabaId: text('waba_id'),

    /**
     * AES-256-GCM parts of the sealed access token, or all NULL.
     *
     * Split into columns rather than one blob so a key rotation reads the
     * version, re-seals, and writes back — without a format migration. Never
     * selected by any read that feeds the UI; see `lib/services/whatsapp-integration.ts`,
     * where the safe projection is the only exported shape.
     */
    credentialCiphertext: text('credential_ciphertext'),
    credentialIv: text('credential_iv'),
    credentialAuthTag: text('credential_auth_tag'),
    credentialKeyVersion: smallint('credential_key_version'),

    /**
     * The inbound half, sealed the same way and NULL under platform ownership.
     *
     * The verify token is what Meta echoes during the subscription handshake;
     * the app secret is what every payload is signed with. Both are per-Meta-App,
     * so a hospital running its own app needs its own pair — and the webhook
     * needs a per-hospital URL to know which pair to reach for, because the
     * handshake carries no tenant identity of its own.
     */
    verifyTokenCiphertext: text('verify_token_ciphertext'),
    verifyTokenIv: text('verify_token_iv'),
    verifyTokenAuthTag: text('verify_token_auth_tag'),
    verifyTokenKeyVersion: smallint('verify_token_key_version'),

    appSecretCiphertext: text('app_secret_ciphertext'),
    appSecretIv: text('app_secret_iv'),
    appSecretAuthTag: text('app_secret_auth_tag'),
    appSecretKeyVersion: smallint('app_secret_key_version'),

    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    /** A category, never a provider message — those quote the token back. */
    lastErrorCode: text('last_error_code'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),

    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('whatsapp_integrations_one_per_hospital').on(t.hospitalId)],
);

/**
 * Inbound demo requests from the public marketing page.
 *
 * Platform-level, same as `provider_invoices`: it belongs to no hospital, so it
 * carries no RLS policy. Access is application-gated — the public form writes
 * rows; only `isPlatformAdmin` may list them.
 */
export const demoRequestStatus = pgEnum('demo_request_status', [
  'new',
  'contacted',
  'demoed',
  'won',
  'lost',
]);

export const demoRequests = pgTable(
  'demo_requests',
  {
    id: id(),
    name: text('name').notNull(),
    organisation: text('organisation').notNull(),
    phoneE164: text('phone_e164').notNull(),
    city: text('city').notNull(),
    patientsPerDay: text('patients_per_day').notNull(),
    status: demoRequestStatus('status').notNull().default('new'),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [
    index('demo_requests_phone_created_idx').on(t.phoneE164, t.createdAt),
    index('demo_requests_created_idx').on(t.createdAt),
  ],
);

/**
 * What Meta actually charged, per month, across every hospital.
 *
 * Without this, cost per hospital is an estimate multiplied by a message count,
 * and an estimate is a fine planning tool but a poor basis for knowing whether
 * a customer is profitable. Recording the real invoice turns the margin figures
 * on the platform dashboard from a guess into a reconciliation.
 *
 * Platform-level, so no tenant ever sees it and it carries no RLS policy.
 */
export const providerInvoices = pgTable(
  'provider_invoices',
  {
    id: id(),
    provider: text('provider').notNull().default('meta'),
    /** First day of the billed month. */
    periodMonth: date('period_month').notNull(),
    messagesBilled: integer('messages_billed').notNull(),
    amountPaise: integer('amount_paise').notNull(),
    notes: text('notes'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('provider_invoices_key').on(t.provider, t.periodMonth)],
);

/**
 * Where a patient is in a WhatsApp booking conversation.
 *
 * One row per phone number per hospital, not one per conversation: a patient
 * who wanders off mid-booking and comes back next week should resume cleanly
 * rather than accumulate dead rows.
 */
export const whatsappConversations = pgTable(
  'whatsapp_conversations',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    phoneE164: text('phone_e164').notNull(),
    state: conversationState('state').notNull().default('idle'),
    /** Selections gathered so far: doctor id, chosen slot, and so on. */
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    /** Opens Meta's 24-hour customer service window; tracked for cost analysis. */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    /**
     * What we last asked this number, and when.
     *
     * Every tap of "Hi" is a distinct Meta message with its own id, so replay
     * protection does not catch it — five taps used to buy five identical
     * menus. These two columns let us recognise a prompt the patient already
     * has on screen and stay quiet instead.
     */
    lastPromptStep: text('last_prompt_step'),
    lastPromptAt: timestamp('last_prompt_at', { withTimezone: true }),
    /** Daily prompt budget, so one sender cannot run up a bill in a loop. */
    promptsToday: integer('prompts_today').notNull().default(0),
    promptsDate: date('prompts_date'),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('whatsapp_conversations_key').on(t.hospitalId, t.phoneE164)],
);

/* ------------------------------------------------------------ notifications */

/**
 * The outbox. Business logic writes an intent here inside the same transaction
 * as the queue mutation; the worker drains it and talks to Meta.
 *
 * De-duplication is the unique index below, not application logic — a retry
 * storm physically cannot produce a second copy of a milestone. `milestone`
 * names the message kind (`booking_confirmed`, `queue_ahead_4`, ...) and is
 * NOT NULL precisely so the constraint bites.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    /**
     * Null for messages sent during a booking conversation, before any
     * appointment exists. Those rows are still recorded here because this table
     * is the meter for messages-per-appointment — the number that governs the
     * business — and a message missing from it is margin we cannot see.
     *
     * Nulls also switch off de-duplication for exactly the right rows: Postgres
     * treats them as distinct in the unique index below, so a conversation may
     * legitimately send several messages while a milestone still cannot repeat.
     */
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'cascade',
    }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'cascade' }),
    channel: notificationChannel('channel').notNull().default('whatsapp'),
    milestone: text('milestone').notNull(),
    templateCode: text('template_code').notNull(),
    locale: locale('locale').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: notificationStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When a worker took this row. A crash between claiming and sending would
     * otherwise strand the message in 'sending' forever, so anything held for
     * too long is reclaimed on the next pass.
     */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedReason: text('failed_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notification_outbox_dedup_key').on(t.appointmentId, t.milestone),
    index('notification_outbox_drain_idx').on(t.status, t.scheduledFor),
    index('notification_outbox_hospital_idx').on(t.hospitalId, t.createdAt),
  ],
);

/* -------------------------------------------------------------------- infra */

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: jobStatus('status').notNull().default('pending'),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_claim_idx').on(t.status, t.runAfter)],
);

/**
 * Replayed responses for retried mutations. Scoped per hospital so one tenant
 * can never probe another tenant's keys.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: smallint('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idempotency_keys_key').on(t.hospitalId, t.key)],
);

/** Monthly billing snapshot, so an invoice is reproducible from the database. */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    /** First day of the billing month. */
    periodMonth: date('period_month').notNull(),
    planTierCode: text('plan_tier_code').notNull(),
    completedAppointments: integer('completed_appointments').notNull().default(0),
    messagesSent: integer('messages_sent').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('usage_records_key').on(t.hospitalId, t.periodMonth)],
);

/**
 * Security-relevant and administrative actions. Queue movements live in
 * `queue_events`; this is for logins, role changes, exports, configuration
 * changes, doctor pause/resume and support access.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    hospitalId: uuid('hospital_id').references(() => hospitals.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_hospital_idx').on(t.hospitalId, t.createdAt),
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt),
  ],
);

/**
 * One attempt to collect money from a hospital.
 *
 * Deliberately not folded into `subscriptions`. A subscription row is the
 * agreement — tier, price, term. A payment is an attempt to collect against
 * it, and the two are not one-to-one in either direction: a renewal may be
 * attempted three times before a card works, and a link may be created and
 * never paid. Merging them would make "active" mean two different things and
 * discard every failed attempt — which is precisely the history needed when a
 * hospital says they paid and their plan lapsed anyway.
 *
 * Amount and tax are copied onto the row rather than read through to the
 * subscription, for the same reason `subscriptions` copies price: a September
 * invoice must stay reproducible after October's repricing.
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    /** Null once that term is superseded; the payment still happened. */
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull().default('razorpay'),
    purpose: paymentPurpose('purpose').notNull().default('renewal'),
    status: paymentStatus('status').notNull().default('created'),

    /** Base amount, excluding tax. */
    amountPaise: integer('amount_paise').notNull(),
    /** Held apart so an invoice shows it as its own line. Zero until GST registered. */
    taxPaise: integer('tax_paise').notNull().default(0),
    currency: text('currency').notNull().default('INR'),

    providerLinkId: text('provider_link_id'),
    /** Only exists once someone actually pays. Unique — the idempotency key. */
    providerPaymentId: text('provider_payment_id'),
    shortUrl: text('short_url'),

    expiresAt: timestamp('expires_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** A category, never a raw gateway message. */
    failureReason: text('failure_reason'),
    notes: jsonb('notes').$type<Record<string, unknown>>(),

    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payments_provider_payment_id')
      .on(t.providerPaymentId)
      .where(sql`provider_payment_id is not null`),
    uniqueIndex('payments_provider_link_id')
      .on(t.providerLinkId)
      .where(sql`provider_link_id is not null`),
    index('payments_hospital_idx').on(t.hospitalId, t.createdAt),
  ],
);

/* ------------------------------------------------------ patient billing */

/**
 * The patient side of money: what the hospital charges a patient, and what
 * the patient paid. Separate from `payments`/`subscriptions` above, which are
 * the hospital paying us. Migration 0026 carries the reasoning, the triggers
 * that freeze recorded money, and the composite tenant keys; this mirrors it
 * for typed queries.
 */

export const encounterStage = pgEnum('encounter_stage', ['opd', 'ipd']);
export const encounterStatus = pgEnum('encounter_status', ['open', 'closed', 'cancelled']);
export const encounterOrigin = pgEnum('encounter_origin', ['queue', 'emergency', 'direct']);
export const serviceKind = pgEnum('service_kind', ['consultation']);
export const billStatus = pgEnum('bill_status', ['draft', 'final', 'cancelled']);
export const billItemType = pgEnum('bill_item_type', [
  'consultation',
  'medicine',
  'other',
  // IPD sources (0031). Each has its own typed column and CHECK in 0032.
  'consumable',
  'procedure',
  'service',
  'room',
]);
export const patientPaymentKind = pgEnum('patient_payment_kind', ['payment', 'refund']);
export const patientPaymentMethod = pgEnum('patient_payment_method', [
  'cash',
  'upi',
  'card',
  'bank',
  'other',
]);

const voidColumns = () => ({
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedByUserId: uuid('voided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  voidReason: text('void_reason'),
});

/** What the hospital charges for things that are not medicines. Today: consultation fees. */
export const services = pgTable(
  'services',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    kind: serviceKind('kind').notNull(),
    name: text('name').notNull(),
    doctorId: uuid('doctor_id').references(() => doctors.id),
    sellingPricePaise: integer('selling_price_paise').notNull(),
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('services_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('services_doctor_consultation_key')
      .on(t.hospitalId, t.doctorId)
      .where(sql`kind = 'consultation'`),
  ],
);

/**
 * One episode of care. It points at the appointment that started it; the
 * appointment never points back, which is what keeps the queue untouched.
 */
export const encounters = pgTable(
  'encounters',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    attendingDoctorId: uuid('attending_doctor_id')
      .notNull()
      .references(() => doctors.id),
    origin: encounterOrigin('origin').notNull(),
    stage: encounterStage('stage').notNull().default('opd'),
    status: encounterStatus('status').notNull().default('open'),
    openedByUserId: uuid('opened_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('encounters_tenant_patient_key').on(t.hospitalId, t.id, t.patientId),
    uniqueIndex('encounters_appointment_key')
      .on(t.appointmentId)
      .where(sql`appointment_id is not null`),
    index('encounters_patient_idx').on(t.patientId, t.openedAt),
    index('encounters_open_idx')
      .on(t.hospitalId, t.branchId, t.stage)
      .where(sql`status = 'open'`),
    check('encounters_closed_at', sql`(status = 'open') = (closed_at is null)`),
  ],
);

/** A draft is the running bill; `final` is frozen by trigger. */
export const bills = pgTable(
  'bills',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    status: billStatus('status').notNull().default('draft'),
    billNumber: text('bill_number'),
    fiscalYear: text('fiscal_year'),
    subtotalPaise: integer('subtotal_paise'),
    discountPaise: integer('discount_paise'),
    taxPaise: integer('tax_paise'),
    totalPaise: integer('total_paise'),
    patientName: text('patient_name'),
    patientPhone: text('patient_phone'),
    patientAddress: text('patient_address'),
    /** Snapshots at finalization (0039): an old bill reprints with the identity it was issued under. */
    patientQid: text('patient_qid'),
    patientMrn: text('patient_mrn'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizedByUserId: uuid('finalized_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelReason: text('cancel_reason'),
    supersedesBillId: uuid('supersedes_bill_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'bills_encounter_fk',
      columns: [t.hospitalId, t.encounterId, t.patientId],
      foreignColumns: [encounters.hospitalId, encounters.id, encounters.patientId],
    }).onDelete('cascade'),
    uniqueIndex('bills_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('bills_one_draft_key').on(t.encounterId).where(sql`status = 'draft'`),
    uniqueIndex('bills_number_key')
      .on(t.hospitalId, t.billNumber)
      .where(sql`bill_number is not null`),
    index('bills_encounter_idx').on(t.encounterId),
  ],
);

/**
 * One chargeable line, with the price it was charged at copied onto it.
 * Items are only ever inserted or voided, and only while the bill is a draft.
 */
export const billItems = pgTable(
  'bill_items',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id').notNull(),
    itemType: billItemType('item_type').notNull(),
    serviceId: uuid('service_id'),
    appointmentId: uuid('appointment_id').references(() => appointments.id),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    configuredUnitPricePaise: integer('configured_unit_price_paise'),
    unitPricePaise: integer('unit_price_paise').notNull(),
    priceOverrideReason: text('price_override_reason'),
    subtotalPaise: integer('subtotal_paise').notNull(),
    discountPaise: integer('discount_paise').notNull().default(0),
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    taxPaise: integer('tax_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull(),
    /**
     * IPD sources (0032). Each item type has exactly its own source (the
     * bill_items_source CHECK). Their composite keys to medicines, charge
     * items, care entries and bed assignments live in the migration only:
     * those tables are declared further down this file.
     */
    medicineId: uuid('medicine_id'),
    chargeItemId: uuid('charge_item_id'),
    careEntryId: uuid('care_entry_id'),
    bedAssignmentId: uuid('bed_assignment_id'),
    /** The day a room line charges for (YYYY-MM-DD, hospital time). */
    serviceDate: date('service_date', { mode: 'string' }),
    /** Why discount_paise is not zero (0033). */
    discountReason: text('discount_reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [
    foreignKey({
      name: 'bill_items_bill_fk',
      columns: [t.hospitalId, t.billId],
      foreignColumns: [bills.hospitalId, bills.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bill_items_service_fk',
      columns: [t.hospitalId, t.serviceId],
      foreignColumns: [services.hospitalId, services.id],
    }),
    index('bill_items_bill_idx').on(t.billId).where(sql`voided_at is null`),
    uniqueIndex('bill_items_consultation_once')
      .on(t.appointmentId)
      .where(sql`appointment_id is not null and voided_at is null`),
    uniqueIndex('bill_items_care_entry_once')
      .on(t.careEntryId)
      .where(sql`care_entry_id is not null and voided_at is null`),
    uniqueIndex('bill_items_bed_day_once')
      .on(t.bedAssignmentId, t.serviceDate)
      .where(sql`bed_assignment_id is not null and voided_at is null`),
  ],
);

/** Money in, per encounter. Deposits are payments taken before a bill is final. */
export const patientPayments = pgTable(
  'patient_payments',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    billId: uuid('bill_id'),
    kind: patientPaymentKind('kind').notNull().default('payment'),
    amountPaise: integer('amount_paise').notNull(),
    method: patientPaymentMethod('method').notNull().default('cash'),
    reference: text('reference'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    receivedByUserId: uuid('received_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [
    foreignKey({
      name: 'patient_payments_encounter_fk',
      columns: [t.hospitalId, t.encounterId, t.patientId],
      foreignColumns: [encounters.hospitalId, encounters.id, encounters.patientId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'patient_payments_bill_fk',
      columns: [t.hospitalId, t.billId],
      foreignColumns: [bills.hospitalId, bills.id],
    }),
    index('patient_payments_encounter_idx').on(t.encounterId).where(sql`voided_at is null`),
  ],
);

/* ---------------------------------------------------- OPD clinical records */

/**
 * The medicine catalogue (configuration) and the OPD clinical record:
 * diagnoses, notes and prescriptions. Migration 0028 carries the reasoning.
 *
 * Every clinical table here is also behind the `clinical_access` policy: it
 * is invisible unless withTenant() was called with `{ clinical: true }` on a
 * request that is not a read-only support session.
 */

export const clinicalNoteKind = pgEnum('clinical_note_kind', ['consultation']);
export const prescriptionStatus = pgEnum('prescription_status', ['final', 'superseded']);

/** What the hospital offers. Not patient data, so not behind the clinical key. */
export const medicines = pgTable(
  'medicines',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    genericName: text('generic_name'),
    strength: text('strength'),
    form: text('form'),
    /** The billing unit: what one unit of quantity on a bill means. */
    unit: text('unit').notNull().default('unit'),
    /** Null = not priced yet: prescribable, but refused on a bill. */
    sellingPricePaise: integer('selling_price_paise'),
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    active: boolean('active').notNull().default(true),
    /** Time-critical (0049, B3b): alerts and escalation when late, once the list is signed off. */
    timeCritical: boolean('time_critical').notNull().default(false),
    tcWindowBeforeMin: smallint('tc_window_before_min'),
    tcWindowAfterMin: smallint('tc_window_after_min'),
    tcChangedAt: timestamp('tc_changed_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('medicines_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('medicines_identity_key').on(
      t.hospitalId,
      sql`lower(name)`,
      sql`coalesce(lower(strength), '')`,
      sql`coalesce(lower(form), '')`,
    ),
  ],
);

/** Unsaved work: scratch space, not part of the record. Deleted at Save. */
export const consultationDrafts = pgTable(
  'consultation_drafts',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    version: integer('version').notNull().default(1),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'consultation_drafts_encounter_fk',
      columns: [t.hospitalId, t.encounterId, t.patientId],
      foreignColumns: [encounters.hospitalId, encounters.id, encounters.patientId],
    }).onDelete('cascade'),
    uniqueIndex('consultation_drafts_encounter_key').on(t.encounterId),
  ],
);

export const diagnoses = pgTable(
  'diagnoses',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id),
    text: text('text').notNull(),
    /** ICD-10 later; free text today. */
    code: text('code'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [
    foreignKey({
      name: 'diagnoses_encounter_fk',
      columns: [t.hospitalId, t.encounterId, t.patientId],
      foreignColumns: [encounters.hospitalId, encounters.id, encounters.patientId],
    }).onDelete('cascade'),
    index('diagnoses_encounter_idx').on(t.encounterId).where(sql`voided_at is null`),
  ],
);

export const clinicalNotes = pgTable(
  'clinical_notes',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: clinicalNoteKind('kind').notNull(),
    body: text('body').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    doctorId: uuid('doctor_id').references(() => doctors.id),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [
    foreignKey({
      name: 'clinical_notes_encounter_fk',
      columns: [t.hospitalId, t.encounterId, t.patientId],
      foreignColumns: [encounters.hospitalId, encounters.id, encounters.patientId],
    }).onDelete('cascade'),
    index('clinical_notes_encounter_idx').on(t.encounterId).where(sql`voided_at is null`),
  ],
);

/** Born final; the only change it can undergo is being superseded by a revision. */
export const prescriptions = pgTable(
  'prescriptions',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    prescriberDoctorId: uuid('prescriber_doctor_id')
      .notNull()
      .references(() => doctors.id),
    prescriberName: text('prescriber_name').notNull(),
    status: prescriptionStatus('status').notNull().default('final'),
    advice: text('advice'),
    followUpOn: date('follow_up_on'),
    supersedesPrescriptionId: uuid('supersedes_prescription_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'prescriptions_encounter_fk',
      columns: [t.hospitalId, t.encounterId, t.patientId],
      foreignColumns: [encounters.hospitalId, encounters.id, encounters.patientId],
    }).onDelete('cascade'),
    uniqueIndex('prescriptions_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('prescriptions_one_current_key').on(t.encounterId).where(sql`status = 'final'`),
    index('prescriptions_patient_idx').on(t.patientId, t.createdAt).where(sql`status = 'final'`),
    index('prescriptions_doctor_idx').on(t.prescriberDoctorId, t.createdAt),
  ],
);

/** Written with their prescription, never again. Snapshots survive a catalogue rename. */
export const prescriptionItems = pgTable(
  'prescription_items',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    prescriptionId: uuid('prescription_id').notNull(),
    medicineId: uuid('medicine_id').notNull(),
    medicineName: text('medicine_name').notNull(),
    strength: text('strength'),
    form: text('form'),
    dose: text('dose').notNull(),
    frequency: text('frequency').notNull(),
    durationDays: smallint('duration_days'),
    route: text('route'),
    instructions: text('instructions'),
    sortOrder: smallint('sort_order').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'prescription_items_prescription_fk',
      columns: [t.hospitalId, t.prescriptionId],
      foreignColumns: [prescriptions.hospitalId, prescriptions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'prescription_items_medicine_fk',
      columns: [t.hospitalId, t.medicineId],
      foreignColumns: [medicines.hospitalId, medicines.id],
    }),
    index('prescription_items_prescription_idx').on(t.prescriptionId, t.sortOrder),
    index('prescription_items_medicine_idx').on(t.medicineId),
  ],
);

/** Who opened whose history and who printed what. Append-only. */
export const recordAccessLogs = pgTable(
  'record_access_logs',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'cascade' }),
    action: text('action')
      .$type<
        | 'view_history'
        | 'print_prescription'
        | 'view_admission'
        | 'print_ipd_bill'
        | 'print_ipd_file'
        | 'view_file_upload'
        | 'family_unlock'
        | 'view_claim'
        | 'decrypt_claim_identifier'
      >()
      .notNull(),
    /** The browser or ward device, and the login session (0041; filled from phase A5). */
    deviceId: text('device_id'),
    sessionId: uuid('session_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('record_access_logs_patient_idx').on(t.patientId, t.createdAt),
    index('record_access_logs_hospital_idx').on(t.hospitalId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------- IPD */

/**
 * IPD: wards and beds, admissions, bedside care entries, the non-medicine
 * price list and payers. Migration 0032 carries the reasoning; the design is
 * docs/plans/ipd-mvp-implementation-plan.md §3.
 *
 * `admissions` and `care_entries` are clinical: invisible unless withTenant()
 * was called with `{ clinical: true }`.
 */

export const admissionStatus = pgEnum('admission_status', [
  'awaiting_bed',
  'admitted',
  'discharge_ready',
  'discharged',
  'cancelled',
]);
export const chargeItemKind = pgEnum('charge_item_kind', [
  'consumable',
  'procedure',
  'service',
  'room',
]);
export const payerKind = pgEnum('payer_kind', ['self', 'insurer', 'tpa', 'corporate']);

/** Everything chargeable that is not a medicine. Null price = not priced yet. */
export const chargeItems = pgTable(
  'charge_items',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    kind: chargeItemKind('kind').notNull(),
    name: text('name').notNull(),
    unit: text('unit').notNull().default('unit'),
    sellingPricePaise: integer('selling_price_paise'),
    taxRateBp: integer('tax_rate_bp').notNull().default(0),
    isTest: boolean('is_test').notNull().default(false),
    /** Where the test is done (0047, C4a). Only for tests; its foreign key lives in the migration. */
    servicePointId: uuid('service_point_id'),
    active: boolean('active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('charge_items_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('charge_items_identity_key').on(t.hospitalId, t.kind, sql`lower(name)`),
    check('charge_items_test_is_service', sql`not is_test or kind = 'service'`),
  ],
);

export const wards = pgTable(
  'wards',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    name: text('name').notNull(),
    sortOrder: smallint('sort_order').notNull().default(0),
    /** The room charge per day: a charge item of kind 'room'. */
    dailyChargeItemId: uuid('daily_charge_item_id'),
    /** Who gets level-1 escalations of late time-critical doses (0049). */
    inChargeUserId: uuid('in_charge_user_id'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('wards_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('wards_name_key').on(t.hospitalId, t.branchId, sql`lower(name)`),
    foreignKey({
      name: 'wards_daily_charge_fk',
      columns: [t.hospitalId, t.dailyChargeItemId],
      foreignColumns: [chargeItems.hospitalId, chargeItems.id],
    }),
  ],
);

export const beds = pgTable(
  'beds',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    wardId: uuid('ward_id').notNull(),
    label: text('label').notNull(),
    sortOrder: smallint('sort_order').notNull().default(0),
    status: text('status')
      .$type<'vacant' | 'occupied' | 'cleaning' | 'maintenance'>()
      .notNull()
      .default('vacant'),
    cleanedAt: timestamp('cleaned_at', { withTimezone: true }),
    cleanedByUserId: uuid('cleaned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Printed on the bed; typed (or scanned) to prove the nurse is at the bedside (0048). Given on first need. */
    bedCode: text('bed_code'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('beds_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('beds_label_key').on(t.wardId, sql`lower(label)`),
    foreignKey({
      name: 'beds_ward_fk',
      columns: [t.hospitalId, t.wardId],
      foreignColumns: [wards.hospitalId, wards.id],
    }).onDelete('cascade'),
  ],
);

/** Clinical. One stay, from Shift to IPD (or an emergency admission) to discharge. */
export const admissions = pgTable(
  'admissions',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    admittingDoctorId: uuid('admitting_doctor_id').notNull(),
    status: admissionStatus('status').notNull().default('awaiting_bed'),
    /** The IPD No. on every sheet; given with the first bed, never reused (0041). */
    ipdNumber: integer('ipd_number'),
    reason: text('reason'),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    admittedAt: timestamp('admitted_at', { withTimezone: true }),
    admittedByUserId: uuid('admitted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    dischargeReadyAt: timestamp('discharge_ready_at', { withTimezone: true }),
    dischargeReadyByUserId: uuid('discharge_ready_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    dischargedAt: timestamp('discharged_at', { withTimezone: true }),
    dischargedByUserId: uuid('discharged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelReason: text('cancel_reason'),
    /** Doctor ordered frequency for vitals (q1h, q2h, q4h, q6h, q8h, q12h, daily, prn). */
    vitalsFrequency: text('vitals_frequency').default('q4h'),
    /** The family's running-bill link (0033): hashed token, expiry 7 days after discharge. */
    billLinkTokenHash: text('bill_link_token_hash'),
    billLinkCreatedAt: timestamp('bill_link_created_at', { withTimezone: true }),
    billLinkExpiresAt: timestamp('bill_link_expires_at', { withTimezone: true }),
    billLinkRevokedAt: timestamp('bill_link_revoked_at', { withTimezone: true }),
    /** Gapless admission number per FY (0054). */
    admissionNumber: text('admission_number'),
    urgency: text('urgency').$type<'emergency' | 'same_day' | 'planned'>().default('same_day'),
    advisedWardKind: text('advised_ward_kind').$type<'general' | 'special' | 'hdu' | 'icu'>(),
    estimatedStayDays: smallint('estimated_stay_days'),
    receptionNotes: text('reception_notes'),
    referringDoctorName: text('referring_doctor_name'),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    arrivalBackdateReason: text('arrival_backdate_reason'),
    isMlc: boolean('is_mlc').notNull().default(false),
    mlcNumber: text('mlc_number'),
    mlcCategory: text('mlc_category').$type<
      'rta' | 'assault' | 'poisoning' | 'snake_bite' | 'burns' | 'industrial' | 'hanging' | 'unnatural' | 'other'
    >(),
    mlcNarrative: text('mlc_narrative'),
    policeStationName: text('police_station_name'),
    policeIntimatedAt: timestamp('police_intimated_at', { withTimezone: true }),
    policeIntimationMode: text('police_intimation_mode').$type<'written_slip' | 'phone_call' | 'in_person_constable'>(),
    constableName: text('constable_name'),
    constableBuckleNo: text('constable_buckle_no'),
    mlcIntimationCopyUrl: text('mlc_intimation_copy_url'),
    firstReviewedAt: timestamp('first_reviewed_at', { withTimezone: true }),
    firstReviewedByUserId: uuid('first_reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    isIntakeComplete: boolean('is_intake_complete').notNull().default(false),
    intakeCompletedAt: timestamp('intake_completed_at', { withTimezone: true }),
    intakeCompletedByUserId: uuid('intake_completed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('admissions_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('admissions_tenant_encounter_key').on(
      t.hospitalId,
      t.id,
      t.encounterId,
      t.patientId,
    ),
    uniqueIndex('admissions_one_live_per_encounter')
      .on(t.encounterId)
      .where(sql`status <> 'cancelled'`),
    uniqueIndex('admissions_ipd_number_key')
      .on(t.hospitalId, t.ipdNumber)
      .where(sql`ipd_number is not null`),
    index('admissions_census_idx')
      .on(t.hospitalId, t.branchId, t.status)
      .where(sql`status in ('awaiting_bed', 'admitted', 'discharge_ready')`),
    index('admissions_arrived_idx')
      .on(t.hospitalId, t.arrivedAt)
      .where(sql`arrived_at is not null`),
    foreignKey({
      name: 'admissions_encounter_fk',
      columns: [t.hospitalId, t.encounterId, t.patientId],
      foreignColumns: [encounters.hospitalId, encounters.id, encounters.patientId],
    }).onDelete('cascade'),
  ],
);

/** Which bed, from when to when. Closed once by trigger; never edited. */
export const bedAssignments = pgTable(
  'bed_assignments',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').notNull(),
    bedId: uuid('bed_id').notNull(),
    fromAt: timestamp('from_at', { withTimezone: true }).notNull().defaultNow(),
    toAt: timestamp('to_at', { withTimezone: true }),
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bed_assignments_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('bed_assignments_bed_occupied').on(t.bedId).where(sql`to_at is null`),
    uniqueIndex('bed_assignments_admission_current')
      .on(t.admissionId)
      .where(sql`to_at is null`),
    foreignKey({
      name: 'bed_assignments_admission_fk',
      columns: [t.hospitalId, t.admissionId],
      foreignColumns: [admissions.hospitalId, admissions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bed_assignments_bed_fk',
      columns: [t.hospitalId, t.bedId],
      foreignColumns: [beds.hospitalId, beds.id],
    }),
  ],
);

/** Clinical. What was given or used at the bedside. Void-only by trigger. */
export const careEntries = pgTable(
  'care_entries',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    medicineId: uuid('medicine_id'),
    chargeItemId: uuid('charge_item_id'),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    clientId: uuid('client_id').notNull(),
    /** Where the entry was made from (0042): a ward tablet or the person's own device. */
    recordedChannel: text('recorded_channel').$type<'personal' | 'ward_device'>(),
    recordedDeviceId: text('recorded_device_id'),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [
    uniqueIndex('care_entries_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('care_entries_client_key').on(t.hospitalId, t.clientId),
    index('care_entries_admission_idx')
      .on(t.admissionId, t.occurredAt)
      .where(sql`voided_at is null`),
    foreignKey({
      name: 'care_entries_admission_fk',
      columns: [t.hospitalId, t.admissionId, t.encounterId, t.patientId],
      foreignColumns: [
        admissions.hospitalId,
        admissions.id,
        admissions.encounterId,
        admissions.patientId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'care_entries_medicine_fk',
      columns: [t.hospitalId, t.medicineId],
      foreignColumns: [medicines.hospitalId, medicines.id],
    }),
    foreignKey({
      name: 'care_entries_charge_item_fk',
      columns: [t.hospitalId, t.chargeItemId],
      foreignColumns: [chargeItems.hospitalId, chargeItems.id],
    }),
  ],
);

/** Who pays for the encounter. Billing data, not clinical. Void-only. */
export const encounterPayers = pgTable(
  'encounter_payers',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: payerKind('kind').notNull(),
    payerName: text('payer_name'),
    policyNumber: text('policy_number'),
    preauthAmountPaise: integer('preauth_amount_paise'),
    approvedAmountPaise: integer('approved_amount_paise'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [
    uniqueIndex('encounter_payers_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('encounter_payers_one_active')
      .on(t.encounterId)
      .where(sql`voided_at is null`),
    foreignKey({
      name: 'encounter_payers_encounter_fk',
      columns: [t.hospitalId, t.encounterId, t.patientId],
      foreignColumns: [encounters.hospitalId, encounters.id, encounters.patientId],
    }).onDelete('cascade'),
  ],
);

/** Gap-free document numbers per hospital, kind and financial year (0033). */
export const documentSequences = pgTable(
  'document_sequences',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    lastNumber: integer('last_number').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('document_sequences_key').on(t.hospitalId, t.kind, t.fiscalYear)],
);

/* ------------------------------------------- IPD sheets plan (0041 onward) */

/**
 * Each module's state for one hospital (ADR-021). A missing row means the
 * module's default from lib/modules/registry.ts; the registry, not this table,
 * is the list of modules.
 */
export const hospitalFeatures = pgTable(
  'hospital_features',
  {
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    moduleId: text('module_id').notNull(),
    state: text('state').$type<'on' | 'read_only' | 'off'>().notNull(),
    rolloutScope: jsonb('rollout_scope')
      .$type<{ all: true } | { all: false; wardIds: string[] }>()
      .notNull()
      .default({ all: true }),
    stage: text('stage').$type<'observe' | 'warn' | 'enforce'>().notNull().default('observe'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.hospitalId, t.moduleId] })],
);

/** A staff member accepted a policy, such as the monitoring notice. Append-only (0041). */
export const policyAcknowledgements = pgTable(
  'policy_acknowledgements',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    policyKey: text('policy_key').notNull(),
    policyVersion: text('policy_version').notNull(),
    locale: text('locale').$type<'en' | 'mr' | 'hi'>().notNull(),
    channel: text('channel').$type<'ward_device' | 'personal'>(),
    deviceId: text('device_id'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('policy_acknowledgements_once').on(t.hospitalId, t.userId, t.policyKey, t.policyVersion)],
);

/**
 * Shared ward tablets (0042, ADR-022). Pending until a tablet types its
 * one-time code; enrolled from then until revoked or unused for 90 days. The
 * code and the device cookie are stored only as hashes.
 */
export const wardDevices = pgTable(
  'ward_devices',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    name: text('name').notNull(),
    /** Empty: every ward of the branch. */
    wardIds: uuid('ward_ids').array().notNull().default(sql`'{}'`),
    enrolCodeHash: text('enrol_code_hash'),
    enrolExpiresAt: timestamp('enrol_expires_at', { withTimezone: true }),
    tokenHash: text('token_hash').unique(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    failedPins: integer('failed_pins').notNull().default(0),
    failedWindowStartedAt: timestamp('failed_window_started_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('ward_devices_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('ward_devices_enrol_code_key').on(t.enrolCodeHash).where(sql`enrol_code_hash is not null`),
    foreignKey({
      name: 'ward_devices_branch_fk',
      columns: [t.hospitalId, t.branchId],
      foreignColumns: [branches.hospitalId, branches.id],
    }).onDelete('cascade'),
  ],
);

/** One PIN per person per hospital, scrypt-hashed, with its own lock-out (0042). */
export const staffPins = pgTable(
  'staff_pins',
  {
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pinHash: text('pin_hash').notNull(),
    failedCount: integer('failed_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.hospitalId, t.userId] })],
);

/**
 * The nursing T.P.R. chart (0043): one row per line of the paper chart.
 * Partitioned by month on `observed_at` in the database (Drizzle does not need
 * to know); the primary key and the client-id key therefore include it.
 * Clinical and void-only, like care_entries.
 */
export const chartEntries = pgTable(
  'chart_entries',
  {
    id: uuid('id').notNull().defaultRandom(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    templateKey: text('template_key').notNull().default('general_tpr'),
    templateVersion: smallint('template_version').notNull().default(1),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    pulse: smallint('pulse'),
    bpSystolic: smallint('bp_systolic'),
    bpDiastolic: smallint('bp_diastolic'),
    spo2: smallint('spo2'),
    /** °F × 10. */
    tempFTenths: smallint('temp_f_tenths'),
    bslMgDl: smallint('bsl_mg_dl'),
    respRate: smallint('resp_rate'),
    abdGirthCm: smallint('abd_girth_cm'),
    onOxygen: boolean('on_oxygen'),
    consciousness: text('consciousness').$type<'A' | 'C' | 'V' | 'P' | 'U'>(),
    urineMl: integer('urine_ml'),
    drainMl: integer('drain_ml'),
    rtAspirateMl: integer('rt_aspirate_ml'),
    oralMl: integer('oral_ml'),
    ivMl: integer('iv_ml'),
    note: text('note'),
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    source: text('source').$type<'chart' | 'doctor_note'>().notNull().default('chart'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    recordedChannel: text('recorded_channel').$type<'personal' | 'ward_device'>(),
    recordedDeviceId: text('recorded_device_id'),
    recordedSessionId: uuid('recorded_session_id'),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.observedAt] }),
    uniqueIndex('chart_entries_client_key').on(t.hospitalId, t.clientId, t.observedAt),
    index('chart_entries_admission_idx').on(t.admissionId, t.observedAt).where(sql`voided_at is null`),
    index('chart_entries_branch_idx').on(t.hospitalId, t.branchId, t.observedAt),
  ],
);

/** Raw bytes (hashes, signatures), as Buffers. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * The evidence log (0044, IPD sheets plan §7.6): append-only, partitioned by
 * month on `recorded_at`, filled by capture triggers on the source tables. The
 * database gives each row its `seq` and `row_hash`; never insert either.
 * No foreign keys: the evidence outlives the rows it describes.
 */
export const acctEvents = pgTable(
  'acct_events',
  {
    seq: bigint('seq', { mode: 'number' }).notNull(),
    hospitalId: uuid('hospital_id').notNull(),
    branchId: uuid('branch_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    witnessUserId: uuid('witness_user_id'),
    channel: text('channel'),
    deviceId: text('device_id'),
    sessionId: uuid('session_id'),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    rowHash: bytea('row_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seq, t.recordedAt] }),
    index('acct_events_hospital_seq_idx').on(t.hospitalId, t.seq),
    index('acct_events_actor_idx').on(t.hospitalId, t.actorUserId, t.seq),
    index('acct_events_object_idx').on(t.hospitalId, t.objectId).where(sql`object_id is not null`),
  ],
);

/** One hourly seal of a hospital's events: Merkle root, chained, signed, anchored. */
export const acctDigests = pgTable(
  'acct_digests',
  {
    hospitalId: uuid('hospital_id').notNull(),
    digestNo: bigint('digest_no', { mode: 'number' }).notNull(),
    seqFrom: bigint('seq_from', { mode: 'number' }).notNull(),
    seqTo: bigint('seq_to', { mode: 'number' }).notNull(),
    eventCount: integer('event_count').notNull(),
    firstRecordedAt: timestamp('first_recorded_at', { withTimezone: true }).notNull(),
    lastRecordedAt: timestamp('last_recorded_at', { withTimezone: true }).notNull(),
    merkleRoot: bytea('merkle_root').notNull(),
    prevHash: bytea('prev_hash').notNull(),
    digestHash: bytea('digest_hash').notNull(),
    signature: bytea('signature'),
    keyId: text('key_id'),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
    anchoredAt: timestamp('anchored_at', { withTimezone: true }),
    anchorRef: text('anchor_ref'),
  },
  (t) => [primaryKey({ columns: [t.hospitalId, t.digestNo] })],
);

/** Each check of the evidence log and what it found (codes and digest numbers only). */
export const acctVerifications = pgTable(
  'acct_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hospitalId: uuid('hospital_id').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    ranByUserId: uuid('ran_by_user_id'),
    source: text('source').$type<'sweep' | 'manual' | 'cli'>().notNull(),
    ok: boolean('ok').notNull(),
    fromDigest: bigint('from_digest', { mode: 'number' }),
    toDigest: bigint('to_digest', { mode: 'number' }),
    digestsChecked: integer('digests_checked').notNull(),
    eventsChecked: integer('events_checked').notNull(),
    problems: jsonb('problems').$type<{ code: string; digestNo: number | null; count?: number }[]>().notNull().default([]),
  },
  (t) => [index('acct_verifications_hospital_idx').on(t.hospitalId, t.ranAt)],
);

/* ---------------------------------------------------------------- stock (0046) */

/**
 * Risk classes and count-first stock for them (IPD sheets plan B4a, §7.3).
 * The ledger is append-only and the only way a balance changes: a trigger in
 * the database applies each movement to `stock_balances`, which the app role
 * can read but not write. See drizzle/0046_stock.sql.
 */
export const riskClasses = pgTable(
  'risk_classes',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<'ndps' | 'psychotropic' | 'high_value' | 'other'>().notNull(),
    countEvery: text('count_every').$type<'daily' | 'weekly'>().notNull().default('daily'),
    /** Gives of this class need a witness (0048). NDPS always do, whatever this says. */
    witnessAtGive: boolean('witness_at_give').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('risk_classes_tenant_key').on(t.hospitalId, t.id)],
);

export const medicineRiskClasses = pgTable(
  'medicine_risk_classes',
  {
    hospitalId: uuid('hospital_id').notNull(),
    medicineId: uuid('medicine_id').notNull(),
    riskClassId: uuid('risk_class_id').notNull(),
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.hospitalId, t.medicineId] })],
);

export const stockLocations = pgTable(
  'stock_locations',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<'main_store' | 'ward_store' | 'lab_store' | 'crash_cart' | 'other'>().notNull(),
    wardId: uuid('ward_id'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('stock_locations_tenant_key').on(t.hospitalId, t.id)],
);

export const stockBatches = pgTable(
  'stock_batches',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    medicineId: uuid('medicine_id').notNull(),
    batchNo: text('batch_no').notNull(),
    expiryDate: date('expiry_date').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('stock_batches_tenant_key').on(t.hospitalId, t.id)],
);

export const purchaseReceipts = pgTable(
  'purchase_receipts',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    locationId: uuid('location_id').notNull(),
    supplierName: text('supplier_name').notNull(),
    invoiceNo: text('invoice_no').notNull(),
    invoiceDate: date('invoice_date').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    receivedByUserId: uuid('received_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('purchase_receipts_client_key').on(t.hospitalId, t.clientId)],
);

export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    fromLocationId: uuid('from_location_id').notNull(),
    toLocationId: uuid('to_location_id').notNull(),
    status: text('status').$type<'in_transit' | 'received'>().notNull().default('in_transit'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    sentByUserId: uuid('sent_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedByUserId: uuid('received_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('stock_transfers_client_key').on(t.hospitalId, t.clientId)],
);

export const stockTransferLines = pgTable('stock_transfer_lines', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  transferId: uuid('transfer_id').notNull(),
  medicineId: uuid('medicine_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  quantitySent: integer('quantity_sent').notNull(),
  quantityReceived: integer('quantity_received'),
});

export const stockCounts = pgTable(
  'stock_counts',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    locationId: uuid('location_id').notNull(),
    status: text('status').$type<'counting' | 'submitted' | 'approved' | 'cancelled'>().notNull().default('counting'),
    countedByUserId: uuid('counted_by_user_id')
      .notNull()
      .references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    countedByMover: boolean('counted_by_mover').notNull().default(false),
    movedDuringCount: boolean('moved_during_count').notNull().default(false),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('stock_counts_client_key').on(t.hospitalId, t.clientId)],
);

export const stockCountLines = pgTable('stock_count_lines', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  countId: uuid('count_id').notNull(),
  medicineId: uuid('medicine_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  countedQty: integer('counted_qty'),
  bookQty: integer('book_qty'),
  usedAllocated: integer('used_allocated').notNull().default(0),
  variance: integer('variance'),
  reasonCode: text('reason_code'),
  reasonText: text('reason_text'),
  explainedByUserId: uuid('explained_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

export const stockCountManualUse = pgTable(
  'stock_count_manual_use',
  {
    hospitalId: uuid('hospital_id').notNull(),
    countId: uuid('count_id').notNull(),
    medicineId: uuid('medicine_id').notNull(),
    usedQty: integer('used_qty').notNull(),
  },
  (t) => [primaryKey({ columns: [t.countId, t.medicineId] })],
);

export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    medicineId: uuid('medicine_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    quantity: integer('quantity').notNull(),
    reasonCode: text('reason_code')
      .$type<'expired' | 'damaged' | 'returned_to_supplier' | 'found' | 'entry_error' | 'other'>()
      .notNull(),
    reasonText: text('reason_text'),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    clientId: uuid('client_id').notNull(),
  },
  (t) => [uniqueIndex('stock_adjustments_client_key').on(t.hospitalId, t.clientId)],
);

export const stockLedger = pgTable('stock_ledger', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull(),
  medicineId: uuid('medicine_id').notNull(),
  batchId: uuid('batch_id').notNull(),
  kind: text('kind')
    .$type<'receive' | 'transfer_out' | 'transfer_in' | 'give' | 'waste' | 'return' | 'adjust' | 'count_variance' | 'reversal'>()
    .notNull(),
  quantity: integer('quantity').notNull(),
  /** 'mar': posted by the treatment card (0050), with a reference key per batch row. */
  source: text('source').$type<'app' | 'manual_register' | 'mar'>().notNull().default('app'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  receiptId: uuid('receipt_id'),
  transferId: uuid('transfer_id'),
  countId: uuid('count_id'),
  adjustmentId: uuid('adjustment_id'),
  referenceKey: text('reference_key'),
});

/** Kept by the ledger's trigger; read-only to the app. */
export const stockBalances = pgTable(
  'stock_balances',
  {
    hospitalId: uuid('hospital_id').notNull(),
    locationId: uuid('location_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    medicineId: uuid('medicine_id').notNull(),
    quantity: integer('quantity').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.hospitalId, t.locationId, t.batchId] })],
);

/* =========================================================================
   IPD Doctor Rounding Cockpit & eMAR Foundation (SPEC-IPD-EMAR-001)
   ========================================================================= */

export const ipdClinicalRounds = pgTable(
  'ipd_clinical_rounds',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'restrict' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    evaluationNotes: text('evaluation_notes').notNull(),
    status: text('status').$type<'draft' | 'signed'>().notNull(),
    version: integer('version').notNull().default(1),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ipd_clinical_rounds_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('ipd_clinical_rounds_tenant_admission_key').on(t.hospitalId, t.admissionId, t.id),
    foreignKey({
      columns: [t.hospitalId, t.admissionId, t.encounterId, t.patientId],
      foreignColumns: [admissions.hospitalId, admissions.id, admissions.encounterId, admissions.patientId],
      name: 'ipd_clinical_rounds_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.hospitalId, t.doctorId],
      foreignColumns: [doctors.hospitalId, doctors.id],
      name: 'ipd_clinical_rounds_doctor_fk',
    }).onDelete('restrict'),
    check(
      'ipd_clinical_rounds_signed_chk',
      sql`(status = 'draft' AND signed_at IS NULL) OR (status = 'signed' AND signed_at IS NOT NULL)`,
    ),
  ],
);

export const ipdMedicationOrders = pgTable(
  'ipd_medication_orders',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    orderChainId: uuid('order_chain_id').notNull(),

    medicineId: uuid('medicine_id').notNull(),
    medicineName: text('medicine_name').notNull(),
    strength: text('strength'),
    form: text('form'),

    doseAmount: numeric('dose_amount', { precision: 8, scale: 2 }).notNull(),
    doseUnit: text('dose_unit').notNull(),
    route: text('route')
      .$type<
        | 'oral'
        | 'iv_push'
        | 'iv_piggyback'
        | 'im'
        | 'sc'
        | 'nebulization'
        | 'topical'
        | 'inhalation'
        | 'sublingual'
        | 'rectal'
        | 'ophthalmic'
        | 'otic'
      >()
      .notNull(),

    scheduleType: text('schedule_type').$type<'scheduled' | 'prn' | 'stat'>().notNull(),
    frequencyCode: text('frequency_code'),
    scheduleTimes: jsonb('schedule_times').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isPrn: boolean('is_prn').notNull().default(false),
    prnIndication: text('prn_indication'),
    prnMaxDailyDoses: smallint('prn_max_daily_doses'),
    prnMaxDailyQuantity: numeric('prn_max_daily_quantity', { precision: 8, scale: 2 }),
    prnMaxDailyUnit: text('prn_max_daily_unit'),
    prnMinIntervalHours: smallint('prn_min_interval_hours'),
    specialInstructions: text('special_instructions'),

    origin: text('origin').$type<'inpatient_order' | 'home_medication'>().notNull().default('inpatient_order'),
    patientSupplied: boolean('patient_supplied').notNull().default(false),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    durationDays: smallint('duration_days'),

    status: text('status')
      .$type<'draft' | 'active' | 'on_hold' | 'discontinued' | 'completed' | 'superseded' | 'voided'>()
      .notNull(),

    supersedesOrderId: uuid('supersedes_order_id'),
    supersededByOrderId: uuid('superseded_by_order_id'),
    orderSetId: uuid('order_set_id'),
    orderSetVersion: integer('order_set_version'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    voidReason: text('void_reason'),

    prescriberDoctorId: uuid('prescriber_doctor_id').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    roundNoteId: uuid('round_note_id'),

    isVerbal: boolean('is_verbal').notNull().default(false),
    verbalOrderStatus: text('verbal_order_status')
      .$type<'none' | 'pending_cosign' | 'cosigned' | 'rejected' | 'modified'>()
      .notNull()
      .default('none'),
    verbalDoctorName: text('verbal_doctor_name'),
    verbalClinicalRationale: text('verbal_clinical_rationale'),
    cosignedByDoctorId: uuid('cosigned_by_doctor_id').references(() => doctors.id, { onDelete: 'set null' }),
    cosignedAt: timestamp('cosigned_at', { withTimezone: true }),
    cosignNotes: text('cosign_notes'),

    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ipd_med_orders_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('ipd_med_orders_tenant_admission_key').on(t.hospitalId, t.admissionId, t.id),
    index('ipd_med_orders_active_idx')
      .on(t.hospitalId, t.admissionId, t.status)
      .where(sql`status IN ('active', 'on_hold')`),
    index('ipd_med_orders_chain_idx').on(t.hospitalId, t.orderChainId),
    foreignKey({
      columns: [t.hospitalId, t.admissionId, t.encounterId, t.patientId],
      foreignColumns: [admissions.hospitalId, admissions.id, admissions.encounterId, admissions.patientId],
      name: 'ipd_med_orders_tenant_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.hospitalId, t.medicineId],
      foreignColumns: [medicines.hospitalId, medicines.id],
      name: 'ipd_med_orders_medicine_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.hospitalId, t.prescriberDoctorId],
      foreignColumns: [doctors.hospitalId, doctors.id],
      name: 'ipd_med_orders_doctor_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.hospitalId, t.admissionId, t.roundNoteId],
      foreignColumns: [ipdClinicalRounds.hospitalId, ipdClinicalRounds.admissionId, ipdClinicalRounds.id],
      name: 'ipd_med_orders_round_note_fk',
    }).onDelete('restrict'),
    check(
      'ipd_med_orders_signed_chk',
      sql`(status = 'draft' AND signed_at IS NULL) OR (status != 'draft' AND signed_at IS NOT NULL)`,
    ),
    check(
      'ipd_med_orders_superseded_chk',
      sql`(status = 'superseded' AND superseded_by_order_id IS NOT NULL) OR (status != 'superseded' AND superseded_by_order_id IS NULL)`,
    ),
    check(
      'ipd_med_orders_void_chk',
      sql`(status = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL) OR (status != 'voided' AND voided_at IS NULL AND void_reason IS NULL)`,
    ),
    check(
      'ipd_med_orders_prn_chk',
      sql`(is_prn = false AND prn_indication IS NULL) OR (is_prn = true AND prn_indication IS NOT NULL AND prn_max_daily_doses IS NOT NULL)`,
    ),
    check(
      'ipd_med_orders_schedule_chk',
      sql`(schedule_type = 'prn' AND is_prn = true) OR (schedule_type != 'prn' AND is_prn = false)`,
    ),
  ],
);

export const ipdMedicationOrderActions = pgTable(
  'ipd_medication_order_actions',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    action: text('action')
      .$type<'sign' | 'hold' | 'resume' | 'discontinue' | 'modify' | 'renew' | 'expire' | 'void'>()
      .notNull(),
    reason: text('reason'),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    doctorId: uuid('doctor_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.hospitalId, t.orderId],
      foreignColumns: [ipdMedicationOrders.hospitalId, ipdMedicationOrders.id],
      name: 'ipd_order_actions_order_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.hospitalId, t.doctorId],
      foreignColumns: [doctors.hospitalId, doctors.id],
      name: 'ipd_order_actions_doctor_fk',
    }).onDelete('restrict'),
    check(
      'ipd_order_actions_reason_chk',
      sql`action IN ('sign', 'expire') OR (reason IS NOT NULL AND char_length(reason) >= 3)`,
    ),
  ],
);

export const ipdMedicationAdministrations = pgTable(
  'ipd_medication_administrations',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').notNull(),
    orderId: uuid('order_id').notNull(),
    orderChainId: uuid('order_chain_id').notNull(),
    clientId: uuid('client_id').notNull(),

    scheduledTime: timestamp('scheduled_time', { withTimezone: true }),
    actualTime: timestamp('actual_time', { withTimezone: true }),
    decisionTime: timestamp('decision_time', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),

    outcome: text('outcome').$type<'administered' | 'omitted' | 'refused' | 'held'>().notNull(),
    doseGiven: text('dose_given'),
    doseAmountNumeric: numeric('dose_amount_numeric', { precision: 8, scale: 2 }),
    routeGiven: text('route_given'),
    nonAdminReason: text('non_admin_reason'),
    clinicalNote: text('clinical_note'),

    nurseUserId: uuid('nurse_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    recordedChannel: text('recorded_channel').$type<'personal' | 'ward_device'>(),
    recordedDeviceId: text('recorded_device_id'),

    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    voidReason: text('void_reason'),
    correctsAdministrationId: uuid('corrects_administration_id'),
    correctedByAdministrationId: uuid('corrected_by_administration_id'),

    careEntryId: uuid('care_entry_id'),
    stockLedgerId: uuid('stock_ledger_id'),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ipd_med_admin_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('ipd_med_admin_client_key').on(t.hospitalId, t.clientId),
    uniqueIndex('ipd_med_admin_scheduled_occurrence_key')
      .on(t.hospitalId, t.orderId, t.scheduledTime)
      .where(sql`voided_at IS NULL AND scheduled_time IS NOT NULL`),
    index('ipd_med_admin_admission_time_idx')
      .on(t.hospitalId, t.admissionId, t.recordedAt)
      .where(sql`voided_at IS NULL`),
    index('ipd_med_admin_chain_time_idx')
      .on(t.hospitalId, t.orderChainId, t.actualTime)
      .where(sql`voided_at IS NULL AND outcome = 'administered'`),
    foreignKey({
      columns: [t.hospitalId, t.admissionId, t.orderId],
      foreignColumns: [ipdMedicationOrders.hospitalId, ipdMedicationOrders.admissionId, ipdMedicationOrders.id],
      name: 'ipd_med_admin_order_admission_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.hospitalId, t.correctsAdministrationId],
      foreignColumns: [t.hospitalId, t.id],
      name: 'ipd_med_admin_corrects_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.hospitalId, t.correctedByAdministrationId],
      foreignColumns: [t.hospitalId, t.id],
      name: 'ipd_med_admin_corrected_by_fk',
    }).onDelete('restrict'),
    check('ipd_med_admin_void_chk', sql`(voided_at IS NULL) = (void_reason IS NULL)`),
    check(
      'ipd_med_admin_timing_chk',
      sql`(outcome = 'administered' AND actual_time IS NOT NULL AND decision_time IS NULL AND non_admin_reason IS NULL) OR (outcome != 'administered' AND actual_time IS NULL AND decision_time IS NOT NULL AND non_admin_reason IS NOT NULL)`,
    ),
  ],
);

export const ipdAllergyAssessments = pgTable(
  'ipd_allergy_assessments',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    status: text('status').$type<'unreviewed' | 'nkda' | 'allergies_documented'>().notNull(),
    allergens: jsonb('allergens')
      .$type<Array<{ substance: string; reaction?: string; severity?: 'mild' | 'moderate' | 'severe' }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isCurrent: boolean('is_current').notNull().default(true),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ipd_allergy_current_idx').on(t.hospitalId, t.admissionId).where(sql`is_current = true`),
    foreignKey({
      columns: [t.hospitalId, t.admissionId, t.encounterId, t.patientId],
      foreignColumns: [admissions.hospitalId, admissions.id, admissions.encounterId, admissions.patientId],
      name: 'ipd_allergy_assessments_tenant_fk',
    }).onDelete('restrict'),
    check(
      'ipd_allergy_review_chk',
      sql`(status = 'unreviewed' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL) OR (status IN ('nkda', 'allergies_documented') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)`,
    ),
  ],
);

export const ipdOrderSets = pgTable(
  'ipd_order_sets',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    description: text('description'),
    version: integer('version').notNull().default(1),
    status: text('status').$type<'draft' | 'pending_review' | 'approved' | 'deprecated'>().notNull(),
    approvedByDoctorId: uuid('approved_by_doctor_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ipd_order_sets_hospital_id_key').on(t.hospitalId, t.id),
    uniqueIndex('ipd_order_sets_hospital_code_ver').on(t.hospitalId, t.code, t.version),
    foreignKey({
      columns: [t.hospitalId, t.approvedByDoctorId],
      foreignColumns: [doctors.hospitalId, doctors.id],
      name: 'ipd_order_sets_doctor_fk',
    }).onDelete('restrict'),
    check(
      'ipd_order_sets_approved_chk',
      sql`(status IN ('draft', 'pending_review') AND approved_by_doctor_id IS NULL AND approved_at IS NULL) OR (status IN ('approved', 'deprecated') AND approved_by_doctor_id IS NOT NULL AND approved_at IS NOT NULL)`,
    ),
  ],
);

export const ipdOrderSetItems = pgTable(
  'ipd_order_set_items',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    orderSetId: uuid('order_set_id').notNull(),
    medicineId: uuid('medicine_id').notNull(),
    defaultDoseAmount: numeric('default_dose_amount', { precision: 8, scale: 2 }).notNull(),
    defaultDoseUnit: text('default_dose_unit').notNull(),
    defaultRoute: text('default_route')
      .$type<
        | 'oral'
        | 'iv_push'
        | 'iv_piggyback'
        | 'im'
        | 'sc'
        | 'nebulization'
        | 'topical'
        | 'inhalation'
        | 'sublingual'
        | 'rectal'
        | 'ophthalmic'
        | 'otic'
      >()
      .notNull(),
    defaultScheduleType: text('default_schedule_type').$type<'scheduled' | 'prn' | 'stat'>().notNull(),
    defaultFrequencyCode: text('default_frequency_code'),
    defaultScheduleTimes: jsonb('default_schedule_times').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    defaultDurationDays: smallint('default_duration_days'),
    defaultInstructions: text('default_instructions'),
    sortOrder: smallint('sort_order').notNull().default(0),
  },
  (t) => [
    index('ipd_order_set_items_set_idx').on(t.hospitalId, t.orderSetId, t.sortOrder),
    foreignKey({
      columns: [t.hospitalId, t.orderSetId],
      foreignColumns: [ipdOrderSets.hospitalId, ipdOrderSets.id],
      name: 'ipd_order_set_items_set_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.hospitalId, t.medicineId],
      foreignColumns: [medicines.hospitalId, medicines.id],
      name: 'ipd_order_set_items_medicine_fk',
    }).onDelete('restrict'),
  ],
);

export const ipdEmarIntegrationOutbox = pgTable(
  'ipd_emar_integration_outbox',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    administrationId: uuid('administration_id').notNull(),
    integrationType: text('integration_type').$type<'billing' | 'stock'>().notNull(),
    eventType: text('event_type').$type<'administer' | 'void' | 'correction'>().notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status')
      .$type<'pending' | 'pending_pricing' | 'processing' | 'processed' | 'failed' | 'skipped'>()
      .notNull(),
    attempts: integer('attempts').notNull().default(0),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastError: text('last_error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ipd_emar_outbox_event_key').on(t.hospitalId, t.administrationId, t.integrationType, t.eventType),
    index('ipd_emar_outbox_pending_idx')
      .on(t.hospitalId, t.status, t.scheduledFor)
      .where(sql`status = 'pending'`),
    foreignKey({
      columns: [t.hospitalId, t.administrationId],
      foreignColumns: [ipdMedicationAdministrations.hospitalId, ipdMedicationAdministrations.id],
      name: 'ipd_emar_outbox_admin_fk',
    }).onDelete('restrict'),
  ],
);

export type IpdClinicalRoundRow = typeof ipdClinicalRounds.$inferSelect;
export type NewIpdClinicalRound = typeof ipdClinicalRounds.$inferInsert;

export type IpdMedicationOrderRow = typeof ipdMedicationOrders.$inferSelect;
export type NewIpdMedicationOrder = typeof ipdMedicationOrders.$inferInsert;

export type IpdMedicationOrderActionRow = typeof ipdMedicationOrderActions.$inferSelect;
export type NewIpdMedicationOrderAction = typeof ipdMedicationOrderActions.$inferInsert;

export type IpdMedicationAdministrationRow = typeof ipdMedicationAdministrations.$inferSelect;
export type NewIpdMedicationAdministration = typeof ipdMedicationAdministrations.$inferInsert;

export type IpdAllergyAssessmentRow = typeof ipdAllergyAssessments.$inferSelect;
export type NewIpdAllergyAssessment = typeof ipdAllergyAssessments.$inferInsert;

export type IpdOrderSetRow = typeof ipdOrderSets.$inferSelect;
export type NewIpdOrderSet = typeof ipdOrderSets.$inferInsert;

export type IpdOrderSetItemRow = typeof ipdOrderSetItems.$inferSelect;
export type NewIpdOrderSetItem = typeof ipdOrderSetItems.$inferInsert;

export type IpdEmarIntegrationOutboxRow = typeof ipdEmarIntegrationOutbox.$inferSelect;
export type NewIpdEmarIntegrationOutbox = typeof ipdEmarIntegrationOutbox.$inferInsert;

export type SelectIpdMedicationOrder = IpdMedicationOrderRow;
export type InsertIpdMedicationOrder = NewIpdMedicationOrder;
export type SelectIpdMedicationAdministration = IpdMedicationAdministrationRow;
export type InsertIpdMedicationAdministration = NewIpdMedicationAdministration;
export type SelectIpdEmarIntegrationOutbox = IpdEmarIntegrationOutboxRow;
export type InsertIpdEmarIntegrationOutbox = NewIpdEmarIntegrationOutbox;
export type SelectIpdClinicalRound = IpdClinicalRoundRow;
export type InsertIpdClinicalRound = NewIpdClinicalRound;

/* ---------------------------------------------------- IPD Phase 2 Clinical Ledger & Tasks */

export const clinicalAuditLogs = pgTable(
  'clinical_audit_logs',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    recordId: text('record_id').notNull(),
    action: text('action').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    reason: text('reason'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('clinical_audit_logs_hospital_record_idx').on(t.hospitalId, t.tableName, t.recordId),
  ],
);

export const ipdClinicalTasks = pgTable(
  'ipd_clinical_tasks',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    status: text('status')
      .$type<'DUE' | 'OVERDUE' | 'GIVEN' | 'HELD' | 'REFUSED' | 'NOT_AVAILABLE' | 'MISSED'>()
      .notNull()
      .default('DUE'),
    actedByUserId: uuid('acted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    doseGiven: text('dose_given'),
    site: text('site'),
    reason: text('reason'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ipd_clinical_tasks_adm_idx').on(t.hospitalId, t.admissionId, t.scheduledAt),
    index('ipd_clinical_tasks_order_idx').on(t.hospitalId, t.orderId),
  ],
);

export const draftRounds = pgTable(
  'draft_rounds',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').notNull(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id'),
    soapS: text('soap_s'),
    soapO: text('soap_o'),
    soapA: text('soap_a'),
    soapP: text('soap_p'),
    body: text('body'),
    status: text('status').$type<'DRAFT' | 'SIGNED'>().notNull().default('DRAFT'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('draft_rounds_user_adm_idx').on(t.hospitalId, t.admissionId, t.authorUserId),
  ],
);

export const vitalsReadings = pgTable(
  'vitals_readings',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    temperatureF: numeric('temperature_f', { precision: 4, scale: 1 }),
    pulseBpm: integer('pulse_bpm'),
    bpSystolic: integer('bp_systolic'),
    bpDiastolic: integer('bp_diastolic'),
    respiratoryRate: integer('respiratory_rate'),
    spo2Percent: integer('spo2_percent'),
    painScore: integer('pain_score'),
    avpu: text('avpu').$type<'A' | 'V' | 'P' | 'U'>(),
    o2Support: text('o2_support'),
    news2Score: integer('news2_score'),
    abdGirthCm: numeric('abd_girth_cm', { precision: 5, scale: 1 }),
    bsl: integer('bsl'),
    scheduledSlot: text('scheduled_slot'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vitals_readings_adm_idx').on(t.hospitalId, t.admissionId, t.recordedAt),
  ],
);

export const intakeOutput = pgTable(
  'intake_output',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').$type<'ORAL' | 'IV' | 'URINE' | 'DRAIN' | 'RT_ASPIRATE'>().notNull(),
    ml: integer('ml').notNull(),
    notes: text('notes'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('intake_output_adm_idx').on(t.hospitalId, t.admissionId, t.recordedAt),
  ],
);

export type ClinicalAuditLogRow = typeof clinicalAuditLogs.$inferSelect;
export type NewClinicalAuditLog = typeof clinicalAuditLogs.$inferInsert;
export type IpdClinicalTaskRow = typeof ipdClinicalTasks.$inferSelect;
export type NewIpdClinicalTask = typeof ipdClinicalTasks.$inferInsert;
export type DraftRoundRow = typeof draftRounds.$inferSelect;
export type NewDraftRound = typeof draftRounds.$inferInsert;
export type VitalsReadingRow = typeof vitalsReadings.$inferSelect;
export type NewVitalsReading = typeof vitalsReadings.$inferInsert;
export type IntakeOutputRow = typeof intakeOutput.$inferSelect;
export type NewIntakeOutput = typeof intakeOutput.$inferInsert;

export const patientMeasurements = pgTable(
  'patient_measurements',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    weightKg: numeric('weight_kg', { precision: 5, scale: 2 }),
    heightCm: numeric('height_cm', { precision: 5, scale: 2 }),
    bmi: numeric('bmi', { precision: 4, scale: 1 }),
    measuredByUserId: uuid('measured_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('patient_measurements_adm_idx').on(t.hospitalId, t.admissionId, t.recordedAt),
    index('patient_measurements_patient_idx').on(t.hospitalId, t.patientId, t.recordedAt),
  ],
);

export type PatientMeasurementRow = typeof patientMeasurements.$inferSelect;
export type NewPatientMeasurement = typeof patientMeasurements.$inferInsert;

export const ipdAdmissionHomeMedications = pgTable(
  'ipd_admission_home_medications',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),
    medicineName: text('medicine_name').notNull(),
    dosage: text('dosage'),
    frequency: text('frequency'),
    lastTakenAt: text('last_taken_at'),
    reconciliationStatus: text('reconciliation_status')
      .$type<'continued' | 'stopped' | 'modified'>()
      .notNull()
      .default('continued'),
    reconciliationNotes: text('reconciliation_notes'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ipd_home_meds_adm_idx').on(t.hospitalId, t.admissionId),
  ],
);

export const ipdDischargeSummaries = pgTable(
  'ipd_discharge_summaries',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    dischargeType: text('discharge_type')
      .$type<'regular' | 'lama' | 'dama' | 'transfer' | 'death'>()
      .notNull()
      .default('regular'),
    status: text('status')
      .$type<'draft' | 'finalized'>()
      .notNull()
      .default('draft'),
    primaryDiagnosis: text('primary_diagnosis'),
    secondaryDiagnoses: text('secondary_diagnoses'),
    hospitalCourse: text('hospital_course'),
    conditionAtDischarge: text('condition_at_discharge'),
    investigationSummary: text('investigation_summary'),
    dischargeAdvice: text('discharge_advice'),
    dietAdvice: text('diet_advice'),
    urgentWarningSigns: text('urgent_warning_signs'),
    followUpDate: text('follow_up_date'),
    prescriberDoctorId: uuid('prescriber_doctor_id').references(() => doctors.id, { onDelete: 'set null' }),
    prescriberRegistrationNo: text('prescriber_registration_no'),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizedByUserId: uuid('finalized_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ipd_discharge_summaries_adm_idx').on(t.hospitalId, t.admissionId),
  ],
);

export const ipdTakeHomePrescriptions = pgTable(
  'ipd_take_home_prescriptions',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    dischargeSummaryId: uuid('discharge_summary_id')
      .notNull()
      .references(() => ipdDischargeSummaries.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),
    medicineName: text('medicine_name').notNull(),
    dosage: text('dosage').notNull(),
    route: text('route').notNull().default('oral'),
    frequency: text('frequency').notNull(),
    duration: text('duration'),
    instructions: text('instructions'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ipd_take_home_prescriptions_summary_idx').on(t.hospitalId, t.dischargeSummaryId),
  ],
);

export type IpdAdmissionHomeMedicationRow = typeof ipdAdmissionHomeMedications.$inferSelect;
export type NewIpdAdmissionHomeMedication = typeof ipdAdmissionHomeMedications.$inferInsert;
export type IpdDischargeSummaryRow = typeof ipdDischargeSummaries.$inferSelect;
export type NewIpdDischargeSummary = typeof ipdDischargeSummaries.$inferInsert;
export type IpdTakeHomePrescriptionRow = typeof ipdTakeHomePrescriptions.$inferSelect;
export type NewIpdTakeHomePrescription = typeof ipdTakeHomePrescriptions.$inferInsert;

export interface PharmacyReturnItem {
  medicineName: string;
  batchNumber?: string;
  dispensedQty: number;
  returnedQty: number;
  unitPricePaise?: number;
  creditPaise?: number;
  reason?: 'unconsumed' | 'discontinued' | 'changed_dose' | 'other';
}

export interface DischargeClearanceStatus {
  isMedicalCleared: boolean;
  isPharmacyCleared: boolean;
  isNursingCleared: boolean;
  isSummaryFinalized: boolean;
  isBillingCleared: boolean;
  canIssueGatePass: boolean;
  completedCount: number;
}

export const ipdDischargeClearances = pgTable(
  'ipd_discharge_clearances',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),

    // 1. Medical Clearance
    dischargeType: text('discharge_type')
      .$type<'regular' | 'lama' | 'dama' | 'transfer' | 'absconded' | 'death'>()
      .notNull()
      .default('regular'),
    clinicalFitAt: timestamp('clinical_fit_at', { withTimezone: true }),
    clinicalFitByUserId: uuid('clinical_fit_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clinicalStabilityNotes: text('clinical_stability_notes'),

    // 2. Pharmacy Clearance
    pharmacyReturnedAt: timestamp('pharmacy_returned_at', { withTimezone: true }),
    pharmacyReturnedByUserId: uuid('pharmacy_returned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    pharmacyCreditNoteNo: text('pharmacy_credit_note_no'),
    pharmacyCreditAmountPaise: integer('pharmacy_credit_amount_paise').default(0),
    pharmacyReturnItems: jsonb('pharmacy_return_items')
      .$type<PharmacyReturnItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    takeHomeDispensedAt: timestamp('take_home_dispensed_at', { withTimezone: true }),
    takeHomeCounseled: boolean('take_home_counseled').notNull().default(false),
    takeHomeCounselingNotes: text('take_home_counseling_notes'),

    // 3. Nursing Clearance
    nursingClearedAt: timestamp('nursing_cleared_at', { withTimezone: true }),
    nursingClearedByUserId: uuid('nursing_cleared_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ivCannulaRemoved: boolean('iv_cannula_removed').notNull().default(false),
    foleyCatheterRemoved: boolean('foley_catheter_removed').notNull().default(false),
    drainsRemoved: boolean('drains_removed').notNull().default(false),
    woundDressingDone: boolean('wound_dressing_done').notNull().default(false),
    belongingsAndReportsHandedOver: boolean('belongings_and_reports_handed_over').notNull().default(false),
    dischargeVitalsTaken: boolean('discharge_vitals_taken').notNull().default(false),
    nursingHandoverNotes: text('nursing_handover_notes'),

    // 4. Diagnostics Clearance
    diagnosticsClearedAt: timestamp('diagnostics_cleared_at', { withTimezone: true }),
    diagnosticsClearedByUserId: uuid('diagnostics_cleared_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    diagnosticsNotes: text('diagnostics_notes'),

    // 5. Billing & Gate Pass
    billingClearedAt: timestamp('billing_cleared_at', { withTimezone: true }),
    billingClearedByUserId: uuid('billing_cleared_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    gatePassNumber: text('gate_pass_number'),
    gatePassIssuedAt: timestamp('gate_pass_issued_at', { withTimezone: true }),
    gatePassIssuedByUserId: uuid('gate_pass_issued_by_user_id').references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ipd_discharge_clearances_tenant_adm_idx').on(t.hospitalId, t.admissionId),
  ],
);

export type IpdDischargeClearanceRow = typeof ipdDischargeClearances.$inferSelect;
export type NewIpdDischargeClearance = typeof ipdDischargeClearances.$inferInsert;

/**
 * Universal global medicine catalogue. Not tenant-scoped; available across all hospitals.
 */
export const globalMedicines = pgTable(
  'global_medicines',
  {
    id: id(),
    name: text('name').notNull(),
    genericName: text('generic_name'),
    strength: text('strength'),
    form: text('form'),
    category: text('category').notNull().default('General'),
    unit: text('unit').notNull().default('unit'),
    defaultRoute: text('default_route').default('oral'),
    defaultFrequency: text('default_frequency').default('OD'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('global_medicines_identity_key').on(
      sql`lower(${t.name})`,
      sql`coalesce(lower(${t.strength}), '')`,
      sql`coalesce(lower(${t.form}), '')`,
    ),
    index('global_medicines_name_idx').on(sql`lower(${t.name}) text_pattern_ops`),
    index('global_medicines_generic_idx').on(sql`lower(${t.genericName}) text_pattern_ops`),
  ],
);

export type GlobalMedicineRow = typeof globalMedicines.$inferSelect;
export type NewGlobalMedicine = typeof globalMedicines.$inferInsert;

/* ------------------------------------------------ test orders and follow-up (0047, C4a) */

/** A lab or room tests are done in, and the way to it in English, Marathi and Hindi. */
export const servicePoints = pgTable(
  'service_points',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    kind: text('kind').$type<ServicePointKind>().notNull().default('lab'),
    name: text('name').notNull(),
    nameMr: text('name_mr'),
    nameHi: text('name_hi'),
    floor: text('floor'),
    floorMr: text('floor_mr'),
    floorHi: text('floor_hi'),
    section: text('section'),
    sectionMr: text('section_mr'),
    sectionHi: text('section_hi'),
    clockFrom: text('clock_from').$type<ClockFrom>().notNull().default('order'),
    clockMinutes: smallint('clock_minutes').notNull().default(30),
    active: boolean('active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('service_points_tenant_key').on(t.hospitalId, t.id)],
);

/** Who works at a service point. Removing someone stamps the row; it is never deleted. */
export const servicePointStaff = pgTable('service_point_staff', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  servicePointId: uuid('service_point_id').notNull(),
  userId: uuid('user_id').notNull(),
  assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  removedByUserId: uuid('removed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  removedAt: timestamp('removed_at', { withTimezone: true }),
});

/** Clinical. One test for one patient; moves forward only (trigger). */
export const testOrders = pgTable(
  'test_orders',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    setting: text('setting').$type<'opd' | 'ipd'>().notNull(),
    appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
    admissionId: uuid('admission_id'),
    chargeItemId: uuid('charge_item_id').notNull(),
    testName: text('test_name').notNull(),
    servicePointId: uuid('service_point_id').notNull(),
    billItemId: uuid('bill_item_id').references(() => billItems.id, { onDelete: 'set null' }),
    careEntryId: uuid('care_entry_id'),
    clockFrom: text('clock_from').$type<ClockFrom>().notNull(),
    clockMinutes: smallint('clock_minutes').notNull(),
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull().defaultNow(),
    orderedByUserId: uuid('ordered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    taskRaisedAt: timestamp('task_raised_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    status: text('status').$type<TestOrderStatus>().notNull().default('ordered'),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    arrivedByUserId: uuid('arrived_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneByUserId: uuid('done_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    reportedByUserId: uuid('reported_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    closedReason: text('closed_reason').$type<ClosingOutcome>(),
    closedNote: text('closed_note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('test_orders_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('test_orders_client_key').on(t.hospitalId, t.clientId),
  ],
);

/** Clinical. Every call to a patient who has not arrived; append-only. */
export const testFollowUpCalls = pgTable('test_follow_up_calls', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull(),
  servicePointId: uuid('service_point_id').notNull(),
  outcome: text('outcome').$type<CallOutcome>().notNull(),
  note: text('note'),
  calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
  calledByUserId: uuid('called_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  callerAssigned: boolean('caller_assigned').notNull(),
  clientId: uuid('client_id').notNull(),
});

/* ------------------------------------------------ treatment card and MAR (0048, B3-min) */

/** Clinical. A line on the treatment card; countersigned, stopped or struck out once, never edited (trigger). */
export const treatmentOrders = pgTable(
  'treatment_orders',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').$type<'medicine' | 'instruction' | 'task'>().notNull(),
    medicineId: uuid('medicine_id'),
    description: text('description').notNull(),
    dose: text('dose'),
    route: text('route').$type<Route>(),
    frequency: text('frequency'),
    instructions: text('instructions'),
    /** Timing (0049, B3b): null on lines written before it, which are never due. */
    timingMode: text('timing_mode').$type<TimingMode>(),
    clockTimes: smallint('clock_times').array(),
    intervalMin: smallint('interval_min'),
    firstDueAt: timestamp('first_due_at', { withTimezone: true }),
    latePolicy: text('late_policy').$type<'keep' | 'shift'>(),
    taskKind: text('task_kind').$type<TaskKind>(),
    orderingDoctorId: uuid('ordering_doctor_id').notNull(),
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull().defaultNow(),
    enteredByUserId: uuid('entered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    transcribed: boolean('transcribed').notNull(),
    countersignedAt: timestamp('countersigned_at', { withTimezone: true }),
    countersignedByUserId: uuid('countersigned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    stoppedByUserId: uuid('stopped_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    stopReason: text('stop_reason'),
    /** B2 (0051): the allergies this line matched when written, and the doctor's reason for going ahead. */
    allergyMatches: text('allergy_matches').array(),
    allergyOverrideReason: text('allergy_override_reason'),
    recordedChannel: text('recorded_channel').$type<'personal' | 'ward_device'>(),
    recordedDeviceId: text('recorded_device_id'),
    recordedSessionId: uuid('recorded_session_id'),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [
    uniqueIndex('treatment_orders_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('treatment_orders_client_key').on(t.hospitalId, t.clientId),
  ],
);

/** Clinical. The doctor's case sheet (one per stay) and progress notes; struck out, never edited (0052). */
export const ipdNotes = pgTable(
  'ipd_notes',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').$type<NoteKind>().notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
    caseOf: text('case_of'),
    complaints: jsonb('complaints').$type<Complaint[]>().notNull().default([]),
    history: text('history'),
    pastHistory: text('past_history'),
    generalExam: jsonb('general_exam').$type<GeneralExam>().notNull().default({}),
    vitals: jsonb('vitals').$type<NoteVitals>().notNull().default({}),
    systemicExam: jsonb('systemic_exam').$type<SystemicExam>().notNull().default({}),
    progress: text('progress'),
    advice: text('advice'),
    seenByDoctorId: uuid('seen_by_doctor_id').notNull(),
    chartEntryId: uuid('chart_entry_id'),
    chartObservedAt: timestamp('chart_observed_at', { withTimezone: true }),
    writtenByUserId: uuid('written_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    transcribed: boolean('transcribed').notNull(),
    countersignedAt: timestamp('countersigned_at', { withTimezone: true }),
    countersignedByUserId: uuid('countersigned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedChannel: text('recorded_channel').$type<'personal' | 'ward_device'>(),
    recordedDeviceId: text('recorded_device_id'),
    recordedSessionId: uuid('recorded_session_id'),
    clientId: uuid('client_id').notNull(),
    ...voidColumns(),
  },
  (t) => [uniqueIndex('ipd_notes_client_key').on(t.hospitalId, t.clientId)],
);

/** Clinical. The discharge summary being written: one per stay, outside the record (0053). */
export const dischargeSummaryDrafts = pgTable(
  'discharge_summary_drafts',
  {
    hospitalId: uuid('hospital_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    content: jsonb('content').$type<SummaryContent>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [primaryKey({ columns: [t.hospitalId, t.admissionId] })],
);

/** Clinical. Each finalised version of a discharge summary; never edited, only countersigned (0053). */
export const dischargeSummaries = pgTable(
  'discharge_summaries',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    version: smallint('version').notNull(),
    supersedesId: uuid('supersedes_id'),
    content: jsonb('content').$type<SummaryContent>().notNull(),
    doctorId: uuid('doctor_id').notNull(),
    finalisedAt: timestamp('finalised_at', { withTimezone: true }).notNull().defaultNow(),
    finalisedByUserId: uuid('finalised_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    transcribed: boolean('transcribed').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    signedByUserId: uuid('signed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    changeReason: text('change_reason'),
    recordedChannel: text('recorded_channel').$type<'personal' | 'ward_device'>(),
    recordedDeviceId: text('recorded_device_id'),
    recordedSessionId: uuid('recorded_session_id'),
    clientId: uuid('client_id').notNull(),
  },
  (t) => [uniqueIndex('discharge_summaries_client_key').on(t.hospitalId, t.clientId)],
);

/** Clinical. What a patient reacts to, per patient (follows them into every stay); void-only (0051). */
export const patientAllergies = pgTable(
  'patient_allergies',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').notNull(),
    substance: text('substance').notNull(),
    category: text('category').$type<AllergyCategory>().notNull().default('drug'),
    medicineId: uuid('medicine_id'),
    drugClass: text('drug_class').$type<DrugClass>(),
    reaction: text('reaction'),
    severity: text('severity').$type<AllergySeverity>().notNull().default('unknown'),
    source: text('source').$type<AllergySource>().notNull().default('patient'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    admissionId: uuid('admission_id'),
    clientId: uuid('client_id').notNull(),
    ...voidColumns(),
  },
  (t) => [uniqueIndex('patient_allergies_client_key').on(t.hospitalId, t.clientId)],
);

/** Clinical. Someone asked about allergies: none known, recorded, or could not ask. Append-only (0051). */
export const patientAllergyReviews = pgTable('patient_allergy_reviews', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  patientId: uuid('patient_id').notNull(),
  admissionId: uuid('admission_id'),
  outcome: text('outcome').$type<'nkda' | 'recorded' | 'unable'>().notNull(),
  note: text('note'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

/** Clinical. A medicine on the admission or discharge reconciliation, with the doctor's decision (0051). */
export const medRecItems = pgTable(
  'med_rec_items',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    phase: text('phase').$type<MedRecPhase>().notNull(),
    name: text('name').notNull(),
    medicineId: uuid('medicine_id'),
    dose: text('dose'),
    frequency: text('frequency'),
    route: text('route'),
    duration: text('duration'),
    source: text('source').$type<MedRecSource>(),
    orderId: uuid('order_id'),
    fromItemId: uuid('from_item_id'),
    decision: text('decision').$type<MedRecDecision>(),
    decisionNote: text('decision_note'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').notNull(),
    ...voidColumns(),
  },
  (t) => [uniqueIndex('med_rec_items_client_key').on(t.hospitalId, t.clientId)],
);

/** Clinical. A doctor completed a reconciliation; append-only, the latest counts (0051). */
export const medRecSignoffs = pgTable('med_rec_signoffs', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  admissionId: uuid('admission_id').notNull(),
  phase: text('phase').$type<MedRecPhase>().notNull(),
  noneAtHome: boolean('none_at_home').notNull().default(false),
  items: integer('items').notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  signedByUserId: uuid('signed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  doctorId: uuid('doctor_id').notNull(),
});

/** Clinical. One dose, given or not; partitioned by month on occurred_at; void-only (trigger). */
export const marAdministrations = pgTable(
  'mar_administrations',
  {
    id: uuid('id').notNull().defaultRandom(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    orderId: uuid('order_id').notNull(),
    medicineId: uuid('medicine_id'),
    state: text('state').$type<DoseState>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    dose: text('dose'),
    quantity: smallint('quantity'),
    reasonCode: text('reason_code').$type<ReasonCode>(),
    reasonText: text('reason_text'),
    careEntryId: uuid('care_entry_id'),
    witnessStatus: text('witness_status').$type<'not_needed' | 'awaiting' | 'witnessed' | 'skipped'>().notNull().default('not_needed'),
    witnessedByUserId: uuid('witnessed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    witnessedAt: timestamp('witnessed_at', { withTimezone: true }),
    presenceProofId: uuid('presence_proof_id'),
    /** The due time this dose answers, and how it stood against its window (0049). */
    dueAt: timestamp('due_at', { withTimezone: true }),
    timingStatus: text('timing_status').$type<'on_time' | 'late' | 'early' | 'unscheduled'>(),
    delayMin: integer('delay_min'),
    timingReason: text('timing_reason'),
    controlFlags: text('control_flags').array().$type<ControlFlag[]>().notNull().default(sql`'{}'::text[]`),
    /** Taken off a store (0050): null when there is nothing to take off. */
    stockStatus: text('stock_status').$type<StockPostStatus>(),
    stockLocationId: uuid('stock_location_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    recordedChannel: text('recorded_channel').$type<'personal' | 'ward_device'>(),
    recordedDeviceId: text('recorded_device_id'),
    recordedSessionId: uuid('recorded_session_id'),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [primaryKey({ columns: [t.id, t.occurredAt] })],
);

export type StockPostStatus = 'posted' | 'short' | 'reversed';

/** Clinical. A risk-class medicine wasted (broken, left over, not used), witnessed before it comes off stock (0050). */
export const marWastes = pgTable(
  'mar_wastes',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    orderId: uuid('order_id').notNull(),
    medicineId: uuid('medicine_id').notNull(),
    marId: uuid('mar_id'),
    marOccurredAt: timestamp('mar_occurred_at', { withTimezone: true }),
    locationId: uuid('location_id'),
    units: smallint('units').notNull(),
    amount: text('amount'),
    reasonCode: text('reason_code').$type<WasteReason>().notNull(),
    reasonText: text('reason_text'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    witnessStatus: text('witness_status').$type<'awaiting' | 'witnessed'>().notNull().default('awaiting'),
    witnessedByUserId: uuid('witnessed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    witnessedAt: timestamp('witnessed_at', { withTimezone: true }),
    stockStatus: text('stock_status').$type<StockPostStatus>(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    recordedChannel: text('recorded_channel').$type<'personal' | 'ward_device'>(),
    recordedDeviceId: text('recorded_device_id'),
    recordedSessionId: uuid('recorded_session_id'),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
    ...voidColumns(),
  },
  (t) => [uniqueIndex('mar_wastes_client_key').on(t.hospitalId, t.clientId)],
);

/** Clinical. A second person confirming a risk-class give; decided once (trigger). */
export const witnessRequests = pgTable('witness_requests', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  admissionId: uuid('admission_id').notNull(),
  /** A give names its dose; a waste (0050) names its waste. */
  marId: uuid('mar_id'),
  marOccurredAt: timestamp('mar_occurred_at', { withTimezone: true }),
  wasteId: uuid('waste_id'),
  action: text('action').$type<'give' | 'waste'>().notNull().default('give'),
  actorUserId: uuid('actor_user_id')
    .notNull()
    .references(() => users.id),
  method: text('method').$type<'ward_device' | 'approval'>().notNull(),
  deviceId: text('device_id'),
  witnessUserId: uuid('witness_user_id').references(() => users.id),
  status: text('status').$type<'pending' | 'approved' | 'declined' | 'expired' | 'withdrawn'>().notNull().default('pending'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedChannel: text('decided_channel').$type<'personal' | 'ward_device'>(),
  decidedDeviceId: text('decided_device_id'),
  decidedSessionId: uuid('decided_session_id'),
});

/** Clinical. The nurse typed or scanned the bed's code: at the bedside at that moment. */
export const presenceProofs = pgTable('presence_proofs', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  admissionId: uuid('admission_id').notNull(),
  bedId: uuid('bed_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  method: text('method').$type<'code' | 'qr'>().notNull(),
  provedAt: timestamp('proved_at', { withTimezone: true }).notNull().defaultNow(),
  channel: text('channel').$type<'personal' | 'ward_device'>(),
  deviceId: text('device_id'),
  sessionId: uuid('session_id'),
});

/* ------------------------------------------------ due times and alerts (0049, B3b) */

export const timeCriticalSignoffs = pgTable('time_critical_signoffs', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  signedByUserId: uuid('signed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  signedRole: text('signed_role').$type<'doctor' | 'pharmacist' | 'owner'>().notNull(),
  doctorId: uuid('doctor_id'),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  list: jsonb('list').$type<{ medicineId: string; name: string; before: number; after: number }[]>().notNull(),
  windows: jsonb('windows').$type<Record<string, number>>().notNull(),
  note: text('note'),
});

/** Clinical. A time-critical alert put off, with its reason (≤ 30 min, twice per dose). */
export const dueSnoozes = pgTable('due_snoozes', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  snoozedByUserId: uuid('snoozed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(),
  snoozedAt: timestamp('snoozed_at', { withTimezone: true }).notNull().defaultNow(),
  until: timestamp('until', { withTimezone: true }).notNull(),
});

/** Clinical. One per late time-critical dose and level; acknowledged once (trigger). */
export const dueEscalations = pgTable('due_escalations', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').notNull(),
  admissionId: uuid('admission_id').notNull(),
  wardId: uuid('ward_id'),
  orderId: uuid('order_id').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  level: smallint('level').$type<1 | 2>().notNull(),
  mode: text('mode').$type<'observe' | 'live'>().notNull(),
  target: text('target').$type<'ward_in_charge' | 'ward' | 'on_call' | 'ordering_doctor'>().notNull(),
  targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedByUserId: uuid('acknowledged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

export const onCallAssignments = pgTable('on_call_assignments', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  branchId: uuid('branch_id').notNull(),
  doctorId: uuid('doctor_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

/** Written by the worker; read by the quality page. */
export const dueRollupsDaily = pgTable(
  'due_rollups_daily',
  {
    hospitalId: uuid('hospital_id').notNull(),
    wardId: uuid('ward_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    timeCritical: boolean('time_critical').notNull(),
    due: integer('due').notNull(),
    onTime: integer('on_time').notNull(),
    late: integer('late').notNull(),
    early: integer('early').notNull(),
    notGiven: integer('not_given').notNull(),
    missed: integer('missed').notNull(),
    medianDelayMin: integer('median_delay_min'),
    wouldEscalate: integer('would_escalate').notNull().default(0),
    escalated: integer('escalated').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.hospitalId, t.wardId, t.day, t.timeCritical] })],
);

export const alertRatings = pgTable('alert_ratings', {
  id: id(),
  hospitalId: uuid('hospital_id')
    .notNull()
    .references(() => hospitals.id, { onDelete: 'cascade' }),
  wardId: uuid('ward_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  shiftDay: date('shift_day', { mode: 'string' }).notNull(),
  shift: text('shift').$type<'morning' | 'evening' | 'night'>().notNull(),
  rating: text('rating').$type<'too_many' | 'about_right' | 'too_few'>().notNull(),
  createdAt: createdAt(),
});

/* ------------------------------------------- IPD intake, consents & alerts (0054) */

/** Persistent emergency and family contacts for a patient. */
export const patientContacts = pgTable(
  'patient_contacts',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    relation: text('relation').notNull(),
    phoneE164: text('phone_e164'),
    address: text('address'),
    isEmergencyContact: boolean('is_emergency_contact').notNull().default(true),
    isDecisionMaker: boolean('is_decision_maker').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('patient_contacts_tenant_key').on(t.hospitalId, t.id),
    index('patient_contacts_patient_idx').on(t.hospitalId, t.patientId),
  ],
);

/** Configurable legal and medical consent templates per hospital. */
export const consentTemplates = pgTable(
  'consent_templates',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    version: smallint('version').notNull().default(1),
    titleEn: text('title_en').notNull(),
    titleMr: text('title_mr'),
    titleHi: text('title_hi'),
    bodyEn: text('body_en').notNull(),
    bodyMr: text('body_mr'),
    bodyHi: text('body_hi'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('consent_templates_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('consent_templates_active_key')
      .on(t.hospitalId, t.code)
      .where(sql`is_active = true`),
  ],
);

/** Immutable patient consent records with server-side text snapshot and SHA-256 hash. */
export const patientConsents = pgTable(
  'patient_consents',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(() => consentTemplates.id, { onDelete: 'set null' }),
    templateVersion: smallint('template_version').notNull().default(1),
    textSnapshot: text('text_snapshot').notNull(),
    textHashSha256: text('text_hash_sha256').notNull(),
    language: text('language').$type<'en' | 'mr' | 'hi'>().notNull().default('mr'),
    status: text('status').$type<'obtained' | 'pending' | 'refused' | 'revoked'>().notNull().default('pending'),
    pendingReason: text('pending_reason'),
    signatoryCapacity: text('signatory_capacity')
      .$type<'patient' | 'relative' | 'guardian' | 'legal_rep'>()
      .notNull()
      .default('patient'),
    inabilityReason: text('inability_reason'),
    signatoryContactId: uuid('signatory_contact_id').references(() => patientContacts.id, {
      onDelete: 'set null',
    }),
    signatoryNameSnapshot: text('signatory_name_snapshot').notNull(),
    signatoryRelationSnapshot: text('signatory_relation_snapshot').notNull(),
    signatoryPhoneSnapshot: text('signatory_phone_snapshot'),
    method: text('method').$type<'paper' | 'digital'>().notNull().default('paper'),
    paperOnFile: boolean('paper_on_file').notNull().default(false),
    paperDocumentScanUrl: text('paper_document_scan_url'),
    digitalSignatureVector: text('digital_signature_vector'),
    explainedByDoctorId: uuid('explained_by_doctor_id').references(() => doctors.id, {
      onDelete: 'set null',
    }),
    witnessStaffUserId: uuid('witness_staff_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('patient_consents_tenant_key').on(t.hospitalId, t.id),
    index('patient_consents_admission_idx').on(t.hospitalId, t.admissionId),
  ],
);

/** Generic clinical and operational alerts with escalation. */
export const clinicalAlerts = pgTable(
  'clinical_alerts',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    type: text('type').$type<
      'patient_arrived_ward' | 'new_emergency_admission' | 'intake_incomplete_warn' | 'consent_pending_escalated' | 'alert_unacknowledged_esc' | 'critical_lab_value'
    >().notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
    recipientRole: text('recipient_role').$type<StaffRole>(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    status: text('status').$type<'pending' | 'acknowledged' | 'escalated' | 'resolved' | 'dismissed'>().notNull().default('pending'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedByUserId: uuid('acknowledged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    escalateAfterMinutes: smallint('escalate_after_minutes').notNull().default(20),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    escalatedToUserId: uuid('escalated_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    escalatedToRole: text('escalated_to_role').$type<StaffRole>().default('nurse'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('clinical_alerts_tenant_key').on(t.hospitalId, t.id),
    index('clinical_alerts_recipient_idx')
      .on(t.hospitalId, t.recipientUserId, t.status)
      .where(sql`status in ('pending', 'escalated')`),
    index('clinical_alerts_sweep_idx')
      .on(t.hospitalId, t.status, t.createdAt)
      .where(sql`status = 'pending'`),
  ],
);

/** Platform-wide standardized catalogue for Insurers, TPAs, and Schemes. Editable by platform admins only. (0066) */
export const payerProfiles = pgTable(
  'payer_profiles',
  {
    id: id(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    category: text('category').$type<'tpa' | 'private_insurer' | 'public_insurer' | 'govt_scheme' | 'corporate'>().notNull(),
    portalUrl: text('portal_url'),
    supportEmail: text('support_email'),
    supportPhone: text('support_phone'),
    tollFreeNumber: text('toll_free_number'),
    defaultPreauthSlaMinutes: integer('default_preauth_sla_minutes').notNull().default(360),
    defaultQuerySlaMinutes: integer('default_query_sla_minutes').notNull().default(120),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('payer_profiles_code_key').on(t.code)],
);

/** Hospital-level overrides, custom SLA minutes and required document checklists per payer. (0066) */
export const hospitalPayerConfigs = pgTable(
  'hospital_payer_configs',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    payerProfileId: uuid('payer_profile_id')
      .notNull()
      .references(() => payerProfiles.id, { onDelete: 'restrict' }),
    isActive: boolean('is_active').notNull().default(true),
    preauthSlaMinutes: integer('preauth_sla_minutes'),
    querySlaMinutes: integer('query_sla_minutes'),
    finalPacketSlaMinutes: integer('final_packet_sla_minutes').default(240),
    settlementSlaMinutes: integer('settlement_sla_minutes').default(43200),
    localTpaDeskContact: text('local_tpa_desk_contact'),
    portalLoginIdentifier: text('portal_login_identifier'),
    requiredDocuments: jsonb('required_documents').notNull().default(sql`'["insurance_card", "aadhaar_id", "admission_advice", "first_consultation_sheet"]'::jsonb`),
    customChecklist: jsonb('custom_checklist').notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('hospital_payer_configs_tenant_payer_key').on(t.hospitalId, t.payerProfileId),
  ],
);

/** Tenant-isolated claims record. Multiple cases permitted per admission (primary + top-up). (0066) */
export const claimCases = pgTable(
  'claim_cases',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    encounterPayerId: uuid('encounter_payer_id').notNull(),
    payerProfileId: uuid('payer_profile_id')
      .notNull()
      .references(() => payerProfiles.id, { onDelete: 'restrict' }),
    claimType: text('claim_type').$type<'cashless' | 'reimbursement'>().notNull().default('cashless'),
    priority: text('priority').$type<'standard' | 'urgent' | 'emergency'>().notNull().default('standard'),
    version: integer('version').notNull().default(1),
    clientId: uuid('client_id').notNull(),

    // Encrypted PII bound to claim ID via AAD
    policyNumberCiphertext: text('policy_number_ciphertext'),
    policyNumberIv: text('policy_number_iv'),
    policyNumberTag: text('policy_number_tag'),
    policyNumberKeyVersion: smallint('policy_number_key_version'),
    policyNumberMasked: text('policy_number_masked'),
    policyNumberBidx: text('policy_number_bidx'),

    memberIdCiphertext: text('member_id_ciphertext'),
    memberIdIv: text('member_id_iv'),
    memberIdTag: text('member_id_tag'),
    memberIdKeyVersion: smallint('member_id_key_version'),
    memberIdMasked: text('member_id_masked'),
    memberIdBidx: text('member_id_bidx'),

    tpaClaimNumber: text('tpa_claim_number'),
    corporateEmpId: text('corporate_emp_id'),
    status: text('status').$type<ClaimStatus>().notNull().default('draft'),
    interruptedStage: text('interrupted_stage').$type<ClaimStatus>(),
    settlementStatus: text('settlement_status').$type<SettlementStatus>().notNull().default('unsettled'),
    legacyReconciliationRequired: boolean('legacy_reconciliation_required').notNull().default(false),

    currentAuthorizedLimitPaise: bigint('current_authorized_limit_paise', { mode: 'number' }).notNull().default(0),
    adjudicatedPayablePaise: bigint('adjudicated_payable_paise', { mode: 'number' }),
    totalRemittedPaise: bigint('total_remitted_paise', { mode: 'number' }).notNull().default(0),
    totalTdsWithheldPaise: bigint('total_tds_withheld_paise', { mode: 'number' }).notNull().default(0),
    totalDeductionsPaise: bigint('total_deductions_paise', { mode: 'number' }).notNull().default(0),
    totalDisputedPaise: bigint('total_disputed_paise', { mode: 'number' }).notNull().default(0),

    estimatedCostPaise: bigint('estimated_cost_paise', { mode: 'number' }),
    preauthAmountPaise: bigint('preauth_amount_paise', { mode: 'number' }),
    approvedAmountPaise: bigint('approved_amount_paise', { mode: 'number' }),
    enhancementAmountPaise: bigint('enhancement_amount_paise', { mode: 'number' }),
    claimedAmountPaise: bigint('claimed_amount_paise', { mode: 'number' }),
    settledAmountPaise: bigint('settled_amount_paise', { mode: 'number' }),
    deductionAmountPaise: bigint('deduction_amount_paise', { mode: 'number' }),
    coPayAmountPaise: bigint('co_pay_amount_paise', { mode: 'number' }),

    dischargeBillId: uuid('discharge_bill_id'),
    preauthSubmittedAt: timestamp('preauth_submitted_at', { withTimezone: true }),
    preauthApprovedAt: timestamp('preauth_approved_at', { withTimezone: true }),
    preauthSlaDeadline: timestamp('preauth_sla_deadline', { withTimezone: true }),
    hospitalInternalDeadline: timestamp('hospital_internal_deadline', { withTimezone: true }),
    finalPacketReadyAt: timestamp('final_packet_ready_at', { withTimezone: true }),
    finalSubmittedAt: timestamp('final_submitted_at', { withTimezone: true }),
    finalSubmittedChannel: text('final_submitted_channel').$type<'portal' | 'email' | 'physical_courier' | 'in_person'>(),
    finalSubmissionReference: text('final_submission_reference'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    assignedStaffUserId: uuid('assigned_staff_user_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...voidColumns(),
  },
  (t) => [
    uniqueIndex('claim_cases_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('claim_cases_client_key').on(t.hospitalId, t.clientId),
    index('claim_cases_hospital_status_idx').on(t.hospitalId, t.status).where(sql`voided_at is null`),
    index('claim_cases_settlement_status_idx').on(t.hospitalId, t.settlementStatus).where(sql`voided_at is null`),
    index('claim_cases_admission_idx').on(t.hospitalId, t.admissionId),
    index('claim_cases_policy_bidx').on(t.hospitalId, t.policyNumberBidx).where(sql`voided_at is null`),
    index('claim_cases_member_bidx').on(t.hospitalId, t.memberIdBidx).where(sql`voided_at is null`),
    foreignKey({
      name: 'claim_cases_admission_fk',
      columns: [t.hospitalId, t.admissionId],
      foreignColumns: [admissions.hospitalId, admissions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'claim_cases_encounter_payer_fk',
      columns: [t.hospitalId, t.encounterPayerId],
      foreignColumns: [encounterPayers.hospitalId, encounterPayers.id],
    }).onDelete('restrict'),
  ],
);

/** Forensic immutable ledger for claim milestones. Append-only, never cascade-deleted. (0066) */
export const claimEvents = pgTable(
  'claim_events',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id').notNull(),
    eventType: text('event_type').notNull(),
    previousStatus: text('previous_status'),
    newStatus: text('new_status').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }),
    submissionChannel: text('submission_channel').$type<'portal' | 'email' | 'physical_courier' | 'in_person'>(),
    externalReference: text('external_reference'),
    notes: text('notes'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('claim_events_client_key').on(t.hospitalId, t.clientId),
    index('claim_events_case_created_idx').on(t.hospitalId, t.claimCaseId, t.createdAt),
    foreignKey({
      name: 'claim_events_case_fk',
      columns: [t.hospitalId, t.claimCaseId],
      foreignColumns: [claimCases.hospitalId, claimCases.id],
    }).onDelete('restrict'),
  ],
);

/** Tracks physical paper custody checklist and links to in-system records. (0066) */
export const claimDocumentRecords = pgTable(
  'claim_document_records',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id').notNull(),
    docCategory: text('doc_category').notNull(),
    linkedDischargeSummaryId: uuid('linked_discharge_summary_id').references(() => dischargeSummaries.id, { onDelete: 'set null' }),
    linkedTestOrderId: uuid('linked_test_order_id'),
    isPaperFiled: boolean('is_paper_filed').notNull().default(false),
    paperFiledAt: timestamp('paper_filed_at', { withTimezone: true }),
    paperFiledByUserId: uuid('paper_filed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    physicalBoxOrFileNo: text('physical_box_or_file_no'),
    notes: text('notes'),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...voidColumns(),
  },
  (t) => [
    uniqueIndex('claim_doc_records_client_key').on(t.hospitalId, t.clientId),
    index('claim_doc_records_case_idx').on(t.hospitalId, t.claimCaseId).where(sql`voided_at is null`),
    foreignKey({
      name: 'claim_doc_records_case_fk',
      columns: [t.hospitalId, t.claimCaseId],
      foreignColumns: [claimCases.hospitalId, claimCases.id],
    }).onDelete('cascade'),
  ],
);

/** TPA queries, deficiency tracking, and minute-based SLA countdowns. (0066) */
export const claimQueries = pgTable(
  'claim_queries',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id').notNull(),
    queryCategory: text('query_category').notNull(),
    queryDescription: text('query_description').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    slaDeadlineAt: timestamp('sla_deadline_at', { withTimezone: true }).notNull(),
    status: text('status').$type<QueryStatus>().notNull().default('pending_hospital'),
    deadlineType: text('deadline_type').$type<DeadlineType>().notNull().default('hospital_response'),
    replyNotes: text('reply_notes'),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    repliedByUserId: uuid('replied_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    replyChannel: text('reply_channel').$type<'portal' | 'email' | 'physical_courier'>(),
    replyReference: text('reply_reference'),
    insurerResolvedAt: timestamp('insurer_resolved_at', { withTimezone: true }),
    insurerResolutionReference: text('insurer_resolution_reference'),
    insurerResolutionNotes: text('insurer_resolution_notes'),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...voidColumns(),
  },
  (t) => [
    uniqueIndex('claim_queries_client_key').on(t.hospitalId, t.clientId),
    index('claim_queries_pending_deadline_idx').on(t.hospitalId, t.slaDeadlineAt).where(sql`status = 'pending_hospital' and voided_at is null`),
    index('claim_queries_case_idx').on(t.hospitalId, t.claimCaseId),
    foreignKey({
      name: 'claim_queries_case_fk',
      columns: [t.hospitalId, t.claimCaseId],
      foreignColumns: [claimCases.hospitalId, claimCases.id],
    }).onDelete('cascade'),
  ],
);

/** Rejections, reasons, and appeal lifecycle. (0066) */
export const claimRejections = pgTable(
  'claim_rejections',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id').notNull(),
    stage: text('stage').$type<'preauth' | 'enhancement' | 'final_claim'>().notNull(),
    rejectionReasonCategory: text('rejection_reason_category').notNull(),
    rejectionRemarks: text('rejection_remarks').notNull(),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }).notNull().defaultNow(),
    appealStatus: text('appeal_status').$type<'not_appealed' | 'appeal_in_progress' | 'appeal_submitted' | 'appeal_won' | 'appeal_lost' | 'converted_to_self_pay'>().notNull().default('not_appealed'),
    appealDeadlineAt: timestamp('appeal_deadline_at', { withTimezone: true }),
    appealSubmittedAt: timestamp('appeal_submitted_at', { withTimezone: true }),
    appealReference: text('appeal_reference'),
    appealNotes: text('appeal_notes'),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('claim_rejections_client_key').on(t.hospitalId, t.clientId),
    index('claim_rejections_case_idx').on(t.hospitalId, t.claimCaseId),
    foreignKey({
      name: 'claim_rejections_case_fk',
      columns: [t.hospitalId, t.claimCaseId],
      foreignColumns: [claimCases.hospitalId, claimCases.id],
    }).onDelete('cascade'),
  ],
);

/** Tracks initial pre-authorization and sequential enhancements history. (0067) */
export const claimAuthorizations = pgTable(
  'claim_authorizations',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id').notNull(),
    authType: text('auth_type').$type<AuthType>().notNull(),
    sequenceNumber: integer('sequence_number').notNull().default(0),
    requestedIncrementalPaise: bigint('requested_incremental_paise', { mode: 'number' }),
    requestedCumulativePaise: bigint('requested_cumulative_paise', { mode: 'number' }).notNull(),
    approvedIncrementalPaise: bigint('approved_incremental_paise', { mode: 'number' }),
    approvedCumulativePaise: bigint('approved_cumulative_paise', { mode: 'number' }),
    decision: text('decision').$type<AuthDecision>().notNull().default('pending'),
    referenceNumber: text('reference_number'),
    decisionNotes: text('decision_notes'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('claim_authorizations_client_key').on(t.hospitalId, t.clientId),
    uniqueIndex('claim_authorizations_seq_key').on(t.hospitalId, t.claimCaseId, t.authType, t.sequenceNumber),
    index('claim_authorizations_case_idx').on(t.hospitalId, t.claimCaseId),
    foreignKey({
      name: 'claim_authorizations_case_fk',
      columns: [t.hospitalId, t.claimCaseId],
      foreignColumns: [claimCases.hospitalId, claimCases.id],
    }).onDelete('cascade'),
  ],
);

/** Immutable snapshot ledger of all dispatched claim submission packets. (0067) */
export const claimSubmissions = pgTable(
  'claim_submissions',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id').notNull(),
    submissionNumber: integer('submission_number').notNull().default(1),
    submissionStage: text('submission_stage').$type<SubmissionStage>().notNull(),
    isResubmission: boolean('is_resubmission').notNull().default(false),
    channel: text('channel').$type<'portal' | 'email' | 'physical_courier' | 'in_person'>().notNull(),
    referenceNumber: text('reference_number').notNull(),
    claimedAmountPaise: bigint('claimed_amount_paise', { mode: 'number' }),
    packetHash: text('packet_hash').notNull(),
    snapshotPayload: jsonb('snapshot_payload').notNull().default(sql`'{}'::jsonb`),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('claim_submissions_client_key').on(t.hospitalId, t.clientId),
    uniqueIndex('claim_submissions_seq_key').on(t.hospitalId, t.claimCaseId, t.submissionNumber),
    index('claim_submissions_case_idx').on(t.hospitalId, t.claimCaseId),
    foreignKey({
      name: 'claim_submissions_case_fk',
      columns: [t.hospitalId, t.claimCaseId],
      foreignColumns: [claimCases.hospitalId, claimCases.id],
    }).onDelete('cascade'),
  ],
);

/** Audited multi-receipt remittances, EOB deductions, TDS, and reversals ledger. (0067) */
export const claimRemittances = pgTable(
  'claim_remittances',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id').notNull(),
    remittanceType: text('remittance_type').$type<RemittanceType>().notNull(),
    paymentMethod: text('payment_method').$type<PaymentMethod>(),
    payerReference: text('payer_reference'),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    tdsPaise: bigint('tds_paise', { mode: 'number' }).notNull().default(0),
    deductionPaise: bigint('deduction_paise', { mode: 'number' }).notNull().default(0),
    coPayPaise: bigint('co_pay_paise', { mode: 'number' }).notNull().default(0),
    disputedDeductionPaise: bigint('disputed_deduction_paise', { mode: 'number' }).notNull().default(0),
    reversalOfRemittanceId: uuid('reversal_of_remittance_id'),
    reversalReason: text('reversal_reason'),
    notes: text('notes'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('claim_remittances_client_key').on(t.hospitalId, t.clientId),
    index('claim_remittances_case_idx').on(t.hospitalId, t.claimCaseId),
    foreignKey({
      name: 'claim_remittances_case_fk',
      columns: [t.hospitalId, t.claimCaseId],
      foreignColumns: [claimCases.hospitalId, claimCases.id],
    }).onDelete('cascade'),
  ],
);

/* -------------------------------------------------------- WhatsApp Notices */

export type NoticeType =
  | 'hospital_closure'
  | 'doctor_schedule_change'
  | 'appointment_change'
  | 'general_announcement';
export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'processing'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';
export type NoticeRecipientStatus =
  | 'pending'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'suppressed'
  | 'pending_capacity'
  | 'cancelled';
export type CapacityReservationStatus = 'active' | 'committed' | 'released' | 'expired';

export const noticeCampaigns = pgTable(
  'notice_campaigns',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    noticeType: text('notice_type').$type<NoticeType>().notNull(),
    status: text('status').$type<CampaignStatus>().notNull().default('draft'),
    title: text('title').notNull(),
    closureDate: date('closure_date'),
    closureEndDate: date('closure_end_date'),
    closureDuration: text('closure_duration'),
    reason: text('reason'),
    rescheduleInstructions: text('reschedule_instructions'),
    contactPhone: text('contact_phone'),
    templateCode: text('template_code').notNull(),
    templateVariables: jsonb('template_variables').$type<Record<string, unknown>>().notNull().default({}),
    totalTargetRecipients: integer('total_target_recipients').notNull().default(0),
    mandatoryRecipientsCount: integer('mandatory_recipients_count').notNull().default(0),
    recentRecipientsCount: integer('recent_recipients_count').notNull().default(0),
    displacedRecipientsCount: integer('displaced_recipients_count').notNull().default(0),
    ineligibleRecipientsCount: integer('ineligible_recipients_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    readCount: integer('read_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    suppressedCount: integer('suppressed_count').notNull().default(0),
    pendingCapacityCount: integer('pending_capacity_count').notNull().default(0),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('notice_campaigns_hospital_idx').on(t.hospitalId, t.createdAt),
    index('notice_campaigns_status_idx').on(t.hospitalId, t.status),
  ],
);

export const noticeCampaignMandatoryRecipients = pgTable(
  'notice_campaign_mandatory_recipients',
  {
    id: id(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => noticeCampaigns.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'set null' }),
    phoneE164: text('phone_e164').notNull(),
    patientName: text('patient_name'),
    isEligible: boolean('is_eligible').notNull().default(true),
    ineligibleReason: text('ineligible_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notice_campaign_mandatory_recipients_key').on(t.campaignId, t.phoneE164),
    index('notice_campaign_mandatory_recipients_campaign_idx').on(t.campaignId),
  ],
);

export const noticeCampaignRecipients = pgTable(
  'notice_campaign_recipients',
  {
    id: id(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => noticeCampaigns.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'set null' }),
    phoneE164: text('phone_e164').notNull(),
    patientName: text('patient_name'),
    priority: smallint('priority').notNull().default(0),
    selectionReason: text('selection_reason').notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    activityType: text('activity_type'),
    status: text('status').$type<NoticeRecipientStatus>().notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    failedReason: text('failed_reason'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('notice_campaign_recipients_campaign_phone_key').on(t.campaignId, t.phoneE164),
    index('notice_campaign_recipients_drain_idx').on(t.status, t.scheduledFor, t.priority),
    index('notice_campaign_recipients_campaign_status_idx').on(t.campaignId, t.status),
    index('notice_campaign_recipients_provider_msg_idx').on(t.providerMessageId),
  ],
);

export const whatsappCapacityReservations = pgTable(
  'whatsapp_capacity_reservations',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    phoneNumberId: text('phone_number_id').notNull(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => noticeCampaigns.id, { onDelete: 'cascade' }),
    reservedSlots: integer('reserved_slots').notNull(),
    consumedSlots: integer('consumed_slots').notNull().default(0),
    releasedSlots: integer('released_slots').notNull().default(0),
    status: text('status').$type<CapacityReservationStatus>().notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('whatsapp_capacity_reservations_phone_active_idx').on(t.phoneNumberId, t.status, t.expiresAt),
    index('whatsapp_capacity_reservations_campaign_idx').on(t.campaignId),
  ],
);

export const whatsappOptOuts = pgTable(
  'whatsapp_opt_outs',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    phoneE164: text('phone_e164').notNull(),
    reason: text('reason').notNull().default('patient_opt_out'),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('whatsapp_opt_outs_hospital_phone_key').on(t.hospitalId, t.phoneE164),
    index('whatsapp_opt_outs_hospital_idx').on(t.hospitalId),
  ],
);

export const webhookEventDedup = pgTable(
  'webhook_event_dedup',
  {
    id: id(),
    eventId: text('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_event_dedup_event_id_key').on(t.eventId),
    index('webhook_event_dedup_processed_at_idx').on(t.processedAt),
  ],
);

