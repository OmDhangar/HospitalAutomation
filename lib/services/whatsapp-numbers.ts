import { asc, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import { auditLogs, hospitals, whatsappNumbers } from '@/lib/db/schema';
import { isPlausiblePhoneNumberId } from '@/lib/domain/whatsapp-integration';
import { MetaAdminError, fetchPhoneNumber } from '@/lib/notify/meta-admin';
import {
  IntegrationAuthError,
  IntegrationError,
  type Actor,
} from './whatsapp-integration';

/**
 * Operational state of the WhatsApp sender numbers themselves.
 *
 * Kept apart from `whatsapp-integration.ts`, which owns onboarding and
 * credentials. This module answers "which number, and is it working" and does
 * not decide who may change that — assignment and disconnection are integration
 * operations, and live there so that authorization, provider verification and
 * audit are written once rather than in two places that drift.
 */

export type HospitalNumber = {
  id: string;
  phoneNumberId: string;
  wabaId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: 'pending' | 'registered' | 'flagged' | 'suspended' | 'released';
  qualityRating: string | null;
  messagingTier: string | null;
};

/** The sender number for one hospital, if it has been assigned one. */
export async function getHospitalNumber(hospitalId: string): Promise<HospitalNumber | null> {
  return withTenant(hospitalId, async (tx) => {
    const [row] = await tx
      .select({
        id: whatsappNumbers.id,
        phoneNumberId: whatsappNumbers.phoneNumberId,
        wabaId: whatsappNumbers.wabaId,
        displayPhoneNumber: whatsappNumbers.displayPhoneNumber,
        verifiedName: whatsappNumbers.verifiedName,
        status: whatsappNumbers.status,
        qualityRating: whatsappNumbers.qualityRating,
        messagingTier: whatsappNumbers.messagingTier,
      })
      .from(whatsappNumbers)
      .where(eq(whatsappNumbers.hospitalId, hospitalId));
    return row ?? null;
  });
}

/*
 * `markNumberRegistered` used to live here and has been removed deliberately.
 *
 * It set status='registered' on an owner's say-so, which is the one thing that
 * must never be assertable from the application: `resolve_whatsapp_number`
 * routes inbound patient messages on exactly that column. Registration is now
 * only ever written by `validateConnection`, from what Meta reports about the
 * number — see lib/services/whatsapp-integration.ts.
 */

export type NumberInventoryRow = HospitalNumber & {
  hospitalId: string | null;
  hospitalName: string | null;
};

/**
 * Every number we hold, assigned or not.
 *
 * Platform-only: it spans tenants and includes unassigned inventory, so it runs
 * on the admin connection and belongs behind the isPlatformAdmin check.
 */
export async function listAllNumbers(): Promise<NumberInventoryRow[]> {
  return getAdminDb()
    .select({
      id: whatsappNumbers.id,
      hospitalId: whatsappNumbers.hospitalId,
      hospitalName: hospitals.name,
      phoneNumberId: whatsappNumbers.phoneNumberId,
      wabaId: whatsappNumbers.wabaId,
      displayPhoneNumber: whatsappNumbers.displayPhoneNumber,
      verifiedName: whatsappNumbers.verifiedName,
      status: whatsappNumbers.status,
      qualityRating: whatsappNumbers.qualityRating,
      messagingTier: whatsappNumbers.messagingTier,
    })
    .from(whatsappNumbers)
    .leftJoin(hospitals, eq(hospitals.id, whatsappNumbers.hospitalId))
    .orderBy(asc(hospitals.name));
}

/** Numbers bought but not yet given to a hospital. */
export async function listUnassignedNumbers(): Promise<HospitalNumber[]> {
  return getAdminDb()
    .select({
      id: whatsappNumbers.id,
      phoneNumberId: whatsappNumbers.phoneNumberId,
      wabaId: whatsappNumbers.wabaId,
      displayPhoneNumber: whatsappNumbers.displayPhoneNumber,
      verifiedName: whatsappNumbers.verifiedName,
      status: whatsappNumbers.status,
      qualityRating: whatsappNumbers.qualityRating,
      messagingTier: whatsappNumbers.messagingTier,
    })
    .from(whatsappNumbers)
    .where(isNull(whatsappNumbers.hospitalId))
    .orderBy(asc(whatsappNumbers.createdAt));
}

/**
 * Hospitals with no sender number at all.
 *
 * The platform onboarding queue, in one query: these are the customers paying
 * for WhatsApp features that cannot yet send anything.
 */
export async function listHospitalsAwaitingNumber() {
  const assigned = await getAdminDb()
    .select({ hospitalId: whatsappNumbers.hospitalId })
    .from(whatsappNumbers);
  const taken = new Set(assigned.map((row) => row.hospitalId).filter(Boolean));

  const all = await getAdminDb()
    .select({ id: hospitals.id, name: hospitals.name })
    .from(hospitals)
    .where(eq(hospitals.active, true))
    .orderBy(asc(hospitals.name));

  return all.filter((hospital) => !taken.has(hospital.id));
}

/**
 * Records the quality rating and throughput tier Meta reports for a number.
 *
 * Worth watching per hospital: quality is scored per number, but Meta's
 * throughput limit applies across the whole business portfolio, so one hospital
 * whose patients block messages can drag down everyone else's sending capacity.
 * That shared fate is the main argument for keeping messages few and wanted.
 */
export async function recordNumberHealth(args: {
  phoneNumberId: string;
  qualityRating?: string | null;
  messagingTier?: string | null;
  status?: 'pending' | 'registered' | 'flagged' | 'suspended' | 'released';
}) {
  return getAdminDb()
    .update(whatsappNumbers)
    .set({
      qualityRating: args.qualityRating ?? null,
      messagingTier: args.messagingTier ?? null,
      ...(args.status ? { status: args.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(whatsappNumbers.phoneNumberId, args.phoneNumberId));
}

export type HealthRefresh = {
  phoneNumberId: string;
  qualityRating: string | null;
  messagingTier: string | null;
};

/**
 * Asks Meta for the current quality rating and throughput tier, and stores it.
 *
 * Quality is the early warning that matters: a rating falling to YELLOW is
 * something a hospital can still act on by sending fewer, more wanted messages.
 * By the time Meta suspends a number the conversation with the customer is a
 * very different one, so this is worth a manual refresh on the platform
 * dashboard rather than waiting to discover it from a failed send.
 *
 * Platform-only, because the refresh spans tenants and uses our credential.
 */
export async function refreshNumberHealth(args: {
  phoneNumberId: string;
  actor: Actor;
}): Promise<HealthRefresh> {
  if (!args.actor.isPlatformAdmin) {
    throw new IntegrationAuthError('Platform administrator access required');
  }

  const phoneNumberId = args.phoneNumberId.trim();
  if (!isPlausiblePhoneNumberId(phoneNumberId)) {
    throw new IntegrationError('INVALID_PHONE_NUMBER');
  }

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) throw new IntegrationError('CONFIGURATION_ERROR');

  let number;
  try {
    number = await fetchPhoneNumber({ phoneNumberId, accessToken });
  } catch (error) {
    throw new IntegrationError(
      error instanceof MetaAdminError ? error.errorCode : 'UNKNOWN_PROVIDER_ERROR',
    );
  }

  await recordNumberHealth({
    phoneNumberId,
    qualityRating: number.qualityRating,
    messagingTier: number.messagingTier,
  });

  console.log(
    '[whatsapp:health.refreshed]',
    JSON.stringify({
      phone_number_id: phoneNumberId,
      operation: 'refresh_health',
      result: 'success',
      quality_rating: number.qualityRating,
      messaging_tier: number.messagingTier,
    }),
  );

  return {
    phoneNumberId,
    qualityRating: number.qualityRating,
    messagingTier: number.messagingTier,
  };
}

/**
 * Returns a number to unassigned inventory.
 *
 * Separate from disconnecting an integration: disconnecting stops a hospital
 * using its number and leaves the row attributed to them, which is what keeps
 * their audit trail readable. This is the later, deliberate step where we take
 * the SIM back for the next customer.
 */
export async function returnNumberToInventory(args: {
  phoneNumberId: string;
  actor: Actor;
  requestId?: string;
}): Promise<void> {
  if (!args.actor.isPlatformAdmin) {
    throw new IntegrationAuthError('Platform administrator access required');
  }

  const admin = getAdminDb();
  await admin.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: whatsappNumbers.id, hospitalId: whatsappNumbers.hospitalId })
      .from(whatsappNumbers)
      .where(eq(whatsappNumbers.phoneNumberId, args.phoneNumberId.trim()));

    if (!row) throw new IntegrationError('INVALID_PHONE_NUMBER');

    await tx
      .update(whatsappNumbers)
      .set({
        hospitalId: null,
        status: 'released',
        verifiedName: null,
        qualityRating: null,
        messagingTier: null,
        registeredAt: null,
        updatedAt: new Date(),
      })
      .where(eq(whatsappNumbers.id, row.id));

    // Attributed to the hospital that held it, so the release still appears in
    // their own audit trail after the number has moved on.
    if (row.hospitalId) {
      await tx.insert(auditLogs).values({
        hospitalId: row.hospitalId,
        actorUserId: args.actor.userId,
        action: 'whatsapp.number.released',
        objectType: 'whatsapp_integration',
        objectId: args.phoneNumberId.trim(),
        metadata: {
          provider: 'meta',
          phone_number_id: args.phoneNumberId.trim(),
          result: 'success',
          returned_to_inventory: true,
        },
        requestId: args.requestId ?? null,
      });
    }
  });
}
