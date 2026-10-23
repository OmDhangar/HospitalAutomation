import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import {
  hospitals,
  noticeCampaigns,
  noticeCampaignRecipients,
  patients,
  webhookEventDedup,
  whatsappCapacityReservations,
  whatsappIntegrations,
  whatsappNumbers,
  whatsappOptOuts,
} from '@/lib/db/schema';
import type { Locale } from '@/lib/i18n/patient';
import { isMockPhone, normalizeIndianPhone } from '@/lib/domain/phone';
import { formatClosureNoticePeriod } from '@/lib/domain/notice-dates';
import { openCredential } from '@/lib/security/credentials';
import { isRetryableMetaError, isTemplateUnderReview, ProviderError } from './errors';
import { getProvider, MetaCloudProvider, type NotificationProvider } from './provider';
import type { TemplateCode } from './templates';
import { commitCampaignCapacity } from '@/lib/services/notice-capacity';

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;
const STUCK_AFTER_MINUTES = 5;

/** Exponential backoff with jitter so retries do not synchronize. */
export function backoffWithJitter(attempts: number): number {
  const base = Math.min(3600, 30 * 2 ** attempts);
  const jitter = Math.floor(Math.random() * 6);
  return base + jitter;
}

export type NoticeDrainResult = {
  processed: number;
  sent: number;
  failed: number;
  suppressed: number;
  cancelled: number;
};

/**
 * Resolves a notification provider instance for a hospital, using its sealed
 * token if configured, or the global provider.
 */
async function getProviderForHospital(hospitalId: string): Promise<NotificationProvider> {
  const db = getAdminDb();
  const [integration] = await db
    .select({
      credentialCiphertext: whatsappIntegrations.credentialCiphertext,
      credentialIv: whatsappIntegrations.credentialIv,
      credentialAuthTag: whatsappIntegrations.credentialAuthTag,
      credentialKeyVersion: whatsappIntegrations.credentialKeyVersion,
    })
    .from(whatsappIntegrations)
    .where(eq(whatsappIntegrations.hospitalId, hospitalId));

  if (
    integration?.credentialCiphertext &&
    integration.credentialIv &&
    integration.credentialAuthTag &&
    integration.credentialKeyVersion
  ) {
    try {
      const token = openCredential({
        ciphertext: integration.credentialCiphertext,
        iv: integration.credentialIv,
        authTag: integration.credentialAuthTag,
        keyVersion: integration.credentialKeyVersion,
      });
      return new MetaCloudProvider(token);
    } catch (err) {
      console.error('[notice-worker] failed to open hospital credential', hospitalId, err);
    }
  }

  return getProvider();
}

/**
 * Claims and delivers pending messages from notice campaigns.
 */
export async function drainNoticeCampaignOutbox(
  now: Date = new Date(),
): Promise<NoticeDrainResult> {
  const db = getAdminDb();
  const result: NoticeDrainResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    suppressed: 0,
    cancelled: 0,
  };

  // 1. Reclaim stuck sending rows (in flight > STUCK_AFTER_MINUTES)
  await db
    .update(noticeCampaignRecipients)
    .set({ status: 'pending', claimedAt: null })
    .where(
      and(
        eq(noticeCampaignRecipients.status, 'sending'),
        lte(
          noticeCampaignRecipients.claimedAt,
          new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000),
        ),
      ),
    );

  // 2. Claim next batch with SKIP LOCKED ordered by priority DESC, scheduledFor ASC
  const claimedIds = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: noticeCampaignRecipients.id })
      .from(noticeCampaignRecipients)
      .where(
        and(
          eq(noticeCampaignRecipients.status, 'pending'),
          lte(noticeCampaignRecipients.scheduledFor, now),
        ),
      )
      .orderBy(
        sql`${noticeCampaignRecipients.priority} DESC`,
        sql`${noticeCampaignRecipients.scheduledFor} ASC`,
      )
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    await tx
      .update(noticeCampaignRecipients)
      .set({ status: 'sending', claimedAt: now })
      .where(inArray(noticeCampaignRecipients.id, ids));

    return ids;
  });

  if (claimedIds.length === 0) return result;
  result.processed = claimedIds.length;

  for (const id of claimedIds) {
    // Enrich with campaign, hospital and phone number settings
    const [row] = await db
      .select({
        id: noticeCampaignRecipients.id,
        campaignId: noticeCampaignRecipients.campaignId,
        patientId: noticeCampaignRecipients.patientId,
        phoneE164: noticeCampaignRecipients.phoneE164,
        attempts: noticeCampaignRecipients.attempts,
        campaignStatus: noticeCampaigns.status,
        hospitalId: noticeCampaigns.hospitalId,
        hospitalName: hospitals.name,
        hospitalDefaultLocale: hospitals.defaultLocale,
        noticeType: noticeCampaigns.noticeType,
        templateCode: noticeCampaigns.templateCode,
        templateVariables: noticeCampaigns.templateVariables,
        contactPhone: noticeCampaigns.contactPhone,
        closureDate: noticeCampaigns.closureDate,
        closureEndDate: noticeCampaigns.closureEndDate,
        reason: noticeCampaigns.reason,
        phoneNumberId: whatsappNumbers.phoneNumberId,
        patientLocale: patients.locale,
      })
      .from(noticeCampaignRecipients)
      .innerJoin(noticeCampaigns, eq(noticeCampaigns.id, noticeCampaignRecipients.campaignId))
      .innerJoin(hospitals, eq(hospitals.id, noticeCampaigns.hospitalId))
      .leftJoin(whatsappNumbers, eq(whatsappNumbers.hospitalId, noticeCampaigns.hospitalId))
      .leftJoin(patients, eq(patients.id, noticeCampaignRecipients.patientId))
      .where(eq(noticeCampaignRecipients.id, id));

    if (!row) {
      await db
        .update(noticeCampaignRecipients)
        .set({ status: 'failed', failedReason: 'orphaned_row' })
        .where(eq(noticeCampaignRecipients.id, id));
      result.failed += 1;
      continue;
    }

    // Check if campaign was cancelled in the meantime
    if (row.campaignStatus === 'cancelled') {
      await db
        .update(noticeCampaignRecipients)
        .set({ status: 'cancelled', failedReason: 'campaign_cancelled' })
        .where(eq(noticeCampaignRecipients.id, id));
      result.cancelled += 1;
      continue;
    }

    // Check mock phone
    if (isMockPhone(row.phoneE164)) {
      await db
        .update(noticeCampaignRecipients)
        .set({ status: 'suppressed', failedReason: 'mock_phone' })
        .where(eq(noticeCampaignRecipients.id, id));
      await incrementCampaignCounter(db, row.campaignId, 'suppressedCount');
      result.suppressed += 1;
      continue;
    }

    // Check if patient opted out in the meantime
    const [optOut] = await db
      .select({ id: whatsappOptOuts.id })
      .from(whatsappOptOuts)
      .where(
        and(
          eq(whatsappOptOuts.hospitalId, row.hospitalId),
          eq(whatsappOptOuts.phoneE164, row.phoneE164),
        ),
      );

    if (optOut) {
      await db
        .update(noticeCampaignRecipients)
        .set({ status: 'suppressed', failedReason: 'patient_opted_out' })
        .where(eq(noticeCampaignRecipients.id, id));
      await incrementCampaignCounter(db, row.campaignId, 'suppressedCount');
      result.suppressed += 1;
      continue;
    }

    // Check valid WhatsApp number ID
    const phoneNumberId =
      row.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'dev';

    const locale = (row.patientLocale ?? row.hospitalDefaultLocale ?? 'en') as Locale;
    const templateCode = row.templateCode as TemplateCode;
    const templateVarsObj = (row.templateVariables ?? {}) as Record<string, string>;

    let variables: string[];
    if (templateCode === 'hospital_closure_notice') {
      const { closurePeriodText, reopenDateText } = formatClosureNoticePeriod(
        row.closureDate ?? new Date().toISOString().split('T')[0],
        row.closureEndDate,
        locale,
        templateVarsObj.reopenDate,
      );

      variables = [
        String(templateVarsObj.hospitalName ?? row.hospitalName),
        String(templateVarsObj.closureDateText ?? closurePeriodText),
        String(templateVarsObj.reopenDateText ?? reopenDateText),
        String(templateVarsObj.contactPhone ?? row.contactPhone ?? ''),
      ];
    } else if (templateCode === 'general_announcement') {
      variables = [
        String(templateVarsObj.hospitalName ?? row.hospitalName),
        String(templateVarsObj.customMessage ?? templateVarsObj.message ?? row.reason ?? ''),
        String(templateVarsObj.contactPhone ?? row.contactPhone ?? ''),
      ];
    } else {
      variables = Object.values(templateVarsObj);
    }

    const provider = await getProviderForHospital(row.hospitalId);

    try {
      const sent = await provider.sendTemplate({
        phoneNumberId,
        toPhoneE164: row.phoneE164,
        templateCode,
        locale,
        variables,
      });

      await db
        .update(noticeCampaignRecipients)
        .set({
          status: 'sent',
          providerMessageId: sent.providerMessageId,
          sentAt: new Date(),
        })
        .where(eq(noticeCampaignRecipients.id, id));

      await incrementCampaignCounter(db, row.campaignId, 'sentCount');
      result.sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const permanent = error instanceof ProviderError && !error.retryable;
      const underReview =
        error instanceof ProviderError && isTemplateUnderReview(error.code);
      const limit = underReview ? 10 : MAX_ATTEMPTS;
      const giveUp = permanent || attempts >= limit;

      const failedReason = error instanceof Error ? error.message : String(error);

      await db
        .update(noticeCampaignRecipients)
        .set({
          status: giveUp ? 'failed' : 'pending',
          attempts,
          scheduledFor: new Date(now.getTime() + backoffWithJitter(attempts) * 1000),
          failedReason,
        })
        .where(eq(noticeCampaignRecipients.id, id));

      if (giveUp) {
        await incrementCampaignCounter(db, row.campaignId, 'failedCount');
        result.failed += 1;
      }
    }
  }

  // Check completion for affected campaigns
  await reconcileFinishedCampaigns(db);

  return result;
}

/** Atomically increments a campaign counter */
async function incrementCampaignCounter(
  db: ReturnType<typeof getAdminDb>,
  campaignId: string,
  field:
    | 'sentCount'
    | 'deliveredCount'
    | 'readCount'
    | 'failedCount'
    | 'suppressedCount',
) {
  const col = noticeCampaigns[field];
  await db
    .update(noticeCampaigns)
    .set({
      [field]: sql`${col} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(noticeCampaigns.id, campaignId));
}

/**
 * Transitions campaigns whose recipients have all completed from 'processing' to 'completed'.
 */
async function reconcileFinishedCampaigns(db: ReturnType<typeof getAdminDb>) {
  // Find campaigns in 'processing' or 'scheduled'
  const activeCampaigns = await db
    .select({ id: noticeCampaigns.id })
    .from(noticeCampaigns)
    .where(
      inArray(noticeCampaigns.status, ['scheduled', 'processing']),
    );

  for (const campaign of activeCampaigns) {
    const [pendingCountRow] = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(noticeCampaignRecipients)
      .where(
        and(
          eq(noticeCampaignRecipients.campaignId, campaign.id),
          inArray(noticeCampaignRecipients.status, ['pending', 'sending', 'queued']),
        ),
      );

    const pending = pendingCountRow?.count ?? 0;
    if (pending === 0) {
      // Check if any messages were sent vs failed
      const [stats] = await db
        .select({
          sent: noticeCampaigns.sentCount,
          failed: noticeCampaigns.failedCount,
        })
        .from(noticeCampaigns)
        .where(eq(noticeCampaigns.id, campaign.id));

      const newStatus =
        (stats?.sent ?? 0) > 0 ? 'completed' : (stats?.failed ?? 0) > 0 ? 'failed' : 'completed';

      await db
        .update(noticeCampaigns)
        .set({
          status: newStatus,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(noticeCampaigns.id, campaign.id));

      // Commit capacity accounting
      await commitCampaignCapacity(campaign.id, stats?.sent ?? 0);
    }
  }
}

/**
 * Processes incoming delivery status webhooks ('delivered', 'read', 'failed').
 * Fully idempotent using webhook_event_dedup.
 */
export async function processNoticeDeliveryStatus(args: {
  providerMessageId: string;
  status: string;
  errorMessage?: string;
}): Promise<boolean> {
  const db = getAdminDb();
  const dedupKey = `status:${args.providerMessageId}:${args.status}`;

  // Idempotency check
  const claimed = await db
    .insert(webhookEventDedup)
    .values({ eventId: dedupKey })
    .onConflictDoNothing()
    .returning({ id: webhookEventDedup.id });

  if (claimed.length === 0) {
    return false; // Already processed
  }

  const [recipient] = await db
    .select({
      id: noticeCampaignRecipients.id,
      campaignId: noticeCampaignRecipients.campaignId,
      currentStatus: noticeCampaignRecipients.status,
    })
    .from(noticeCampaignRecipients)
    .where(eq(noticeCampaignRecipients.providerMessageId, args.providerMessageId));

  if (!recipient) {
    return false; // Not a notice campaign recipient (could be regular appointment nudge)
  }

  const now = new Date();

  if (args.status === 'delivered') {
    await db
      .update(noticeCampaignRecipients)
      .set({
        status: 'delivered',
        deliveredAt: now,
        updatedAt: now,
      })
      .where(eq(noticeCampaignRecipients.id, recipient.id));

    await incrementCampaignCounter(db, recipient.campaignId, 'deliveredCount');
    return true;
  }

  if (args.status === 'read') {
    await db
      .update(noticeCampaignRecipients)
      .set({
        status: 'read',
        readAt: now,
        deliveredAt: sql`coalesce(${noticeCampaignRecipients.deliveredAt}, ${now})`,
        updatedAt: now,
      })
      .where(eq(noticeCampaignRecipients.id, recipient.id));

    await incrementCampaignCounter(db, recipient.campaignId, 'readCount');
    return true;
  }

  if (args.status === 'failed') {
    await db
      .update(noticeCampaignRecipients)
      .set({
        status: 'failed',
        failedReason: args.errorMessage ?? 'provider_delivery_failure',
        updatedAt: now,
      })
      .where(eq(noticeCampaignRecipients.id, recipient.id));

    await incrementCampaignCounter(db, recipient.campaignId, 'failedCount');
    return true;
  }

  return false;
}

/**
 * Handles inbound patient opt-out requests ("STOP", "UNSUBSCRIBE", "OPT OUT").
 */
export async function handleNoticeInboundOptOut(args: {
  hospitalId: string;
  fromPhone: string;
  text?: string;
}): Promise<boolean> {
  const text = args.text?.trim().toLowerCase();
  if (!text) return false;

  const isOptOutWord = /^(stop|unsubscribe|cancel|optout|opt-out)(\s+.*)?$/i.test(text);
  if (!isOptOutWord) return false;

  const phoneE164 = normalizeIndianPhone(args.fromPhone);
  if (!phoneE164) return false;

  const db = getAdminDb();

  // 1. Record opt-out
  await db
    .insert(whatsappOptOuts)
    .values({
      hospitalId: args.hospitalId,
      phoneE164,
      reason: 'inbound_stop',
    })
    .onConflictDoNothing();

  // 2. Clear patient whatsappOptInAt
  await db
    .update(patients)
    .set({ whatsappOptInAt: null })
    .where(
      and(
        eq(patients.hospitalId, args.hospitalId),
        eq(patients.phoneE164, phoneE164),
      ),
    );

  // 3. Suppress any pending notice recipients
  await db
    .update(noticeCampaignRecipients)
    .set({
      status: 'suppressed',
      failedReason: 'inbound_stop_opt_out',
    })
    .where(
      and(
        eq(noticeCampaignRecipients.phoneE164, phoneE164),
        inArray(noticeCampaignRecipients.status, ['pending', 'queued']),
      ),
    );

  return true;
}
