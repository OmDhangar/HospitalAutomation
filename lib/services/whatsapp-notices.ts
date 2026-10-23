import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb, withTenant, type Tx } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import {
  appointments,
  hospitals,
  noticeCampaignMandatoryRecipients,
  noticeCampaignRecipients,
  noticeCampaigns,
  patients,
  users,
  whatsappConversations,
  whatsappOptOuts,
  type CampaignStatus,
  type NoticeRecipientStatus,
  type NoticeType,
} from '@/lib/db/schema';
import {
  computeNoticeSelection,
  type MandatoryInput,
  type NoticeSelectionResult,
  type RecipientCandidate,
} from '@/lib/domain/notice-selection';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import {
  getAccountCapacity,
  releaseCampaignCapacity,
  reserveCampaignCapacityInTx,
} from './notice-capacity';
import { drainNoticeCampaignOutbox } from '@/lib/notify/notice-worker';

export type NoticeActor = {
  userId: string;
  role: string;
  hospitalId: string;
  isPlatformAdmin?: boolean;
};

export class NoticeAuthError extends Error {
  constructor(message = 'Not authorized to manage WhatsApp notices') {
    super(message);
    this.name = 'NoticeAuthError';
  }
}

function assertCanManageNotices(actor: NoticeActor, targetHospitalId: string) {
  if (actor.isPlatformAdmin) return;
  if (actor.hospitalId !== targetHospitalId) {
    throw new NoticeAuthError('Cross-hospital access forbidden');
  }
  if (actor.role !== 'owner' && actor.role !== 'receptionist') {
    throw new NoticeAuthError('Only hospital administrators may manage WhatsApp notices');
  }
}

/**
 * Loads all candidate patients for a hospital, calculating their most recent OPD interaction.
 */
export async function loadHospitalCandidates(params: {
  hospitalId: string;
  closureDate?: string;
  closureEndDate?: string;
}): Promise<RecipientCandidate[]> {
  const db = getAdminDb();

  // 1. Get opt-outs for this hospital
  const optOutRows = await db
    .select({ phoneE164: whatsappOptOuts.phoneE164 })
    .from(whatsappOptOuts)
    .where(eq(whatsappOptOuts.hospitalId, params.hospitalId));
  const optOutSet = new Set(optOutRows.map((r) => r.phoneE164));

  // 2. Query patients and aggregate latest appointment and conversation activity
  const patientRows = await db
    .select({
      id: patients.id,
      phoneE164: patients.phoneE164,
      name: patients.name,
      whatsappOptInAt: patients.whatsappOptInAt,
      createdAt: patients.createdAt,
      lastInboundAt: whatsappConversations.lastInboundAt,
      latestAppointmentAt: sql<Date | null>`max(${appointments.createdAt})`,
      hasAffectedAppointment: params.closureDate
        ? params.closureEndDate && params.closureEndDate !== params.closureDate
          ? sql<boolean>`bool_or(${appointments.serviceDate} >= ${params.closureDate}::date and ${appointments.serviceDate} <= ${params.closureEndDate}::date and ${appointments.status} not in ('COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'))`
          : sql<boolean>`bool_or(${appointments.serviceDate} = ${params.closureDate}::date and ${appointments.status} not in ('COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'))`
        : sql<boolean>`false`,
    })
    .from(patients)
    .leftJoin(
      whatsappConversations,
      and(
        eq(whatsappConversations.hospitalId, patients.hospitalId),
        eq(whatsappConversations.phoneE164, patients.phoneE164),
      ),
    )
    .leftJoin(
      appointments,
      and(
        eq(appointments.hospitalId, patients.hospitalId),
        eq(appointments.patientId, patients.id),
      ),
    )
    .where(eq(patients.hospitalId, params.hospitalId))
    .groupBy(
      patients.id,
      patients.phoneE164,
      patients.name,
      patients.whatsappOptInAt,
      patients.createdAt,
      whatsappConversations.lastInboundAt,
    );

  const candidates: RecipientCandidate[] = [];

  for (const row of patientRows) {
    const rawPhone = row.phoneE164.trim();
    const normalized = normalizeIndianPhone(rawPhone);
    if (!normalized) continue;

    const timestamps = [row.createdAt.getTime()];
    let activityType: RecipientCandidate['activityType'] = 'registration';

    if (row.latestAppointmentAt) {
      timestamps.push(new Date(row.latestAppointmentAt).getTime());
      activityType = 'appointment';
    }
    if (row.lastInboundAt) {
      timestamps.push(new Date(row.lastInboundAt).getTime());
      activityType = 'whatsapp_inbound';
    }

    const maxTimestamp = new Date(Math.max(...timestamps));

    candidates.push({
      phoneE164: normalized,
      patientId: row.id,
      patientName: row.name,
      lastActivityAt: maxTimestamp,
      activityType,
      hasConsent: Boolean(row.whatsappOptInAt),
      isOptedOut: optOutSet.has(normalized),
      hasAffectedAppointment: Boolean(row.hasAffectedAppointment),
    });
  }

  return candidates;
}

/**
 * Creates a draft WhatsApp notice campaign.
 */
export async function createNoticeCampaignDraft(params: {
  hospitalId: string;
  actor: NoticeActor;
  noticeType: NoticeType;
  title: string;
  closureDate?: string;
  closureEndDate?: string;
  closureDuration?: string;
  reason?: string;
  rescheduleInstructions?: string;
  contactPhone?: string;
  templateCode: string;
  templateVariables?: Record<string, unknown>;
}): Promise<{ campaignId: string }> {
  assertCanManageNotices(params.actor, params.hospitalId);

  const db = getAdminDb();

  const [campaign] = await db
    .insert(noticeCampaigns)
    .values({
      hospitalId: params.hospitalId,
      noticeType: params.noticeType,
      status: 'draft',
      title: params.title,
      closureDate: params.closureDate,
      closureEndDate: params.closureEndDate || params.closureDate || null,
      closureDuration: params.closureDuration,
      reason: params.reason,
      rescheduleInstructions: params.rescheduleInstructions,
      contactPhone: params.contactPhone,
      templateCode: params.templateCode,
      templateVariables: params.templateVariables ?? {},
    })
    .returning({ id: noticeCampaigns.id });

  return { campaignId: campaign.id };
}

/**
 * Saves or updates mandatory recipients for a campaign.
 */
export async function saveCampaignMandatoryRecipients(params: {
  campaignId: string;
  hospitalId: string;
  actor: NoticeActor;
  recipients: Array<{
    phoneE164: string;
    patientId?: string | null;
    patientName?: string;
  }>;
}): Promise<{ savedCount: number }> {
  assertCanManageNotices(params.actor, params.hospitalId);

  const db = getAdminDb();

  // Verify campaign belongs to hospital and is draft
  const [campaign] = await db
    .select({ id: noticeCampaigns.id, status: noticeCampaigns.status })
    .from(noticeCampaigns)
    .where(
      and(
        eq(noticeCampaigns.id, params.campaignId),
        eq(noticeCampaigns.hospitalId, params.hospitalId),
      ),
    );

  if (!campaign) throw new Error('Notice campaign not found');
  if (campaign.status !== 'draft') {
    throw new Error('Mandatory recipients can only be modified on draft campaigns');
  }

  // Load opt-outs and patients to pre-validate eligibility
  const candidates = await loadHospitalCandidates({ hospitalId: params.hospitalId });
  const candidateMap = new Map(candidates.map((c) => [c.phoneE164, c]));

  // Clear existing mandatory recipients for this campaign
  await db
    .delete(noticeCampaignMandatoryRecipients)
    .where(eq(noticeCampaignMandatoryRecipients.campaignId, params.campaignId));

  const toInsert: Array<{
    campaignId: string;
    patientId: string | null;
    phoneE164: string;
    patientName: string | null;
    isEligible: boolean;
    ineligibleReason: string | null;
  }> = [];

  const seenPhones = new Set<string>();

  for (const item of params.recipients) {
    const raw = item.phoneE164.trim();
    const normalized = normalizeIndianPhone(raw);
    if (!normalized) {
      if (!seenPhones.has(raw)) {
        seenPhones.add(raw);
        toInsert.push({
          campaignId: params.campaignId,
          patientId: null,
          phoneE164: raw,
          patientName: item.patientName ?? null,
          isEligible: false,
          ineligibleReason: 'invalid_phone',
        });
      }
      continue;
    }

    if (seenPhones.has(normalized)) continue;
    seenPhones.add(normalized);

    const matched = candidateMap.get(normalized);
    let isEligible = true;
    let ineligibleReason: string | null = null;

    if (matched?.isOptedOut) {
      isEligible = false;
      ineligibleReason = 'opted_out';
    } else if (!matched?.hasConsent) {
      isEligible = false;
      ineligibleReason = 'no_consent';
    }

    toInsert.push({
      campaignId: params.campaignId,
      patientId: item.patientId ?? matched?.patientId ?? null,
      phoneE164: normalized,
      patientName: item.patientName ?? matched?.patientName ?? null,
      isEligible,
      ineligibleReason,
    });
  }

  if (toInsert.length > 0) {
    await db.insert(noticeCampaignMandatoryRecipients).values(toInsert);
  }

  return { savedCount: toInsert.length };
}

/**
 * Calculates a preview of recipient selection without persisting changes or reserving capacity.
 */
export async function previewNoticeSelection(params: {
  hospitalId: string;
  actor: NoticeActor;
  campaignId?: string;
  closureDate?: string;
  closureEndDate?: string;
  mandatoryRecipients?: MandatoryInput[];
}): Promise<NoticeSelectionResult> {
  assertCanManageNotices(params.actor, params.hospitalId);

  const db = getAdminDb();

  // 1. Get capacity
  const capacity = await getAccountCapacity(params.hospitalId);

  // If campaignId given and dates not provided, retrieve from campaign
  let closureDate = params.closureDate;
  let closureEndDate = params.closureEndDate;
  if (params.campaignId && (!closureDate || !closureEndDate)) {
    const [existing] = await db
      .select({
        closureDate: noticeCampaigns.closureDate,
        closureEndDate: noticeCampaigns.closureEndDate,
      })
      .from(noticeCampaigns)
      .where(eq(noticeCampaigns.id, params.campaignId));
    if (existing) {
      closureDate = closureDate ?? (existing.closureDate ?? undefined);
      closureEndDate = closureEndDate ?? (existing.closureEndDate ?? undefined);
    }
  }

  // 2. Load candidates
  const candidates = await loadHospitalCandidates({
    hospitalId: params.hospitalId,
    closureDate,
    closureEndDate,
  });

  // 3. Load mandatory recipients from campaign if campaignId provided
  let mandatory = params.mandatoryRecipients ?? [];
  if (params.campaignId) {
    const savedMandatory = await db
      .select({
        phoneE164: noticeCampaignMandatoryRecipients.phoneE164,
        patientId: noticeCampaignMandatoryRecipients.patientId,
        patientName: noticeCampaignMandatoryRecipients.patientName,
      })
      .from(noticeCampaignMandatoryRecipients)
      .where(eq(noticeCampaignMandatoryRecipients.campaignId, params.campaignId));

    if (savedMandatory.length > 0) {
      mandatory = savedMandatory.map((m) => ({
        phoneE164: m.phoneE164,
        patientId: m.patientId,
        patientName: m.patientName ?? undefined,
      }));
    }
  }

  return computeNoticeSelection({
    candidates,
    mandatory,
    availableAccountCapacity: capacity.availableCapacity,
  });
}

/**
 * Confirms a notice campaign: atomically reserves capacity, freezes recipient snapshot,
 * and queues initial batch for sending. Idempotent against duplicate requests.
 */
export async function confirmNoticeCampaign(params: {
  campaignId: string;
  hospitalId: string;
  actor: NoticeActor;
  idempotencyKey?: string;
}): Promise<{
  success: boolean;
  campaignId: string;
  status: CampaignStatus;
  confirmedRecipientsCount: number;
}> {
  assertCanManageNotices(params.actor, params.hospitalId);

  const adminDb = getAdminDb();

  // Run atomically inside transaction
  const confirmed = await adminDb.transaction(async (tx) => {
    // Lock campaign row
    const [campaign] = await tx
      .select()
      .from(noticeCampaigns)
      .where(
        and(
          eq(noticeCampaigns.id, params.campaignId),
          eq(noticeCampaigns.hospitalId, params.hospitalId),
        ),
      )
      .for('update');

    if (!campaign) throw new Error('Notice campaign not found');

    // Idempotency check: if already confirmed or completed, return cleanly
    if (campaign.status !== 'draft') {
      return {
        alreadyConfirmed: true,
        campaignId: campaign.id,
        status: campaign.status,
        confirmedRecipientsCount: campaign.totalTargetRecipients,
      };
    }

    // 1. Calculate selection inside transaction
    const capacity = await getAccountCapacity(params.hospitalId);
    const candidates = await loadHospitalCandidates({
      hospitalId: params.hospitalId,
      closureDate: campaign.closureDate ?? undefined,
      closureEndDate: campaign.closureEndDate ?? undefined,
    });

    const savedMandatory = await tx
      .select({
        phoneE164: noticeCampaignMandatoryRecipients.phoneE164,
        patientId: noticeCampaignMandatoryRecipients.patientId,
        patientName: noticeCampaignMandatoryRecipients.patientName,
      })
      .from(noticeCampaignMandatoryRecipients)
      .where(eq(noticeCampaignMandatoryRecipients.campaignId, campaign.id));

    const selection = computeNoticeSelection({
      candidates,
      mandatory: savedMandatory.map((m) => ({
        phoneE164: m.phoneE164,
        patientId: m.patientId,
        patientName: m.patientName ?? undefined,
      })),
      availableAccountCapacity: capacity.availableCapacity,
    });

    if (selection.finalRecipients.length === 0) {
      throw new Error('Cannot confirm campaign: No eligible recipients found.');
    }

    // 2. Atomically reserve capacity
    await reserveCampaignCapacityInTx(tx, {
      hospitalId: params.hospitalId,
      campaignId: campaign.id,
      slots: selection.finalRecipients.length,
    });

    // 3. Freeze recipient snapshot in notice_campaign_recipients
    const recipientRows = selection.finalRecipients.map((r) => ({
      campaignId: campaign.id,
      patientId: r.patientId,
      phoneE164: r.phoneE164,
      patientName: r.patientName,
      priority: r.priority,
      selectionReason: r.selectionReason,
      lastActivityAt: r.lastActivityAt,
      activityType: r.activityType,
      status: 'pending' as NoticeRecipientStatus,
      attempts: 0,
    }));

    await tx.insert(noticeCampaignRecipients).values(recipientRows);

    // 4. Update campaign status and summary counters
    await tx
      .update(noticeCampaigns)
      .set({
        status: 'scheduled',
        totalTargetRecipients: selection.finalRecipients.length,
        mandatoryRecipientsCount: selection.mandatoryIncludedCount,
        recentRecipientsCount: selection.totalSelectedRecipients - selection.mandatoryIncludedCount,
        displacedRecipientsCount: selection.displacedCount,
        ineligibleRecipientsCount: selection.ineligibleMandatoryCount,
        confirmedAt: new Date(),
        confirmedByUserId: params.actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(noticeCampaigns.id, campaign.id));

    return {
      alreadyConfirmed: false,
      campaignId: campaign.id,
      status: 'scheduled' as CampaignStatus,
      confirmedRecipientsCount: selection.finalRecipients.length,
    };
  });

  // Asynchronously trigger background queue drain
  if (!confirmed.alreadyConfirmed) {
    drainNoticeCampaignOutbox().catch((err) =>
      console.error('[whatsapp-notices] background drain trigger failed', err),
    );
  }

  return {
    success: true,
    campaignId: confirmed.campaignId,
    status: confirmed.status,
    confirmedRecipientsCount: confirmed.confirmedRecipientsCount,
  };
}

/**
 * Lists past and active campaigns for the hospital.
 */
export async function listNoticeCampaigns(params: {
  hospitalId: string;
  actor: NoticeActor;
}) {
  assertCanManageNotices(params.actor, params.hospitalId);

  const db = getAdminDb();
  return db
    .select({
      id: noticeCampaigns.id,
      noticeType: noticeCampaigns.noticeType,
      status: noticeCampaigns.status,
      title: noticeCampaigns.title,
      closureDate: noticeCampaigns.closureDate,
      closureEndDate: noticeCampaigns.closureEndDate,
      closureDuration: noticeCampaigns.closureDuration,
      totalTargetRecipients: noticeCampaigns.totalTargetRecipients,
      sentCount: noticeCampaigns.sentCount,
      deliveredCount: noticeCampaigns.deliveredCount,
      readCount: noticeCampaigns.readCount,
      failedCount: noticeCampaigns.failedCount,
      suppressedCount: noticeCampaigns.suppressedCount,
      createdAt: noticeCampaigns.createdAt,
      confirmedAt: noticeCampaigns.confirmedAt,
      completedAt: noticeCampaigns.completedAt,
    })
    .from(noticeCampaigns)
    .where(eq(noticeCampaigns.hospitalId, params.hospitalId))
    .orderBy(desc(noticeCampaigns.createdAt));
}

/**
 * Gets campaign details and live progress metrics.
 */
export async function getNoticeCampaignDetails(params: {
  campaignId: string;
  hospitalId: string;
  actor: NoticeActor;
}) {
  assertCanManageNotices(params.actor, params.hospitalId);

  const db = getAdminDb();

  const [campaign] = await db
    .select({
      id: noticeCampaigns.id,
      hospitalId: noticeCampaigns.hospitalId,
      noticeType: noticeCampaigns.noticeType,
      status: noticeCampaigns.status,
      title: noticeCampaigns.title,
      closureDate: noticeCampaigns.closureDate,
      closureEndDate: noticeCampaigns.closureEndDate,
      closureDuration: noticeCampaigns.closureDuration,
      reason: noticeCampaigns.reason,
      rescheduleInstructions: noticeCampaigns.rescheduleInstructions,
      contactPhone: noticeCampaigns.contactPhone,
      templateCode: noticeCampaigns.templateCode,
      templateVariables: noticeCampaigns.templateVariables,
      totalTargetRecipients: noticeCampaigns.totalTargetRecipients,
      mandatoryRecipientsCount: noticeCampaigns.mandatoryRecipientsCount,
      recentRecipientsCount: noticeCampaigns.recentRecipientsCount,
      displacedRecipientsCount: noticeCampaigns.displacedRecipientsCount,
      ineligibleRecipientsCount: noticeCampaigns.ineligibleRecipientsCount,
      sentCount: noticeCampaigns.sentCount,
      deliveredCount: noticeCampaigns.deliveredCount,
      readCount: noticeCampaigns.readCount,
      failedCount: noticeCampaigns.failedCount,
      suppressedCount: noticeCampaigns.suppressedCount,
      pendingCapacityCount: noticeCampaigns.pendingCapacityCount,
      confirmedAt: noticeCampaigns.confirmedAt,
      confirmedByUserId: noticeCampaigns.confirmedByUserId,
      completedAt: noticeCampaigns.completedAt,
      cancelledAt: noticeCampaigns.cancelledAt,
      createdAt: noticeCampaigns.createdAt,
      updatedAt: noticeCampaigns.updatedAt,
      confirmedByName: users.name,
    })
    .from(noticeCampaigns)
    .leftJoin(users, eq(users.id, noticeCampaigns.confirmedByUserId))
    .where(
      and(
        eq(noticeCampaigns.id, params.campaignId),
        eq(noticeCampaigns.hospitalId, params.hospitalId),
      ),
    );

  if (!campaign) throw new Error('Notice campaign not found');

  return campaign;
}

/**
 * Paginated recipient list for a campaign.
 */
export async function listCampaignRecipients(params: {
  campaignId: string;
  hospitalId: string;
  actor: NoticeActor;
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
}) {
  assertCanManageNotices(params.actor, params.hospitalId);

  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(10, params.pageSize ?? 25));
  const offset = (page - 1) * pageSize;

  const db = getAdminDb();

  // Verify campaign belongs to hospital
  const [campaign] = await db
    .select({ id: noticeCampaigns.id })
    .from(noticeCampaigns)
    .where(
      and(
        eq(noticeCampaigns.id, params.campaignId),
        eq(noticeCampaigns.hospitalId, params.hospitalId),
      ),
    );

  if (!campaign) throw new Error('Notice campaign not found');

  const conditions = [eq(noticeCampaignRecipients.campaignId, params.campaignId)];

  if (params.status && params.status !== 'all') {
    conditions.push(eq(noticeCampaignRecipients.status, params.status as NoticeRecipientStatus));
  }

  if (params.search) {
    const q = `%${params.search.trim()}%`;
    conditions.push(
      or(
        sql`${noticeCampaignRecipients.phoneE164} ilike ${q}`,
        sql`${noticeCampaignRecipients.patientName} ilike ${q}`,
      )!,
    );
  }

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(noticeCampaignRecipients)
    .where(and(...conditions));

  const total = countRow?.count ?? 0;

  const items = await db
    .select({
      id: noticeCampaignRecipients.id,
      patientId: noticeCampaignRecipients.patientId,
      phoneE164: noticeCampaignRecipients.phoneE164,
      patientName: noticeCampaignRecipients.patientName,
      priority: noticeCampaignRecipients.priority,
      selectionReason: noticeCampaignRecipients.selectionReason,
      lastActivityAt: noticeCampaignRecipients.lastActivityAt,
      activityType: noticeCampaignRecipients.activityType,
      status: noticeCampaignRecipients.status,
      attempts: noticeCampaignRecipients.attempts,
      sentAt: noticeCampaignRecipients.sentAt,
      deliveredAt: noticeCampaignRecipients.deliveredAt,
      readAt: noticeCampaignRecipients.readAt,
      failedReason: noticeCampaignRecipients.failedReason,
    })
    .from(noticeCampaignRecipients)
    .where(and(...conditions))
    .orderBy(desc(noticeCampaignRecipients.priority), desc(noticeCampaignRecipients.lastActivityAt))
    .limit(pageSize)
    .offset(offset);

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/**
 * Cancels a notice campaign and releases unused reserved capacity.
 */
export async function cancelNoticeCampaign(params: {
  campaignId: string;
  hospitalId: string;
  actor: NoticeActor;
}): Promise<{ cancelledRecipients: number }> {
  assertCanManageNotices(params.actor, params.hospitalId);

  const db = getAdminDb();

  const [campaign] = await db
    .select({ id: noticeCampaigns.id, status: noticeCampaigns.status })
    .from(noticeCampaigns)
    .where(
      and(
        eq(noticeCampaigns.id, params.campaignId),
        eq(noticeCampaigns.hospitalId, params.hospitalId),
      ),
    );

  if (!campaign) throw new Error('Notice campaign not found');
  if (campaign.status === 'completed' || campaign.status === 'cancelled') {
    throw new Error(`Cannot cancel campaign in ${campaign.status} status`);
  }

  // Cancel unsent recipients
  const cancelledRows = await db
    .update(noticeCampaignRecipients)
    .set({
      status: 'cancelled',
      failedReason: 'campaign_cancelled_by_admin',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(noticeCampaignRecipients.campaignId, params.campaignId),
        inArray(noticeCampaignRecipients.status, ['pending', 'queued']),
      ),
    )
    .returning({ id: noticeCampaignRecipients.id });

  // Update campaign status
  await db
    .update(noticeCampaigns)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(noticeCampaigns.id, params.campaignId));

  // Release capacity
  await releaseCampaignCapacity(params.campaignId);

  return { cancelledRecipients: cancelledRows.length };
}
