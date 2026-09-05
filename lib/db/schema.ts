import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
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
import { APPOINTMENT_STATUSES, QUEUE_ACTIONS } from '@/lib/domain/types';

/**
 * The database enums are built from the domain constants, so a status can never
 * exist in the state machine without existing in Postgres, or vice versa.
 */
export const appointmentStatus = pgEnum('appointment_status', APPOINTMENT_STATUSES);
export const queueAction = pgEnum('queue_action', QUEUE_ACTIONS);

export const staffRole = pgEnum('staff_role', ['owner', 'receptionist', 'doctor']);
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

export const whatsappNumberStatus = pgEnum('whatsapp_number_status', [
  'pending',
  'registered',
  'flagged',
  'suspended',
  'released',
]);

export const conversationState = pgEnum('conversation_state', [
  'idle',
  'awaiting_language',
  'awaiting_doctor',
  'awaiting_slot',
]);

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
  includedAppointments: integer('included_appointments').notNull(),
  monthlyPricePaise: integer('monthly_price_paise').notNull(),
  overagePaisePerAppointment: integer('overage_paise_per_appointment').notNull().default(0),
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

/* ----------------------------------------------------------------- identity */

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  active: boolean('active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
});

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
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
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
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('doctors_hospital_idx').on(t.hospitalId), index('doctors_branch_idx').on(t.branchId)],
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
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    slotMinutes: smallint('slot_minutes').notNull().default(10),
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
    locale: locale('locale'),
    whatsappOptInAt: timestamp('whatsapp_opt_in_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('patients_hospital_phone_key').on(t.hospitalId, t.phoneE164)],
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
    source: appointmentSource('source').notNull(),
    /** Unguessable, never sequential; the patient's only credential. */
    publicToken: text('public_token').notNull().unique(),
    publicTokenExpiresAt: timestamp('public_token_expires_at', { withTimezone: true }).notNull(),
    scheduledSlotAt: timestamp('scheduled_slot_at', { withTimezone: true }),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    calledAt: timestamp('called_at', { withTimezone: true }),
    consultStartedAt: timestamp('consult_started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
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
    paused: boolean('paused').notNull().default(false),
    pausedReason: text('paused_reason'),
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }),
    sessionStartedAt: timestamp('session_started_at', { withTimezone: true }),
    lastTokenNumber: integer('last_token_number').notNull().default(0),
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
