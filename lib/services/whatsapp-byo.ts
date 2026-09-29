import { and, eq, ne } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import { auditLogs, whatsappIntegrations, whatsappNumbers } from '@/lib/db/schema';
import { isPlausiblePhoneNumberId } from '@/lib/domain/whatsapp-integration';
import {
  openCredential,
  sealCredential,
  type SealedCredential,
} from '@/lib/security/credentials';
import { safeEqual } from '@/lib/security/tokens';

/**
 * Binding a hospital to its own WhatsApp Business Account.
 *
 * The outbound half of this already existed — `resolveCredential` opens a
 * hospital's sealed access token and calls Meta as them. This module is the
 * inbound half, which did not: the verify token Meta echoes during the
 * subscription handshake, and the app secret every payload is signed with,
 * were read from the process environment.
 *
 * That is correct only while every WABA is subscribed to one Meta App. Under
 * hospital ownership each WABA sits behind its own app with its own secret, so
 * a single global secret rejects every signature but one. Hence per-hospital
 * secrets, and hence the per-hospital callback route that gives the webhook
 * something to look them up by — Meta's handshake carries no tenant identity,
 * so a shared URL cannot tell whose handshake it is.
 *
 * Everything here runs on the admin connection. It is called from the operator
 * console and, for the webhook, before any tenant context exists.
 */

export class WabaBindingError extends Error {
  constructor(
    readonly code:
      | 'INVALID_PHONE_NUMBER_ID'
      | 'MISSING_FIELD'
      | 'NUMBER_TAKEN'
      | 'NO_ENCRYPTION_KEY',
    message: string,
  ) {
    super(message);
    this.name = 'WabaBindingError';
  }
}

export type WabaBinding = {
  hospitalId: string;
  phoneNumberId: string;
  wabaId: string;
  businessId?: string | null;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  actorUserId?: string | null;
};

const required = (value: string | undefined | null, field: string): string => {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new WabaBindingError('MISSING_FIELD', `${field} is required.`);
  return trimmed;
};

/**
 * Stores everything needed to both send as a hospital and receive on its behalf.
 *
 * One transaction: a number bound without its secrets would answer Meta's
 * handshake and then fail every signature check, which looks like a Meta
 * outage rather than a half-finished setup.
 */
export async function bindHospitalWaba(args: WabaBinding): Promise<{ integrationId: string }> {
  const phoneNumberId = required(args.phoneNumberId, 'Phone number ID');
  if (!isPlausiblePhoneNumberId(phoneNumberId)) {
    throw new WabaBindingError(
      'INVALID_PHONE_NUMBER_ID',
      'That does not look like a Meta phone number ID.',
    );
  }

  const wabaId = required(args.wabaId, 'WhatsApp Business Account ID');
  const accessToken = required(args.accessToken, 'Access token');
  const verifyToken = required(args.verifyToken, 'Webhook verify token');
  const appSecret = required(args.appSecret, 'App secret');

  let sealedToken: SealedCredential;
  let sealedVerify: SealedCredential;
  let sealedSecret: SealedCredential;
  try {
    sealedToken = sealCredential(accessToken);
    sealedVerify = sealCredential(verifyToken);
    sealedSecret = sealCredential(appSecret);
  } catch {
    // Without WHATSAPP_ENCRYPTION_KEY there is nowhere safe to put these, and
    // storing them in the clear is not an acceptable fallback.
    throw new WabaBindingError(
      'NO_ENCRYPTION_KEY',
      'WHATSAPP_ENCRYPTION_KEY is not configured on this server.',
    );
  }

  const db = getAdminDb();

  return db.transaction(async (tx) => {
    /**
     * A phone number id identifies one sender at Meta. Letting two hospitals
     * claim the same one would route somebody else's patients into this
     * hospital's queue, so it is refused rather than resolved by last-write.
     */
    const [taken] = await tx
      .select({ hospitalId: whatsappNumbers.hospitalId })
      .from(whatsappNumbers)
      .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));

    // Re-binding the same hospital is a credential rotation, not a clash.
    if (taken && taken.hospitalId && taken.hospitalId !== args.hospitalId) {
      throw new WabaBindingError(
        'NUMBER_TAKEN',
        'That number is already bound to another hospital.',
      );
    }

    const [integration] = await tx
      .insert(whatsappIntegrations)
      .values({
        hospitalId: args.hospitalId,
        provider: 'meta',
        ownership: 'hospital',
        onboardingMethod: 'manual',
        status: 'connected',
        wabaId,
        businessId: args.businessId?.trim() || null,
        credentialCiphertext: sealedToken.ciphertext,
        credentialIv: sealedToken.iv,
        credentialAuthTag: sealedToken.authTag,
        credentialKeyVersion: sealedToken.keyVersion,
        verifyTokenCiphertext: sealedVerify.ciphertext,
        verifyTokenIv: sealedVerify.iv,
        verifyTokenAuthTag: sealedVerify.authTag,
        verifyTokenKeyVersion: sealedVerify.keyVersion,
        appSecretCiphertext: sealedSecret.ciphertext,
        appSecretIv: sealedSecret.iv,
        appSecretAuthTag: sealedSecret.authTag,
        appSecretKeyVersion: sealedSecret.keyVersion,
        connectedAt: new Date(),
        lastErrorCode: null,
        lastErrorAt: null,
      })
      .onConflictDoUpdate({
        // One integration per hospital; re-binding rotates the secrets in place.
        target: whatsappIntegrations.hospitalId,
        set: {
          ownership: 'hospital',
          status: 'connected',
          wabaId,
          businessId: args.businessId?.trim() || null,
          credentialCiphertext: sealedToken.ciphertext,
          credentialIv: sealedToken.iv,
          credentialAuthTag: sealedToken.authTag,
          credentialKeyVersion: sealedToken.keyVersion,
          verifyTokenCiphertext: sealedVerify.ciphertext,
          verifyTokenIv: sealedVerify.iv,
          verifyTokenAuthTag: sealedVerify.authTag,
          verifyTokenKeyVersion: sealedVerify.keyVersion,
          appSecretCiphertext: sealedSecret.ciphertext,
          appSecretIv: sealedSecret.iv,
          appSecretAuthTag: sealedSecret.authTag,
          appSecretKeyVersion: sealedSecret.keyVersion,
          connectedAt: new Date(),
          lastErrorCode: null,
          lastErrorAt: null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: whatsappIntegrations.id });

    /**
     * A hospital sends from exactly one number. Any other row still pointing at
     * this hospital is a sender it no longer uses — most often a platform-owned
     * number it had before bringing its own account — and leaving it attached
     * makes "which number does this hospital send from" ambiguous for every
     * reader, the console included.
     *
     * Unassigned rather than deleted: a platform-owned number goes back to
     * inventory for the next customer, and a row that recorded real traffic is
     * not ours to throw away.
     */
    await tx
      .update(whatsappNumbers)
      .set({ hospitalId: null, status: 'released', updatedAt: new Date() })
      .where(
        and(
          eq(whatsappNumbers.hospitalId, args.hospitalId),
          ne(whatsappNumbers.phoneNumberId, phoneNumberId),
        ),
      );

    await tx
      .insert(whatsappNumbers)
      .values({
        hospitalId: args.hospitalId,
        phoneNumberId,
        wabaId,
        displayPhoneNumber: args.displayPhoneNumber?.trim() || null,
        verifiedName: args.verifiedName?.trim() || null,
        status: 'registered',
        registeredAt: new Date(),
      })
      .onConflictDoUpdate({
        target: whatsappNumbers.phoneNumberId,
        set: {
          hospitalId: args.hospitalId,
          wabaId,
          status: 'registered',
          updatedAt: new Date(),
        },
      });

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId ?? null,
      action: 'whatsapp.integration.bound',
      objectType: 'whatsapp_integration',
      objectId: integration.id,
      /**
       * Identifiers only. The three secrets that were just stored must not
       * appear here — an audit log is the one table most likely to be read
       * casually, exported, or shipped to a log aggregator.
       */
      metadata: { phoneNumberId, wabaId, ownership: 'hospital' },
    });

    return { integrationId: integration.id };
  });
}

/* ------------------------------------------------------- inbound lookups */

/**
 * The verify token for one hospital, or null.
 *
 * Read on Meta's subscription handshake, which happens once per callback URL
 * and is not hot. Returns null rather than throwing on a platform-owned or
 * unbound hospital so the route can answer 403 without distinguishing "no such
 * hospital" from "wrong token" to whoever is probing.
 */
export async function resolveVerifyToken(hospitalId: string): Promise<string | null> {
  const [row] = await getAdminDb()
    .select({
      ownership: whatsappIntegrations.ownership,
      ciphertext: whatsappIntegrations.verifyTokenCiphertext,
      iv: whatsappIntegrations.verifyTokenIv,
      authTag: whatsappIntegrations.verifyTokenAuthTag,
      keyVersion: whatsappIntegrations.verifyTokenKeyVersion,
    })
    .from(whatsappIntegrations)
    .where(eq(whatsappIntegrations.hospitalId, hospitalId));

  if (!row || row.ownership !== 'hospital') return null;
  if (!row.ciphertext || !row.iv || !row.authTag || row.keyVersion === null) return null;

  try {
    return openCredential({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
    });
  } catch {
    return null;
  }
}

/** The app secret one hospital's payloads are signed with, or null. */
export async function resolveAppSecret(hospitalId: string): Promise<string | null> {
  const [row] = await getAdminDb()
    .select({
      ownership: whatsappIntegrations.ownership,
      ciphertext: whatsappIntegrations.appSecretCiphertext,
      iv: whatsappIntegrations.appSecretIv,
      authTag: whatsappIntegrations.appSecretAuthTag,
      keyVersion: whatsappIntegrations.appSecretKeyVersion,
    })
    .from(whatsappIntegrations)
    .where(eq(whatsappIntegrations.hospitalId, hospitalId));

  if (!row || row.ownership !== 'hospital') return null;
  if (!row.ciphertext || !row.iv || !row.authTag || row.keyVersion === null) return null;

  try {
    return openCredential({
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
    });
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison of the handshake token.
 *
 * `safeEqual` already length-checks, which leaks the token's length and
 * nothing else — the token is not a password and its length is not secret.
 */
export const verifyTokenMatches = (offered: string | null, expected: string | null): boolean =>
  Boolean(offered && expected && safeEqual(offered, expected));

/* ------------------------------------------------------------- read view */

export type BindingView = {
  ownership: 'platform' | 'hospital';
  status: string;
  wabaId: string | null;
  businessId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** Whether each secret is present. Never the values themselves. */
  hasAccessToken: boolean;
  hasVerifyToken: boolean;
  hasAppSecret: boolean;
  connectedAt: Date | null;
};

/**
 * What the console renders. Deliberately reports only whether each secret
 * exists: nothing that decrypts one belongs in a page's props, where it would
 * travel to the browser inside the flight payload.
 */
export async function getBindingView(hospitalId: string): Promise<BindingView | null> {
  const [row] = await getAdminDb()
    .select({
      ownership: whatsappIntegrations.ownership,
      status: whatsappIntegrations.status,
      wabaId: whatsappIntegrations.wabaId,
      businessId: whatsappIntegrations.businessId,
      credentialCiphertext: whatsappIntegrations.credentialCiphertext,
      verifyTokenCiphertext: whatsappIntegrations.verifyTokenCiphertext,
      appSecretCiphertext: whatsappIntegrations.appSecretCiphertext,
      connectedAt: whatsappIntegrations.connectedAt,
    })
    .from(whatsappIntegrations)
    .where(eq(whatsappIntegrations.hospitalId, hospitalId));

  if (!row) return null;

  const [number] = await getAdminDb()
    .select({
      phoneNumberId: whatsappNumbers.phoneNumberId,
      displayPhoneNumber: whatsappNumbers.displayPhoneNumber,
      verifiedName: whatsappNumbers.verifiedName,
    })
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.hospitalId, hospitalId))
    .limit(1);

  return {
    ownership: row.ownership,
    status: row.status,
    wabaId: row.wabaId,
    businessId: row.businessId,
    phoneNumberId: number?.phoneNumberId ?? null,
    displayPhoneNumber: number?.displayPhoneNumber ?? null,
    verifiedName: number?.verifiedName ?? null,
    hasAccessToken: row.credentialCiphertext !== null,
    hasVerifyToken: row.verifyTokenCiphertext !== null,
    hasAppSecret: row.appSecretCiphertext !== null,
    connectedAt: row.connectedAt,
  };
}
