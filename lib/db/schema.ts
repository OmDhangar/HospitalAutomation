import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { STAFF_ROLES } from '@/lib/domain/permissions';
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('patients_hospital_phone_name_key').on(t.hospitalId, t.phoneE164, t.name),
    index('patients_hospital_phone_idx').on(t.hospitalId, t.phoneE164),
  ],
);

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
    /** When the doctor paused this appointment. Null unless status is HELD. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Earliest time the scheduled resume job should fire. Null unless status is HELD. */
    resumeAt: timestamp('resume_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('appointments_token_key').on(t.doctorId, t.serviceDate, t.tokenNumber),
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
     * Quota snapshot, copied from the doctor when the day's first token is
     * issued. Null token_quota means the day runs without a quota.
     */
    tokenQuota: integer('token_quota'),
    walkInReserved: integer('walk_in_reserved'),
    walkInReleaseMinutes: integer('walk_in_release_minutes'),
    onlineOpensMinutesBefore: integer('online_opens_minutes_before'),
    lastReservedToken: integer('last_reserved_token').notNull().default(0),
    /** Owner released unused reserved walk-in capacity to the shared pool. */
    reservedReleasedAt: timestamp('reserved_released_at', { withTimezone: true }),
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
      .$type<'view_history' | 'print_prescription' | 'view_admission' | 'print_ipd_bill'>()
      .notNull(),
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
    /** The family's running-bill link (0033): hashed token, expiry 7 days after discharge. */
    billLinkTokenHash: text('bill_link_token_hash'),
    billLinkCreatedAt: timestamp('bill_link_created_at', { withTimezone: true }),
    billLinkExpiresAt: timestamp('bill_link_expires_at', { withTimezone: true }),
    billLinkRevokedAt: timestamp('bill_link_revoked_at', { withTimezone: true }),
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
    index('admissions_census_idx')
      .on(t.hospitalId, t.branchId, t.status)
      .where(sql`status in ('awaiting_bed', 'admitted', 'discharge_ready')`),
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
