import { asc, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import { hospitals, whatsappNumbers } from '@/lib/db/schema';

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

/**
 * Attaches a number to a hospital, or updates the one it already has.
 *
 * Status stays whatever it was for an existing row: registration is something
 * Meta confirms, not something a form field asserts.
 */
export async function assignNumberToHospital(args: {
  hospitalId: string;
  phoneNumberId: string;
  wabaId?: string | null;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
}) {
  return withTenant(args.hospitalId, async (tx) => {
    const [existing] = await tx
      .select({ id: whatsappNumbers.id })
      .from(whatsappNumbers)
      .where(eq(whatsappNumbers.hospitalId, args.hospitalId));

    const values = {
      phoneNumberId: args.phoneNumberId,
      wabaId: args.wabaId ?? null,
      displayPhoneNumber: args.displayPhoneNumber ?? null,
      verifiedName: args.verifiedName ?? null,
      updatedAt: new Date(),
    };

    if (existing) {
      await tx
        .update(whatsappNumbers)
        .set(values)
        .where(eq(whatsappNumbers.id, existing.id));
      return;
    }

    await tx
      .insert(whatsappNumbers)
      .values({ hospitalId: args.hospitalId, ...values });
  });
}

/** Marks a number live. Called once Meta confirms registration. */
export async function markNumberRegistered(hospitalId: string) {
  return withTenant(hospitalId, (tx) =>
    tx
      .update(whatsappNumbers)
      .set({ status: 'registered', registeredAt: new Date(), updatedAt: new Date() })
      .where(eq(whatsappNumbers.hospitalId, hospitalId)),
  );
}

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
export async function listUnassignedNumbers() {
  return getAdminDb()
    .select()
    .from(whatsappNumbers)
    .where(isNull(whatsappNumbers.hospitalId));
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
