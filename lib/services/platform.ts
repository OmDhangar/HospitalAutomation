import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import {
  appointments,
  branches,
  doctors,
  doctorSchedules,
  hospitals,
  notificationOutbox,
  payments,
  planTiers,
  providerInvoices,
  staffMemberships,
  users,
} from '@/lib/db/schema';
import { hashPassword } from '@/lib/security/password';
import { startSubscription } from './subscriptions';
import { assignNumberToHospital } from './whatsapp-integration';
import {
  calculateMonthlyBill,
  messageRatio,
  ratioStatus,
  recommendTier,
  type PlanTier,
  type RatioStatus,
} from '@/lib/domain/pricing';

export type HospitalHealth = {
  hospitalId: string;
  name: string;
  planCode: string | null;
  includedAppointments: number | null;
  monthlyPricePaise: number | null;
  completedAppointments: number;
  messagesSent: number;
  ratio: number | null;
  status: RatioStatus;
  /** What this hospital is estimated to cost us in messaging this month. */
  messagingCostPaise: number;
  contributionPaise: number | null;
  /**
   * The tier this hospital's actual volume says they belong on. When it differs
   * from what they pay for, that is either revenue being left on the table or a
   * customer about to be surprised by overage — both worth a call.
   */
  recommendedTierCode: string | null;
};

/**
 * Roughly what one WhatsApp message costs, in paise.
 *
 * Meta's India utility/authentication rate plus a margin for BSP fees and the
 * October 2026 change that made service messages billable. This is a planning
 * figure held in one place on purpose: when the real rate card lands, it
 * changes here and every projection moves with it.
 */
export const PAISE_PER_MESSAGE = 14.5;

/**
 * What a message actually cost last time Meta billed us, or the planning figure
 * if no invoice has been recorded yet.
 *
 * Worth reconciling rather than assuming: Meta's utility rate drops with
 * monthly volume, so the true cost per message falls as the portfolio grows.
 * Using a flat estimate understates margin at scale and overstates it if rates
 * rise — either way it is a guess where a fact is available.
 */
export async function resolvePaisePerMessage(
  month?: string,
): Promise<{ paise: number; source: 'invoice' | 'estimate'; month?: string }> {
  const rows = await getAdminDb()
    .select({
      periodMonth: providerInvoices.periodMonth,
      messagesBilled: providerInvoices.messagesBilled,
      amountPaise: providerInvoices.amountPaise,
    })
    .from(providerInvoices)
    .orderBy(desc(providerInvoices.periodMonth))
    .limit(1);

  const latest = rows[0];
  if (!latest || latest.messagesBilled <= 0) {
    return { paise: PAISE_PER_MESSAGE, source: 'estimate' };
  }

  return {
    paise: latest.amountPaise / latest.messagesBilled,
    source: 'invoice',
    month: String(latest.periodMonth),
  };
}

/**
 * The operator's view across every hospital.
 *
 * Cross-tenant by necessity, which is why it runs on the admin connection and
 * why the page above it is gated on isPlatformAdmin. A hospital owner must
 * never see this: it contains other hospitals' numbers and our own margins.
 */
export async function getPortfolioHealth(month?: string): Promise<HospitalHealth[]> {
  const db = getAdminDb();
  const now = new Date();
  const start = month
    ? new Date(`${month}-01T00:00:00Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const rate = (await resolvePaisePerMessage(month)).paise;
  // Recommendations come from the live rate card, not the seeded constants, so
  // a price negotiated in the database is respected here too.
  const allTiers = (await db.select().from(planTiers)) as PlanTier[];

  const rows = await db
    .select({
      hospitalId: hospitals.id,
      name: hospitals.name,
      planCode: hospitals.planTierCode,
      tier: planTiers,
    })
    .from(hospitals)
    .leftJoin(planTiers, eq(planTiers.code, hospitals.planTierCode))
    .where(eq(hospitals.active, true))
    .orderBy(hospitals.name);

  return Promise.all(
    rows.map(async (row) => {
      const [completed] = await db
        .select({ value: count() })
        .from(appointments)
        .where(
          and(
            eq(appointments.hospitalId, row.hospitalId),
            eq(appointments.status, 'COMPLETED'),
            gte(appointments.completedAt, start),
          ),
        );

      const [messages] = await db
        .select({ value: count() })
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.hospitalId, row.hospitalId),
            eq(notificationOutbox.status, 'sent'),
            gte(notificationOutbox.sentAt, start),
          ),
        );

      const completedAppointments = Number(completed?.value ?? 0);
      const messagesSent = Number(messages?.value ?? 0);
      const ratio = messageRatio({ messagesSent, completedAppointments });
      const messagingCostPaise = Math.round(messagesSent * rate);

      const bill = row.tier
        ? calculateMonthlyBill({
            tier: row.tier,
            completedAppointments,
            messagesSent,
          })
        : null;

      return {
        hospitalId: row.hospitalId,
        name: row.name,
        planCode: row.planCode,
        includedAppointments: row.tier?.includedAppointments ?? null,
        monthlyPricePaise: row.tier?.monthlyPricePaise ?? null,
        completedAppointments,
        messagesSent,
        ratio,
        status: ratioStatus(ratio),
        messagingCostPaise,
        contributionPaise: bill ? bill.totalPaise - messagingCostPaise : null,
        recommendedTierCode:
          completedAppointments > 0
            ? (recommendTier(completedAppointments, allTiers)?.code ?? null)
            : null,
      };
    }),
  );
}

export type RecentFailure = {
  id: string;
  hospitalName: string;
  milestone: string;
  attempts: number;
  failedReason: string | null;
  createdAt: Date;
};

/** Delivery problems worth a human look, newest first. */
export async function getRecentFailures(limit = 20): Promise<RecentFailure[]> {
  const rows = await getAdminDb()
    .select({
      id: notificationOutbox.id,
      hospitalName: hospitals.name,
      milestone: notificationOutbox.milestone,
      attempts: notificationOutbox.attempts,
      failedReason: notificationOutbox.failedReason,
      createdAt: notificationOutbox.createdAt,
      status: notificationOutbox.status,
    })
    .from(notificationOutbox)
    .innerJoin(hospitals, eq(hospitals.id, notificationOutbox.hospitalId))
    .where(sql`${notificationOutbox.status} in ('failed', 'suppressed')`)
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(limit);

  return rows.map(({ status: _status, ...row }) => row);
}

export type CreateHospitalParams = {
  name: string;
  slug?: string;
  timezone?: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword?: string;
  ownerPhoneE164?: string;
  branchName?: string;
  branchAddress?: string;
  planTierCode?: string;
  billingCycle?: 'monthly' | 'annual';
  initialDoctorName?: string;
  initialDoctorSpecialty?: string;
  initialDoctorMode?: 'queue' | 'slot' | 'both';
  initialDoctorConsultMinutes?: number;
  phoneNumberId?: string;
  actorUserId?: string | null;
};

export type CreateHospitalResult = {
  hospitalId: string;
  hospitalName: string;
  slug: string;
  ownerUserId: string;
  branchId: string;
  doctorId?: string;
};

/**
 * Creates a brand new hospital tenant with initial branch, owner user,
 * subscription tier, optional initial doctor, and optional WhatsApp number assignment.
 */
export async function createHospital(args: CreateHospitalParams): Promise<CreateHospitalResult> {
  const db = getAdminDb();
  const slug = (
    args.slug ||
    args.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
  ) + '-' + Math.random().toString(36).slice(2, 6);

  const timezone = args.timezone || 'Asia/Kolkata';
  const ownerEmail = args.ownerEmail.toLowerCase().trim();
  const rawPassword = args.ownerPassword || 'Hospital@123';
  const passwordHash = await hashPassword(rawPassword);

  const [hospital] = await db
    .insert(hospitals)
    .values({
      name: args.name.trim(),
      slug,
      timezone,
      planTierCode: args.planTierCode || 'free',
      ownerPhoneE164: args.ownerPhoneE164 || null,
    })
    .returning();

  const [branch] = await db
    .insert(branches)
    .values({
      hospitalId: hospital.id,
      name: args.branchName?.trim() || 'Main Branch',
      address: args.branchAddress?.trim() || null,
    })
    .returning();

  // Create owner user (or find existing by email)
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, ownerEmail));

  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        name: args.ownerName.trim(),
        email: ownerEmail,
        passwordHash,
      })
      .returning();
  }

  // Create staff membership
  await db
    .insert(staffMemberships)
    .values({
      userId: user.id,
      hospitalId: hospital.id,
      branchId: branch.id,
      role: 'owner',
      active: true,
    });

  // Start subscription if plan tier specified
  if (args.planTierCode) {
    try {
      await startSubscription({
        hospitalId: hospital.id,
        tierCode: args.planTierCode,
        billingCycle: args.billingCycle ?? 'monthly',
        changeReason: 'initial_onboarding',
        changedByUserId: args.actorUserId ?? null,
      });
    } catch (err) {
      console.warn('[platform:createHospital] startSubscription warning:', err);
    }
  }

  // Create initial doctor if provided
  let doctorId: string | undefined;
  if (args.initialDoctorName?.trim()) {
    const [doctor] = await db
      .insert(doctors)
      .values({
        hospitalId: hospital.id,
        branchId: branch.id,
        name: args.initialDoctorName.trim(),
        specialty: args.initialDoctorSpecialty?.trim() || null,
        defaultConsultMinutes: args.initialDoctorConsultMinutes || 10,
        active: true,
      })
      .returning();

    doctorId = doctor.id;

    if (args.initialDoctorMode) {
      const today = new Date().toISOString().slice(0, 10);
      const dow = new Date().getDay();
      await db.insert(doctorSchedules).values({
        hospitalId: hospital.id,
        doctorId: doctor.id,
        weekday: dow,
        mode: args.initialDoctorMode,
        startTime: '09:00',
        endTime: '17:00',
        effectiveFrom: today,
      });
    }
  }

  // Assign WhatsApp Number if phoneNumberId provided
  if (args.phoneNumberId?.trim()) {
    try {
      await assignNumberToHospital({
        hospitalId: hospital.id,
        phoneNumberId: args.phoneNumberId.trim(),
        actor: {
          userId: args.actorUserId || user.id,
          role: 'owner',
          isPlatformAdmin: true,
        },
      });
    } catch (err) {
      console.warn('[platform:createHospital] assignNumber warning:', err);
    }
  }

  return {
    hospitalId: hospital.id,
    hospitalName: hospital.name,
    slug: hospital.slug,
    ownerUserId: user.id,
    branchId: branch.id,
    doctorId,
  };
}


/* --------------------------------------------------------------- revenue */

export type PlatformPayment = {
  id: string;
  hospitalId: string;
  hospitalName: string;
  purpose: string;
  status: string;
  amountPaise: number;
  taxPaise: number;
  paidAt: Date | null;
  createdAt: Date;
  failureReason: string | null;
};

/** Every collection attempt across the portfolio, newest first. */
export async function listPlatformPayments(limit = 60): Promise<PlatformPayment[]> {
  return getAdminDb()
    .select({
      id: payments.id,
      hospitalId: payments.hospitalId,
      hospitalName: hospitals.name,
      purpose: payments.purpose,
      status: payments.status,
      amountPaise: payments.amountPaise,
      taxPaise: payments.taxPaise,
      paidAt: payments.paidAt,
      createdAt: payments.createdAt,
      failureReason: payments.failureReason,
    })
    .from(payments)
    .innerJoin(hospitals, eq(hospitals.id, payments.hospitalId))
    .orderBy(desc(payments.createdAt))
    .limit(limit);
}

export type ProviderInvoiceRow = {
  id: string;
  provider: string;
  periodMonth: string;
  messagesBilled: number;
  amountPaise: number;
  notes: string | null;
};

export async function listProviderInvoices(limit = 18): Promise<ProviderInvoiceRow[]> {
  const rows = await getAdminDb()
    .select()
    .from(providerInvoices)
    .orderBy(desc(providerInvoices.periodMonth))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    periodMonth: String(row.periodMonth),
    messagesBilled: row.messagesBilled,
    amountPaise: row.amountPaise,
    notes: row.notes,
  }));
}

/**
 * Records what Meta actually charged for a month.
 *
 * Upserted on (provider, month) because a corrected invoice replaces the first
 * one rather than sitting alongside it — two rows for August would make the
 * cost-per-message reconciliation pick one arbitrarily.
 */
export async function recordProviderInvoice(args: {
  periodMonth: string;
  messagesBilled: number;
  amountPaise: number;
  provider?: string;
  notes?: string | null;
}) {
  const provider = args.provider ?? 'meta';

  await getAdminDb()
    .insert(providerInvoices)
    .values({
      provider,
      periodMonth: args.periodMonth,
      messagesBilled: args.messagesBilled,
      amountPaise: args.amountPaise,
      notes: args.notes ?? null,
    })
    .onConflictDoUpdate({
      target: [providerInvoices.provider, providerInvoices.periodMonth],
      set: {
        messagesBilled: args.messagesBilled,
        amountPaise: args.amountPaise,
        notes: args.notes ?? null,
        recordedAt: new Date(),
      },
    });
}
