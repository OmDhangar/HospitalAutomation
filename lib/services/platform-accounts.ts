import { and, count, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import {
  appointments,
  auditLogs,
  branches,
  doctors,
  hospitals,
  notificationOutbox,
  payments,
  planTiers,
  staffMemberships,
  subscriptions,
  users,
  whatsappNumbers,
} from '@/lib/db/schema';
import type { LimitKind } from '@/lib/domain/entitlements';
import {
  accountStanding,
  entitlementAxis,
  normalisedMrrPaise,
  STANDING_RANK,
  termView,
  type AccountStanding,
  type EntitlementAxis,
  type TermView,
} from '@/lib/domain/platform-account';
import { billingPeriod, usageAxis, type UsageAxis } from '@/lib/domain/subscription';
import type { StaffRole } from './auth';

/**
 * Every hospital on the platform, from the operator's side.
 *
 * Cross-tenant by definition, so all of it runs on the admin connection and
 * every caller must already have established that the person asking is a
 * platform operator. Nothing in this module checks that itself — the actions
 * layer does, and re-checking here would be a second place to get it wrong
 * rather than a second line of defence.
 *
 * The counts are grouped queries rather than a loop over hospitals. That is
 * not a micro-optimisation: the console's whole job is to show all accounts at
 * once, so a per-hospital round trip turns into a page that gets slower every
 * time we sell something.
 */

/* ------------------------------------------------------------ the list */

export type AccountRow = {
  hospitalId: string;
  name: string;
  slug: string;
  active: boolean;
  timezone: string;
  createdAt: Date;
  ownerPhoneE164: string | null;

  planTierCode: string | null;
  planName: string | null;
  billingCycle: 'monthly' | 'annual' | null;
  subscriptionStatus: import('@/lib/domain/subscription').SubscriptionStatus | null;
  /** Normalised to a monthly figure so a mixed-cycle portfolio can be summed. */
  mrrPaise: number;
  term: TermView;

  branchCount: number;
  doctorCount: number;
  staffCount: number;
  entitlements: EntitlementAxis[];

  /** This billing period, or this calendar month when there is no plan. */
  appointmentsUsed: number;
  messagesUsed: number;

  standing: AccountStanding;
  hasWhatsAppNumber: boolean;
};

type CountMap = Map<string, number>;

const toMap = (rows: Array<{ hospitalId: string | null; value: number | string }>): CountMap =>
  new Map(
    rows
      .filter((row): row is { hospitalId: string; value: number | string } => row.hospitalId !== null)
      .map((row) => [row.hospitalId, Number(row.value)]),
  );

/**
 * Counts every axis for every hospital in one query each.
 *
 * Shared by the list and by the portfolio view so the two can never disagree
 * about how many doctors a hospital has.
 */
async function loadCounts(since: Date) {
  const db = getAdminDb();

  const [branchRows, doctorRows, staffRows, apptRows, messageRows, numberRows] =
    await Promise.all([
      db
        .select({ hospitalId: branches.hospitalId, value: count() })
        .from(branches)
        .where(eq(branches.active, true))
        .groupBy(branches.hospitalId),
      db
        .select({ hospitalId: doctors.hospitalId, value: count() })
        .from(doctors)
        .where(eq(doctors.active, true))
        .groupBy(doctors.hospitalId),
      db
        .select({ hospitalId: staffMemberships.hospitalId, value: count() })
        .from(staffMemberships)
        .where(eq(staffMemberships.active, true))
        .groupBy(staffMemberships.hospitalId),
      db
        .select({ hospitalId: appointments.hospitalId, value: count() })
        .from(appointments)
        .where(
          and(eq(appointments.status, 'COMPLETED'), gte(appointments.completedAt, since)),
        )
        .groupBy(appointments.hospitalId),
      db
        .select({ hospitalId: notificationOutbox.hospitalId, value: count() })
        .from(notificationOutbox)
        .where(
          and(eq(notificationOutbox.status, 'sent'), gte(notificationOutbox.sentAt, since)),
        )
        .groupBy(notificationOutbox.hospitalId),
      db
        .select({ hospitalId: whatsappNumbers.hospitalId })
        .from(whatsappNumbers)
        .where(sql`${whatsappNumbers.hospitalId} is not null`),
    ]);

  return {
    branches: toMap(branchRows),
    doctors: toMap(doctorRows),
    staff: toMap(staffRows),
    appointments: toMap(apptRows),
    messages: toMap(messageRows),
    numbers: new Set(numberRows.map((row) => row.hospitalId).filter(Boolean) as string[]),
  };
}

export type AccountFilter = {
  /** Matched against name and slug, case-insensitively. */
  search?: string;
  standing?: AccountStanding;
  /** Inactive hospitals are included by default — they are the ones to chase. */
  onlyAttention?: boolean;
};

export async function listAccounts(
  filter: AccountFilter = {},
  now: Date = new Date(),
): Promise<AccountRow[]> {
  const db = getAdminDb();

  /**
   * One calendar month back, not one billing period: hospitals start their
   * terms on different days, and the grouped counts above can only take a
   * single cut-off. The per-hospital detail view re-reads usage against that
   * hospital's own period, which is where the number has to be exact.
   */
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [rows, counts] = await Promise.all([
    db
      .select({
        hospital: hospitals,
        subscription: subscriptions,
        planName: planTiers.name,
      })
      .from(hospitals)
      .leftJoin(
        subscriptions,
        and(
          eq(subscriptions.hospitalId, hospitals.id),
          isNull(subscriptions.supersededAt),
        ),
      )
      .leftJoin(planTiers, eq(planTiers.code, hospitals.planTierCode))
      .orderBy(hospitals.name),
    loadCounts(since),
  ]);

  const accounts = rows.map((row): AccountRow => {
    const { hospital, subscription } = row;
    const branchCount = counts.branches.get(hospital.id) ?? 0;
    const doctorCount = counts.doctors.get(hospital.id) ?? 0;
    const staffCount = counts.staff.get(hospital.id) ?? 0;

    /**
     * Entitlements come from the subscription, never the rate card. The
     * subscription snapshots them precisely so repricing a tier cannot reach
     * backwards and change what a customer was sold, and reading `plan_tiers`
     * here would throw that away at the one moment it matters.
     */
    const entitlements: EntitlementAxis[] = [
      entitlementAxis('branches', branchCount, subscription?.maxBranches ?? null),
      entitlementAxis('doctors', doctorCount, subscription?.maxDoctors ?? null),
      entitlementAxis('staff', staffCount, subscription?.maxStaffLogins ?? null),
    ];

    const term = termView(subscription?.endsAt ?? null, now);

    return {
      hospitalId: hospital.id,
      name: hospital.name,
      slug: hospital.slug,
      active: hospital.active,
      timezone: hospital.timezone,
      createdAt: hospital.createdAt,
      ownerPhoneE164: hospital.ownerPhoneE164,

      planTierCode: subscription?.planTierCode ?? hospital.planTierCode,
      planName: row.planName,
      billingCycle: subscription?.billingCycle ?? null,
      subscriptionStatus: subscription?.status ?? null,
      mrrPaise: subscription
        ? normalisedMrrPaise({
            pricePaise: subscription.pricePaise,
            billingCycle: subscription.billingCycle,
          })
        : 0,
      term,

      branchCount,
      doctorCount,
      staffCount,
      entitlements,

      appointmentsUsed: counts.appointments.get(hospital.id) ?? 0,
      messagesUsed: counts.messages.get(hospital.id) ?? 0,

      standing: accountStanding({
        hospitalActive: hospital.active,
        subscriptionStatus: subscription?.status ?? null,
        endsAt: subscription?.endsAt ?? null,
        overLimit: entitlements.some((axis) => axis.atLimit),
        now,
      }),
      hasWhatsAppNumber: counts.numbers.has(hospital.id),
    };
  });

  const search = filter.search?.trim().toLowerCase();
  const filtered = accounts.filter((account) => {
    if (search && !`${account.name} ${account.slug}`.toLowerCase().includes(search)) {
      return false;
    }
    if (filter.standing && account.standing !== filter.standing) return false;
    if (filter.onlyAttention && (account.standing === 'healthy' || account.standing === 'trial')) {
      return false;
    }
    return true;
  });

  /**
   * Worst first, then by name. An operator console sorted alphabetically makes
   * you read all of it to find the one account that needs a call today.
   */
  return filtered.sort(
    (a, b) =>
      STANDING_RANK[a.standing] - STANDING_RANK[b.standing] || a.name.localeCompare(b.name),
  );
}

/* ---------------------------------------------------------- one account */

export type AccountUser = {
  membershipId: string | null;
  userId: string;
  name: string;
  email: string;
  role: StaffRole | null;
  branchName: string | null;
  membershipActive: boolean;
  userActive: boolean;
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
};

export type AccountPayment = {
  id: string;
  purpose: string;
  status: string;
  amountPaise: number;
  taxPaise: number;
  paidAt: Date | null;
  createdAt: Date;
  failureReason: string | null;
};

export type AccountAudit = {
  id: string;
  action: string;
  objectType: string;
  actorName: string | null;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
};

export type AccountDetail = {
  account: AccountRow;
  branches: Array<{ id: string; name: string; address: string | null; active: boolean }>;
  users: AccountUser[];
  /** Usage against this hospital's own billing period, not a calendar month. */
  period: { start: Date; end: Date } | null;
  appointments: UsageAxis;
  messages: UsageAxis;
  dailyCapacity: number | null;
  subscriptionHistory: Array<{
    id: string;
    planTierCode: string;
    billingCycle: string;
    status: string;
    pricePaise: number;
    startsAt: Date;
    endsAt: Date;
    changeReason: string | null;
    supersededAt: Date | null;
  }>;
  payments: AccountPayment[];
  audit: AccountAudit[];
  /**
   * The capability half of the plan, as the subscription snapshotted it. Read
   * from the term rather than the rate card for the same reason the limits are.
   */
  features: {
    supportTier: string;
    hasDisplayBoard: boolean;
    hasOwnerReport: boolean;
    hasAdvancedReports: boolean;
    hasDataExport: boolean;
    hasAuditLog: boolean;
  } | null;
  whatsapp: {
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    status: string;
    qualityRating: string | null;
  } | null;
};

export async function getAccountDetail(
  hospitalId: string,
  now: Date = new Date(),
): Promise<AccountDetail | null> {
  const db = getAdminDb();

  const [row] = await listAccounts({}, now).then((rows) =>
    rows.filter((account) => account.hospitalId === hospitalId),
  );
  if (!row) return null;

  const [current] = await db
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.hospitalId, hospitalId), isNull(subscriptions.supersededAt)),
    );

  const period = current ? billingPeriod({ startsAt: current.startsAt, now }) : null;

  const [
    branchRows,
    userRows,
    historyRows,
    paymentRows,
    auditRows,
    numberRows,
    periodUsage,
  ] = await Promise.all([
    db
      .select({
        id: branches.id,
        name: branches.name,
        address: branches.address,
        active: branches.active,
      })
      .from(branches)
      .where(eq(branches.hospitalId, hospitalId))
      .orderBy(branches.name),

    db
      .select({
        membershipId: staffMemberships.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        role: staffMemberships.role,
        branchName: branches.name,
        membershipActive: staffMemberships.active,
        userActive: users.active,
        isPlatformAdmin: users.isPlatformAdmin,
        mustChangePassword: users.mustChangePassword,
        lastLoginAt: users.lastLoginAt,
        createdAt: staffMemberships.createdAt,
      })
      .from(staffMemberships)
      .innerJoin(users, eq(users.id, staffMemberships.userId))
      .leftJoin(branches, eq(branches.id, staffMemberships.branchId))
      .where(eq(staffMemberships.hospitalId, hospitalId))
      .orderBy(staffMemberships.createdAt),

    db
      .select({
        id: subscriptions.id,
        planTierCode: subscriptions.planTierCode,
        billingCycle: subscriptions.billingCycle,
        status: subscriptions.status,
        pricePaise: subscriptions.pricePaise,
        startsAt: subscriptions.startsAt,
        endsAt: subscriptions.endsAt,
        changeReason: subscriptions.changeReason,
        supersededAt: subscriptions.supersededAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.hospitalId, hospitalId))
      .orderBy(desc(subscriptions.startsAt))
      .limit(12),

    db
      .select({
        id: payments.id,
        purpose: payments.purpose,
        status: payments.status,
        amountPaise: payments.amountPaise,
        taxPaise: payments.taxPaise,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
        failureReason: payments.failureReason,
      })
      .from(payments)
      .where(eq(payments.hospitalId, hospitalId))
      .orderBy(desc(payments.createdAt))
      .limit(15),

    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        objectType: auditLogs.objectType,
        actorName: users.name,
        createdAt: auditLogs.createdAt,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(eq(auditLogs.hospitalId, hospitalId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(25),

    db
      .select({
        phoneNumberId: whatsappNumbers.phoneNumberId,
        displayPhoneNumber: whatsappNumbers.displayPhoneNumber,
        verifiedName: whatsappNumbers.verifiedName,
        status: whatsappNumbers.status,
        qualityRating: whatsappNumbers.qualityRating,
      })
      .from(whatsappNumbers)
      .where(eq(whatsappNumbers.hospitalId, hospitalId))
      .limit(1),

    period
      ? Promise.all([
          db
            .select({ value: count() })
            .from(appointments)
            .where(
              and(
                eq(appointments.hospitalId, hospitalId),
                eq(appointments.status, 'COMPLETED'),
                gte(appointments.completedAt, period.start),
                // `lt`, not a raw sql fragment: the template serialises a Date
                // with its JavaScript toString, which Postgres rejects as a
                // timestamptz. The operator maps it to ISO.
                lt(appointments.completedAt, period.end),
              ),
            ),
          db
            .select({ value: count() })
            .from(notificationOutbox)
            .where(
              and(
                eq(notificationOutbox.hospitalId, hospitalId),
                eq(notificationOutbox.status, 'sent'),
                gte(notificationOutbox.sentAt, period.start),
                lt(notificationOutbox.sentAt, period.end),
              ),
            ),
        ])
      : Promise.resolve(null),
  ]);

  const appointmentsUsed = Number(periodUsage?.[0]?.[0]?.value ?? 0);
  const messagesUsed = Number(periodUsage?.[1]?.[0]?.value ?? 0);

  return {
    account: row,
    branches: branchRows,
    users: userRows,
    period: period ? { start: period.start, end: period.end } : null,
    appointments: usageAxis(appointmentsUsed, current?.includedAppointments ?? 0),
    messages: usageAxis(messagesUsed, current?.includedMessages ?? 0),
    dailyCapacity: current?.dailyAppointmentCapacity ?? null,
    subscriptionHistory: historyRows,
    payments: paymentRows,
    audit: auditRows,
    features: current
      ? {
          supportTier: current.supportTier,
          hasDisplayBoard: current.hasDisplayBoard,
          hasOwnerReport: current.hasOwnerReport,
          hasAdvancedReports: current.hasAdvancedReports,
          hasDataExport: current.hasDataExport,
          hasAuditLog: current.hasAuditLog,
        }
      : null,
    whatsapp: numberRows[0] ?? null,
  };
}

/* ------------------------------------------------------------ portfolio */

export type PortfolioTotals = {
  hospitals: number;
  active: number;
  needingAttention: number;
  mrrPaise: number;
  appointments: number;
  messages: number;
};

export function summarise(accounts: AccountRow[]): PortfolioTotals {
  return accounts.reduce<PortfolioTotals>(
    (totals, account) => ({
      hospitals: totals.hospitals + 1,
      active: totals.active + (account.active ? 1 : 0),
      needingAttention:
        totals.needingAttention +
        (account.standing === 'healthy' || account.standing === 'trial' ? 0 : 1),
      /**
       * Suspended and expired accounts contribute nothing. Counting what a
       * lapsed customer used to pay is how a revenue figure starts lying.
       */
      mrrPaise:
        totals.mrrPaise +
        (account.subscriptionStatus === 'active' || account.subscriptionStatus === 'trial'
          ? account.mrrPaise
          : 0),
      appointments: totals.appointments + account.appointmentsUsed,
      messages: totals.messages + account.messagesUsed,
    }),
    {
      hospitals: 0,
      active: 0,
      needingAttention: 0,
      mrrPaise: 0,
      appointments: 0,
      messages: 0,
    },
  );
}

export type { LimitKind };
