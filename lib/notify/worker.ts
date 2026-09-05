import { and, count, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import {
  appointments,
  notificationOutbox,
  patients,
  whatsappNumbers,
} from '@/lib/db/schema';
import { messageRatio, shouldSuppressNonCriticalMessages } from '@/lib/domain/pricing';
import type { Locale } from '@/lib/i18n/patient';
import { ProviderError } from './errors';
import { getProvider } from './provider';
import { isCritical, type TemplateCode } from './templates';

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;
/** A send that has been in flight longer than this is presumed dead. */
const STUCK_AFTER_MINUTES = 5;

export type DrainResult = {
  sent: number;
  failed: number;
  suppressed: number;
};

/** Exponential backoff, so a provider outage does not become a retry storm. */
const backoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** attempts);

/**
 * Sends whatever the queue engine has queued.
 *
 * Runs on the cross-tenant connection because a single pass covers every
 * hospital. Rows are claimed with SKIP LOCKED so two workers — or a worker and
 * a manual run — never send the same message twice.
 */
export async function drainOutbox(now: Date = new Date()): Promise<DrainResult> {
  const db = getAdminDb();
  const provider = getProvider();
  const result: DrainResult = { sent: 0, failed: 0, suppressed: 0 };

  // The margin canary, computed once per hospital per pass rather than per
  // message. Cheap, and the number cannot move meaningfully within one batch.
  const ratioCache = new Map<string, number | null>();

  /**
   * Reclaim anything a previous worker died holding. Without this, a crash
   * between claiming a row and sending it loses that message permanently —
   * which for a queue_link means a patient who never learns their token.
   */
  await db
    .update(notificationOutbox)
    .set({ status: 'pending', claimedAt: null })
    .where(
      and(
        eq(notificationOutbox.status, 'sending'),
        lte(
          notificationOutbox.claimedAt,
          new Date(now.getTime() - STUCK_AFTER_MINUTES * 60_000),
        ),
      ),
    );

  // Rows claimed before this column existed have no timestamp to age out on.
  await db
    .update(notificationOutbox)
    .set({ status: 'pending' })
    .where(
      and(eq(notificationOutbox.status, 'sending'), isNull(notificationOutbox.claimedAt)),
    );

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, 'pending'),
          lte(notificationOutbox.scheduledFor, now),
        ),
      )
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    await tx
      .update(notificationOutbox)
      .set({ status: 'sending', claimedAt: now })
      .where(sql`${notificationOutbox.id} in ${ids}`);

    return ids;
  });

  if (claimed.length === 0) return result;

  for (const id of claimed) {
    const [row] = await db
      .select({
        id: notificationOutbox.id,
        hospitalId: notificationOutbox.hospitalId,
        appointmentId: notificationOutbox.appointmentId,
        templateCode: notificationOutbox.templateCode,
        locale: notificationOutbox.locale,
        payload: notificationOutbox.payload,
        attempts: notificationOutbox.attempts,
        phoneE164: patients.phoneE164,
        patientLocale: patients.locale,
        tokenNumber: appointments.tokenNumber,
        publicToken: appointments.publicToken,
        phoneNumberId: whatsappNumbers.phoneNumberId,
      })
      .from(notificationOutbox)
      .innerJoin(patients, eq(patients.id, notificationOutbox.patientId))
      .innerJoin(appointments, eq(appointments.id, notificationOutbox.appointmentId))
      // Left join: a hospital without a number configured still has its
      // messages queued, they simply cannot be sent yet.
      .leftJoin(whatsappNumbers, eq(whatsappNumbers.hospitalId, notificationOutbox.hospitalId))
      .where(eq(notificationOutbox.id, id));

    if (!row) continue;

    const templateCode = row.templateCode as TemplateCode;

    // Circuit breaker. Only ever drops nudges, never a patient's token link.
    if (!isCritical(templateCode)) {
      if (!ratioCache.has(row.hospitalId)) {
        ratioCache.set(row.hospitalId, await hospitalMessageRatio(row.hospitalId, now));
      }
      if (shouldSuppressNonCriticalMessages(ratioCache.get(row.hospitalId) ?? null)) {
        await db
          .update(notificationOutbox)
          .set({
            status: 'suppressed',
            failedReason: 'messages-per-appointment above breach threshold',
          })
          .where(eq(notificationOutbox.id, id));
        result.suppressed += 1;
        continue;
      }
    }

    const locale = (row.locale ?? row.patientLocale ?? 'en') as Locale;
    const payload = (row.payload ?? {}) as Record<string, unknown>;

    const variables =
      templateCode === 'queue_link'
        ? [String(row.tokenNumber), String(payload.doctorName ?? '')]
        : [String(payload.patientsAhead ?? ''), String(payload.doctorName ?? '')];

    // Only the token travels; the domain is fixed in the approved template.
    const urlButtonParam =
      templateCode === 'queue_link' ? (row.publicToken ?? undefined) : undefined;

    try {
      const sent = await provider.sendTemplate({
        // Falls back to the environment number for single-tenant development.
        phoneNumberId: row.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'dev',
        toPhoneE164: row.phoneE164,
        templateCode,
        locale,
        variables,
        urlButtonParam,
      });

      await db
        .update(notificationOutbox)
        .set({
          status: 'sent',
          providerMessageId: sent.providerMessageId,
          sentAt: new Date(),
        })
        .where(eq(notificationOutbox.id, id));
      result.sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;

      /**
       * A permanent failure is not retried at all. Attempting a message to
       * someone who has no WhatsApp account five times over half an hour buries
       * the real reason under repeated noise, and every retry is billable.
       */
      const permanent = error instanceof ProviderError && !error.retryable;
      const giveUp = permanent || attempts >= MAX_ATTEMPTS;

      await db
        .update(notificationOutbox)
        .set({
          status: giveUp ? 'failed' : 'pending',
          attempts,
          scheduledFor: new Date(now.getTime() + backoffSeconds(attempts) * 1000),
          failedReason: error instanceof Error ? error.message : String(error),
        })
        .where(eq(notificationOutbox.id, id));

      if (giveUp) result.failed += 1;
    }
  }

  return result;
}

/** Outbound messages per completed appointment, this month, for one hospital. */
async function hospitalMessageRatio(
  hospitalId: string,
  now: Date,
): Promise<number | null> {
  const db = getAdminDb();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [completed] = await db
    .select({ value: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.hospitalId, hospitalId),
        eq(appointments.status, 'COMPLETED'),
        gte(appointments.completedAt, start),
      ),
    );

  const [messages] = await db
    .select({ value: count() })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.hospitalId, hospitalId),
        eq(notificationOutbox.status, 'sent'),
        gte(notificationOutbox.sentAt, start),
      ),
    );

  return messageRatio({
    messagesSent: Number(messages?.value ?? 0),
    completedAppointments: Number(completed?.value ?? 0),
  });
}
