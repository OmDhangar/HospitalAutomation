import { and, eq, gte, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import type { Tx } from '@/lib/db';
import {
  noticeCampaignRecipients,
  notificationOutbox,
  whatsappCapacityReservations,
  whatsappNumbers,
} from '@/lib/db/schema';
import {
  calculateAvailableAccountCapacity,
  resolveTierLimit,
  type CapacityCalculationResult,
} from '@/lib/domain/whatsapp-capacity';
import { getHospitalNumber } from './whatsapp-numbers';

export class InsufficientCapacityError extends Error {
  constructor(
    public readonly requestedSlots: number,
    public readonly availableCapacity: number,
  ) {
    super(
      `Insufficient WhatsApp account capacity: requested ${requestedSlots} slots, but only ${availableCapacity} slots are currently available.`,
    );
    this.name = 'InsufficientCapacityError';
  }
}

/**
 * Derives current WhatsApp account capacity for a hospital based on Meta tier,
 * 24-hour rolling usage, and outstanding active reservations.
 */
export async function getAccountCapacity(
  hospitalId: string,
  now: Date = new Date(),
): Promise<CapacityCalculationResult & { phoneNumberId: string | null; messagingTier: string | null }> {
  const db = getAdminDb();
  const numberConfig = await getHospitalNumber(hospitalId);

  if (!numberConfig?.phoneNumberId) {
    // If no number configured yet, report 0 capacity
    return {
      tierLimit: 0,
      consumedLast24h: 0,
      activeReservations: 0,
      safetyBuffer: 10,
      totalCommitted: 10,
      availableCapacity: 0,
      effectiveCampaignCap: 0,
      phoneNumberId: null,
      messagingTier: null,
    };
  }

  const phoneNumberId = numberConfig.phoneNumberId;
  const tierLimit = resolveTierLimit(numberConfig.messagingTier);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Calculate unique recipients sent to in the last 24 hours across notice campaigns
  const [noticeSent] = await db
    .select({
      count: sql<number>`count(distinct ${noticeCampaignRecipients.phoneE164})::int`,
    })
    .from(noticeCampaignRecipients)
    .where(
      and(
        eq(noticeCampaignRecipients.status, 'sent'),
        gte(noticeCampaignRecipients.sentAt, twentyFourHoursAgo),
      ),
    );

  // 2. Calculate unique recipients sent to in the last 24 hours across notification outbox
  const [outboxSent] = await db
    .select({
      count: sql<number>`count(distinct ${notificationOutbox.patientId})::int`,
    })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.hospitalId, hospitalId),
        eq(notificationOutbox.status, 'sent'),
        gte(notificationOutbox.sentAt, twentyFourHoursAgo),
      ),
    );

  const consumedLast24h = (noticeSent?.count ?? 0) + (outboxSent?.count ?? 0);

  // 3. Sum of active reservations that have not yet expired
  const [activeReservationsRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${whatsappCapacityReservations.reservedSlots} - ${whatsappCapacityReservations.releasedSlots}), 0)::int`,
    })
    .from(whatsappCapacityReservations)
    .where(
      and(
        eq(whatsappCapacityReservations.phoneNumberId, phoneNumberId),
        eq(whatsappCapacityReservations.status, 'active'),
        gte(whatsappCapacityReservations.expiresAt, now),
      ),
    );

  const activeReservations = activeReservationsRow?.total ?? 0;

  const bufferEnv = process.env.WHATSAPP_CAPACITY_SAFETY_BUFFER;
  const safetyBuffer = bufferEnv && !Number.isNaN(Number(bufferEnv)) ? Number(bufferEnv) : 10;

  const calculation = calculateAvailableAccountCapacity({
    tierLimit,
    consumedLast24h,
    activeReservations,
    safetyBuffer,
  });

  return {
    ...calculation,
    phoneNumberId,
    messagingTier: numberConfig.messagingTier,
  };
}

/**
 * Atomically reserves capacity for a campaign within a database transaction.
 * Takes a row lock on whatsapp_numbers to prevent race conditions from concurrent campaigns.
 */
export async function reserveCampaignCapacityInTx(
  tx: Tx,
  params: {
    hospitalId: string;
    campaignId: string;
    slots: number;
    durationMinutes?: number;
    now?: Date;
  },
): Promise<{ reservationId: string }> {
  const now = params.now ?? new Date();
  const durationMs = (params.durationMinutes ?? 60) * 60 * 1000;
  const expiresAt = new Date(now.getTime() + durationMs);

  // Lock the hospital's whatsapp_numbers row to serialize concurrent capacity reservations
  const [lockedNumber] = await tx
    .select({
      id: whatsappNumbers.id,
      phoneNumberId: whatsappNumbers.phoneNumberId,
      messagingTier: whatsappNumbers.messagingTier,
    })
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.hospitalId, params.hospitalId))
    .for('update');

  if (!lockedNumber?.phoneNumberId) {
    throw new Error('Cannot reserve capacity: No registered WhatsApp number found for this hospital.');
  }

  const capacity = await getAccountCapacity(params.hospitalId, now);

  if (capacity.availableCapacity < params.slots) {
    throw new InsufficientCapacityError(params.slots, capacity.availableCapacity);
  }

  const [reservation] = await tx
    .insert(whatsappCapacityReservations)
    .values({
      hospitalId: params.hospitalId,
      phoneNumberId: lockedNumber.phoneNumberId,
      campaignId: params.campaignId,
      reservedSlots: params.slots,
      consumedSlots: 0,
      releasedSlots: 0,
      status: 'active',
      expiresAt,
    })
    .returning({ id: whatsappCapacityReservations.id });

  return { reservationId: reservation.id };
}

/**
 * Commits a reservation once sending begins or completes.
 */
export async function commitCampaignCapacity(
  campaignId: string,
  consumedSlots: number,
): Promise<void> {
  const db = getAdminDb();
  await db
    .update(whatsappCapacityReservations)
    .set({
      status: 'committed',
      consumedSlots,
    })
    .where(eq(whatsappCapacityReservations.campaignId, campaignId));
}

/**
 * Releases reserved capacity if a campaign is cancelled or completes with unused slots.
 */
export async function releaseCampaignCapacity(campaignId: string): Promise<void> {
  const db = getAdminDb();
  const [reservation] = await db
    .select({
      reservedSlots: whatsappCapacityReservations.reservedSlots,
      consumedSlots: whatsappCapacityReservations.consumedSlots,
    })
    .from(whatsappCapacityReservations)
    .where(eq(whatsappCapacityReservations.campaignId, campaignId));

  if (!reservation) return;

  const releasedSlots = Math.max(0, reservation.reservedSlots - reservation.consumedSlots);

  await db
    .update(whatsappCapacityReservations)
    .set({
      status: 'released',
      releasedSlots,
    })
    .where(eq(whatsappCapacityReservations.campaignId, campaignId));
}
