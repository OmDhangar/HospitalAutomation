import { eq } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import { auditLogs, whatsappIntegrations, whatsappNumbers } from '@/lib/db/schema';
import {
  deriveHealth,
  integrationErrorMessage,
  isPlausiblePhoneNumberId,
  maskIdentifier,
  type ConnectionHealth,
  type IntegrationErrorCode,
  type IntegrationStatus,
  type NumberStatus,
} from '@/lib/domain/whatsapp-integration';
import {
  MetaAdminError,
  verifyNumberBelongsToWaba,
  type MetaPhoneNumber,
} from '@/lib/notify/meta-admin';
import { openCredential } from '@/lib/security/credentials';
import { consumeToken, VALIDATION_LIMIT } from '@/lib/security/rate-limit';
import type { StaffRole } from './auth';

/**
 * Onboarding and administration of one hospital's WhatsApp integration.
 *
 * The shape of this module follows from one product decision, documented in
 * docs/runbooks/whatsapp-setup.md: under platform ownership the hospital never
 * touches Meta. So the tenant-facing operations here are *read*, *validate* and
 * *disconnect* — not "paste your credentials". Asking a clinic owner for a
 * phone number id is asking them to go and find something they have no way of
 * knowing, which is how onboarding stalls.
 *
 * Number assignment therefore lives on the platform-admin path, where it
 * belongs, and the hospital-owned path exists in the data model without being
 * the shape the UI is built around.
 */

/* ------------------------------------------------------------ authorization */

export type Actor = {
  userId: string;
  role: StaffRole;
  isPlatformAdmin: boolean;
};

/**
 * Thrown rather than returned so that a caller which forgets to branch fails
 * closed. Every exported mutation asserts for itself, even though the action
 * layer has already checked — the check that matters is the one nearest the
 * data.
 */
export class IntegrationAuthError extends Error {
  constructor(message = 'Not permitted to manage the WhatsApp integration') {
    super(message);
    this.name = 'IntegrationAuthError';
  }
}

/**
 * A failure already reduced to a category and a safe sentence.
 *
 * `message` is shown to the hospital; `errorCode` is what gets persisted,
 * logged and audited. The provider's own wording never appears in either.
 */
export class IntegrationError extends Error {
  constructor(
    readonly errorCode: IntegrationErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(integrationErrorMessage(errorCode));
    this.name = 'IntegrationError';
  }
}

/** Receptionists and doctors run the queue; only an owner changes what sends. */
function assertCanManage(actor: Actor) {
  if (actor.isPlatformAdmin) return;
  if (actor.role !== 'owner') throw new IntegrationAuthError();
}

function assertPlatformAdmin(actor: Actor) {
  if (!actor.isPlatformAdmin) {
    throw new IntegrationAuthError('Platform administrator access required');
  }
}

/* ------------------------------------------------------------------- views */

/**
 * Everything the settings page is allowed to know.
 *
 * Note what is absent: no ciphertext, no key version, no unmasked WABA or
 * phone number id, no provider error text. This type is the boundary — if a
 * field is not here it cannot reach a React component, because nothing else is
 * exported that returns integration rows.
 */
export type IntegrationView = {
  configured: boolean;
  status: IntegrationStatus;
  ownership: 'platform' | 'hospital';
  provider: string;
  health: ConnectionHealth;
  wabaIdMasked: string | null;
  phoneNumberIdMasked: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  numberStatus: NumberStatus | null;
  qualityRating: string | null;
  messagingTier: string | null;
  connectedAt: Date | null;
  lastValidatedAt: Date | null;
  /** A safe sentence, or null. Never the provider's wording. */
  lastError: string | null;
  lastErrorAt: Date | null;
  /** True when messages will actually reach patients right now. */
  live: boolean;
};

const NOT_CONFIGURED: IntegrationView = {
  configured: false,
  status: 'not_configured',
  ownership: 'platform',
  provider: 'meta',
  health: 'setup',
  wabaIdMasked: null,
  phoneNumberIdMasked: null,
  displayPhoneNumber: null,
  verifiedName: null,
  numberStatus: null,
  qualityRating: null,
  messagingTier: null,
  connectedAt: null,
  lastValidatedAt: null,
  lastError: null,
  lastErrorAt: null,
  live: false,
};

/**
 * The integration and its number, as one answer.
 *
 * Read together because the page always needs both and they are two rows in
 * the same tenant — two round trips to build one card is a cost paid on every
 * settings render for no benefit.
 */
export async function getIntegrationView(hospitalId: string): Promise<IntegrationView> {
  return withTenant(hospitalId, async (tx) => {
    const [integration] = await tx
      .select({
        status: whatsappIntegrations.status,
        ownership: whatsappIntegrations.ownership,
        provider: whatsappIntegrations.provider,
        wabaId: whatsappIntegrations.wabaId,
        connectedAt: whatsappIntegrations.connectedAt,
        lastValidatedAt: whatsappIntegrations.lastValidatedAt,
        lastErrorCode: whatsappIntegrations.lastErrorCode,
        lastErrorAt: whatsappIntegrations.lastErrorAt,
      })
      .from(whatsappIntegrations)
      .where(eq(whatsappIntegrations.hospitalId, hospitalId));

    const [number] = await tx
      .select({
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

    if (!integration && !number) return NOT_CONFIGURED;

    const status: IntegrationStatus = integration?.status ?? 'pending';
    const numberStatus = (number?.status ?? null) as NumberStatus | null;

    return {
      configured: true,
      status,
      ownership: integration?.ownership ?? 'platform',
      provider: integration?.provider ?? 'meta',
      health: deriveHealth({
        integrationStatus: status,
        numberStatus,
        qualityRating: number?.qualityRating ?? null,
      }),
      wabaIdMasked: maskIdentifier(integration?.wabaId ?? number?.wabaId),
      phoneNumberIdMasked: maskIdentifier(number?.phoneNumberId),
      displayPhoneNumber: number?.displayPhoneNumber ?? null,
      verifiedName: number?.verifiedName ?? null,
      numberStatus,
      qualityRating: number?.qualityRating ?? null,
      messagingTier: number?.messagingTier ?? null,
      connectedAt: integration?.connectedAt ?? null,
      lastValidatedAt: integration?.lastValidatedAt ?? null,
      lastError: integration?.lastErrorCode
        ? integrationErrorMessage(integration.lastErrorCode as IntegrationErrorCode)
        : null,
      lastErrorAt: integration?.lastErrorAt ?? null,
      // The single fact that decides whether a patient hears anything: the
      // resolver requires a registered number, and the sender requires
      // credentials that work.
      live: status === 'connected' && numberStatus === 'registered',
    };
  });
}

/* ------------------------------------------------------------- credentials */

export type ResolvedCredential = {
  accessToken: string;
  wabaId: string | null;
  ownership: 'platform' | 'hospital';
};

/**
 * The access token to use for one hospital, unsealed at the last moment.
 *
 * Under platform ownership this is the environment's token and no database
 * secret is involved at all — which is the reason platform ownership is the
 * default. Under hospital ownership the sealed credential is opened here, in
 * server-side code, and the plaintext must not travel any further than the
 * Authorization header it was fetched for.
 *
 * Never call this to decide what to render. It exists for provider calls.
 */
export async function resolveCredential(
  hospitalId: string,
): Promise<ResolvedCredential> {
  const [row] = await withTenant(hospitalId, (tx) =>
    tx
      .select({
        ownership: whatsappIntegrations.ownership,
        wabaId: whatsappIntegrations.wabaId,
        ciphertext: whatsappIntegrations.credentialCiphertext,
        iv: whatsappIntegrations.credentialIv,
        authTag: whatsappIntegrations.credentialAuthTag,
        keyVersion: whatsappIntegrations.credentialKeyVersion,
      })
      .from(whatsappIntegrations)
      .where(eq(whatsappIntegrations.hospitalId, hospitalId)),
  );

  const ownership = row?.ownership ?? 'platform';

  if (ownership === 'platform') {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) throw new IntegrationError('CONFIGURATION_ERROR');
    return {
      accessToken,
      wabaId: row?.wabaId ?? process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? null,
      ownership,
    };
  }

  if (!row?.ciphertext || !row.iv || !row.authTag || row.keyVersion === null) {
    throw new IntegrationError('CONFIGURATION_ERROR');
  }

  try {
    return {
      accessToken: openCredential({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      }),
      wabaId: row.wabaId,
      ownership,
    };
  } catch {
    // An unreadable credential is a key problem, not a Meta problem. Saying
    // "invalid credentials" here would send an operator to rotate a token that
    // is fine and leave the retired key in place.
    throw new IntegrationError('CONFIGURATION_ERROR');
  }
}

/* ------------------------------------------------------------------- audit */

/**
 * Writes an audit row inside the caller's transaction.
 *
 * Metadata is whitelisted rather than filtered. A blocklist of secret-looking
 * keys is one forgotten field away from writing a token into an append-only
 * table that by design cannot be corrected afterwards.
 */
async function audit(
  tx: Tx,
  args: {
    hospitalId: string;
    actorUserId: string;
    action: string;
    objectId?: string | null;
    provider?: string;
    ownership?: string;
    wabaId?: string | null;
    phoneNumberId?: string | null;
    displayPhoneNumber?: string | null;
    result?: 'success' | 'failure';
    errorCode?: IntegrationErrorCode | null;
    requestId?: string | null;
  },
) {
  const metadata: Record<string, unknown> = {};
  if (args.provider) metadata.provider = args.provider;
  if (args.ownership) metadata.ownership = args.ownership;
  if (args.wabaId) metadata.waba_id = args.wabaId;
  if (args.phoneNumberId) metadata.phone_number_id = args.phoneNumberId;
  if (args.displayPhoneNumber) metadata.display_phone_number = args.displayPhoneNumber;
  if (args.result) metadata.result = args.result;
  if (args.errorCode) metadata.error_code = args.errorCode;

  await tx.insert(auditLogs).values({
    hospitalId: args.hospitalId,
    actorUserId: args.actorUserId,
    action: args.action,
    objectType: 'whatsapp_integration',
    objectId: args.objectId ?? null,
    metadata,
    requestId: args.requestId ?? null,
  });
}

/**
 * Structured server log. Separate from the audit row because the two have
 * different readers: audit is for the hospital, this is for us.
 */
function log(event: string, fields: Record<string, unknown>) {
  console.log(`[whatsapp:${event}]`, JSON.stringify(fields));
}

/* -------------------------------------------------------------- operations */

/** Creates the row if a hospital has never had one. Safe to call repeatedly. */
async function ensureIntegrationRow(tx: Tx, hospitalId: string): Promise<string> {
  const [existing] = await tx
    .select({ id: whatsappIntegrations.id })
    .from(whatsappIntegrations)
    .where(eq(whatsappIntegrations.hospitalId, hospitalId));
  if (existing) return existing.id;

  const [created] = await tx
    .insert(whatsappIntegrations)
    .values({ hospitalId, status: 'pending' })
    .returning({ id: whatsappIntegrations.id });
  return created.id;
}

/**
 * The hospital asks for WhatsApp to be set up.
 *
 * Under platform ownership this is genuinely all an owner has to do: the number
 * purchase, the WABA, the verification and the registration are ours. The row
 * moving to `pending` is what puts the hospital on the platform onboarding
 * queue, which is why it is worth recording rather than handling over a phone
 * call.
 *
 * Idempotent by construction — a double-clicked button re-enters the same
 * state. That is preferred here over an `idempotency_keys` round trip, which
 * would add a table write and a failure mode to an operation whose repeat is
 * already harmless.
 */
export async function startOnboarding(args: {
  hospitalId: string;
  actor: Actor;
  requestId?: string;
}): Promise<void> {
  assertCanManage(args.actor);

  await withTenant(args.hospitalId, async (tx) => {
    const [existing] = await tx
      .select({
        id: whatsappIntegrations.id,
        status: whatsappIntegrations.status,
      })
      .from(whatsappIntegrations)
      .where(eq(whatsappIntegrations.hospitalId, args.hospitalId));

    // Already live: re-requesting must not knock a working integration back
    // into onboarding.
    if (existing?.status === 'connected') return;

    const id = existing?.id ?? (await ensureIntegrationRow(tx, args.hospitalId));

    await tx
      .update(whatsappIntegrations)
      .set({ status: 'pending', lastErrorCode: null, lastErrorAt: null, updatedAt: new Date() })
      .where(eq(whatsappIntegrations.id, id));

    await audit(tx, {
      hospitalId: args.hospitalId,
      actorUserId: args.actor.userId,
      action: existing ? 'whatsapp.integration.reconnected' : 'whatsapp.integration.created',
      objectId: id,
      provider: 'meta',
      ownership: 'platform',
      result: 'success',
      requestId: args.requestId,
    });
  });

  log('onboarding.started', { hospital_id: args.hospitalId, actor: args.actor.userId });
}

export type ValidationOutcome = {
  health: ConnectionHealth;
  numberStatus: NumberStatus;
  verifiedName: string | null;
  displayPhoneNumber: string | null;
};

/**
 * Asks Meta whether this hospital's number is real, ours, and registered.
 *
 * The order matters and is the whole security argument of this function. The
 * provider is called *first*, outside any transaction, and only what Meta
 * confirms is written. Nothing supplied by a browser is persisted as fact, so a
 * hospital cannot assert its way into a number, and a long Graph API call never
 * holds a row lock.
 */
export async function validateConnection(args: {
  hospitalId: string;
  actor: Actor;
  requestId?: string;
}): Promise<ValidationOutcome> {
  assertCanManage(args.actor);

  // Guarded per hospital, not per user: the cost being controlled is traffic to
  // Meta on this hospital's behalf, and the limit would be trivially bypassed
  // by an owner with two staff logins otherwise.
  const limit = consumeToken({
    key: `whatsapp:validate:${args.hospitalId}`,
    ...VALIDATION_LIMIT,
  });
  if (!limit.allowed) {
    throw new IntegrationError('RATE_LIMITED', limit.retryAfterSeconds);
  }

  const number = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({
        id: whatsappNumbers.id,
        phoneNumberId: whatsappNumbers.phoneNumberId,
      })
      .from(whatsappNumbers)
      .where(eq(whatsappNumbers.hospitalId, args.hospitalId))
      .then((rows) => rows[0] ?? null),
  );

  if (!number) throw new IntegrationError('CONFIGURATION_ERROR');

  const credential = await resolveCredential(args.hospitalId);
  if (!credential.wabaId) throw new IntegrationError('CONFIGURATION_ERROR');

  log('validation.started', {
    hospital_id: args.hospitalId,
    phone_number_id: number.phoneNumberId,
    operation: 'validate',
  });

  let verified: { number: MetaPhoneNumber; registered: boolean };
  try {
    verified = await verifyNumberBelongsToWaba({
      phoneNumberId: number.phoneNumberId,
      wabaId: credential.wabaId,
      accessToken: credential.accessToken,
    });
  } catch (error) {
    const errorCode =
      error instanceof MetaAdminError ? error.errorCode : 'UNKNOWN_PROVIDER_ERROR';

    await recordFailure({
      hospitalId: args.hospitalId,
      actor: args.actor,
      errorCode,
      phoneNumberId: number.phoneNumberId,
      requestId: args.requestId,
    });

    log('validation.failed', {
      hospital_id: args.hospitalId,
      phone_number_id: number.phoneNumberId,
      operation: 'validate',
      result: 'failure',
      error_category: errorCode,
      // Diagnostic carries Meta's numeric codes only — never its message.
      diagnostic: error instanceof MetaAdminError ? error.diagnostic : undefined,
    });

    throw new IntegrationError(errorCode);
  }

  // Meta agreed. Now a short transaction, holding no network call.
  const outcome = await withTenant(args.hospitalId, async (tx) => {
    const integrationId = await ensureIntegrationRow(tx, args.hospitalId);
    const now = new Date();

    // Registration is what Meta says it is. A number that has not completed
    // verification stays out of `registered`, and therefore out of
    // resolve_whatsapp_number, no matter what anyone clicked.
    const numberStatus: NumberStatus = verified.registered ? 'registered' : 'pending';

    await tx
      .update(whatsappNumbers)
      .set({
        status: numberStatus,
        verifiedName: verified.number.verifiedName,
        displayPhoneNumber: verified.number.displayPhoneNumber,
        qualityRating: verified.number.qualityRating,
        messagingTier: verified.number.messagingTier,
        wabaId: credential.wabaId,
        ...(verified.registered ? { registeredAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(whatsappNumbers.id, number.id));

    await tx
      .update(whatsappIntegrations)
      .set({
        status: 'connected',
        wabaId: credential.wabaId,
        lastValidatedAt: now,
        connectedAt: now,
        lastErrorCode: null,
        lastErrorAt: null,
        updatedAt: now,
      })
      .where(eq(whatsappIntegrations.id, integrationId));

    await audit(tx, {
      hospitalId: args.hospitalId,
      actorUserId: args.actor.userId,
      action: 'whatsapp.connection.validated',
      objectId: integrationId,
      provider: 'meta',
      ownership: credential.ownership,
      wabaId: credential.wabaId,
      phoneNumberId: number.phoneNumberId,
      displayPhoneNumber: verified.number.displayPhoneNumber,
      result: 'success',
      requestId: args.requestId,
    });

    if (verified.registered) {
      await audit(tx, {
        hospitalId: args.hospitalId,
        actorUserId: args.actor.userId,
        action: 'whatsapp.number.assigned',
        objectId: number.id,
        provider: 'meta',
        phoneNumberId: number.phoneNumberId,
        displayPhoneNumber: verified.number.displayPhoneNumber,
        result: 'success',
        requestId: args.requestId,
      });
    }

    return {
      health: deriveHealth({
        integrationStatus: 'connected',
        numberStatus,
        qualityRating: verified.number.qualityRating,
      }),
      numberStatus,
      verifiedName: verified.number.verifiedName,
      displayPhoneNumber: verified.number.displayPhoneNumber,
    };
  });

  log('validation.succeeded', {
    hospital_id: args.hospitalId,
    phone_number_id: number.phoneNumberId,
    operation: 'validate',
    result: 'success',
    number_status: outcome.numberStatus,
  });

  return outcome;
}

/** Records a failed validation without disturbing a previously working state. */
async function recordFailure(args: {
  hospitalId: string;
  actor: Actor;
  errorCode: IntegrationErrorCode;
  phoneNumberId: string | null;
  requestId?: string;
}) {
  await withTenant(args.hospitalId, async (tx) => {
    const integrationId = await ensureIntegrationRow(tx, args.hospitalId);
    const now = new Date();

    // A transient Meta outage must not tear down a working integration — the
    // number stays registered and messages keep flowing. Only failures that say
    // something durable about the configuration move it to `error`.
    const durable =
      args.errorCode !== 'PROVIDER_UNAVAILABLE' && args.errorCode !== 'RATE_LIMITED';

    await tx
      .update(whatsappIntegrations)
      .set({
        ...(durable ? { status: 'error' as const } : {}),
        lastErrorCode: args.errorCode,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(eq(whatsappIntegrations.id, integrationId));

    await audit(tx, {
      hospitalId: args.hospitalId,
      actorUserId: args.actor.userId,
      action: 'whatsapp.connection.failed',
      objectId: integrationId,
      provider: 'meta',
      phoneNumberId: args.phoneNumberId,
      result: 'failure',
      errorCode: args.errorCode,
      requestId: args.requestId,
    });
  });
}

/**
 * Stops QueueCare using this hospital's WhatsApp, without destroying anything.
 *
 * The number row survives, its history survives, and every notification already
 * sent survives. Moving the number out of `registered` is what actually stops
 * inbound routing, because `resolve_whatsapp_number` requires that status —
 * so disconnection is enforced by the same database function that does the
 * routing, rather than by a second check somewhere that could disagree with it.
 */
export async function disconnectIntegration(args: {
  hospitalId: string;
  actor: Actor;
  requestId?: string;
}): Promise<void> {
  assertCanManage(args.actor);

  await withTenant(args.hospitalId, async (tx) => {
    const integrationId = await ensureIntegrationRow(tx, args.hospitalId);
    const now = new Date();

    const [number] = await tx
      .select({
        id: whatsappNumbers.id,
        phoneNumberId: whatsappNumbers.phoneNumberId,
      })
      .from(whatsappNumbers)
      .where(eq(whatsappNumbers.hospitalId, args.hospitalId));

    if (number) {
      await tx
        .update(whatsappNumbers)
        .set({ status: 'released', updatedAt: now })
        .where(eq(whatsappNumbers.id, number.id));

      await audit(tx, {
        hospitalId: args.hospitalId,
        actorUserId: args.actor.userId,
        action: 'whatsapp.number.released',
        objectId: number.id,
        provider: 'meta',
        phoneNumberId: number.phoneNumberId,
        result: 'success',
        requestId: args.requestId,
      });
    }

    await tx
      .update(whatsappIntegrations)
      .set({
        status: 'disconnected',
        // Credentials are cleared on disconnect so a revoked integration
        // cannot be used by anything that later forgets to check status.
        credentialCiphertext: null,
        credentialIv: null,
        credentialAuthTag: null,
        credentialKeyVersion: null,
        connectedAt: null,
        updatedAt: now,
      })
      .where(eq(whatsappIntegrations.id, integrationId));

    await audit(tx, {
      hospitalId: args.hospitalId,
      actorUserId: args.actor.userId,
      action: 'whatsapp.integration.disconnected',
      objectId: integrationId,
      provider: 'meta',
      result: 'success',
      requestId: args.requestId,
    });
  });

  log('disconnected', { hospital_id: args.hospitalId, actor: args.actor.userId });
}

/* -------------------------------------------------------- platform admin */

/**
 * Attaches a number from our inventory to a hospital.
 *
 * Platform-only, and on the admin connection by necessity rather than
 * convenience: unassigned inventory has a NULL hospital_id, so it is invisible
 * to every tenant by RLS — which is the correct design, and also means no
 * tenant-scoped query could ever find the row to assign it.
 *
 * Uniqueness is left to the database. Checking first and inserting after is a
 * race that two platform admins, or one admin clicking twice, will eventually
 * lose; the unique index on phone_number_id cannot.
 */
export async function assignNumberToHospital(args: {
  hospitalId: string;
  phoneNumberId: string;
  actor: Actor;
  requestId?: string;
}): Promise<void> {
  assertPlatformAdmin(args.actor);

  const phoneNumberId = args.phoneNumberId.trim();
  if (!isPlausiblePhoneNumberId(phoneNumberId)) {
    throw new IntegrationError('INVALID_PHONE_NUMBER');
  }

  const admin = getAdminDb();

  // Verify against Meta before writing anything, so an id that is not in our
  // WABA never reaches the database in the first place.
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!accessToken || !wabaId) throw new IntegrationError('CONFIGURATION_ERROR');

  let verified: { number: MetaPhoneNumber; registered: boolean };
  try {
    verified = await verifyNumberBelongsToWaba({ phoneNumberId, wabaId, accessToken });
  } catch (error) {
    const errorCode =
      error instanceof MetaAdminError ? error.errorCode : 'UNKNOWN_PROVIDER_ERROR';
    log('assign.failed', {
      hospital_id: args.hospitalId,
      phone_number_id: phoneNumberId,
      operation: 'assign',
      result: 'failure',
      error_category: errorCode,
    });
    throw new IntegrationError(errorCode);
  }

  try {
    await admin.transaction(async (tx) => {
      const now = new Date();
      const numberStatus: NumberStatus = verified.registered ? 'registered' : 'pending';

      // Insert or adopt in one statement. The conflict target is the unique
      // phone_number_id, so a number already held by another hospital updates
      // that row's ownership rather than duplicating it — which is why the
      // guard below refuses when it is currently assigned elsewhere.
      const [existing] = await tx
        .select({ id: whatsappNumbers.id, hospitalId: whatsappNumbers.hospitalId })
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));

      if (existing?.hospitalId && existing.hospitalId !== args.hospitalId) {
        throw new IntegrationError('NUMBER_ALREADY_ASSIGNED');
      }

      if (existing) {
        await tx
          .update(whatsappNumbers)
          .set({
            hospitalId: args.hospitalId,
            wabaId,
            status: numberStatus,
            verifiedName: verified.number.verifiedName,
            displayPhoneNumber: verified.number.displayPhoneNumber,
            qualityRating: verified.number.qualityRating,
            messagingTier: verified.number.messagingTier,
            ...(verified.registered ? { registeredAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(whatsappNumbers.id, existing.id));
      } else {
        await tx.insert(whatsappNumbers).values({
          hospitalId: args.hospitalId,
          phoneNumberId,
          wabaId,
          status: numberStatus,
          verifiedName: verified.number.verifiedName,
          displayPhoneNumber: verified.number.displayPhoneNumber,
          qualityRating: verified.number.qualityRating,
          messagingTier: verified.number.messagingTier,
          ...(verified.registered ? { registeredAt: now } : {}),
        });
      }

      const [integration] = await tx
        .select({ id: whatsappIntegrations.id })
        .from(whatsappIntegrations)
        .where(eq(whatsappIntegrations.hospitalId, args.hospitalId));

      if (integration) {
        await tx
          .update(whatsappIntegrations)
          .set({
            status: 'connected',
            wabaId,
            connectedAt: now,
            lastValidatedAt: now,
            lastErrorCode: null,
            lastErrorAt: null,
            updatedAt: now,
          })
          .where(eq(whatsappIntegrations.id, integration.id));
      } else {
        await tx.insert(whatsappIntegrations).values({
          hospitalId: args.hospitalId,
          status: 'connected',
          wabaId,
          connectedAt: now,
          lastValidatedAt: now,
        });
      }

      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actor.userId,
        action: 'whatsapp.number.assigned',
        objectType: 'whatsapp_integration',
        objectId: phoneNumberId,
        metadata: {
          provider: 'meta',
          ownership: 'platform',
          waba_id: wabaId,
          phone_number_id: phoneNumberId,
          display_phone_number: verified.number.displayPhoneNumber,
          result: 'success',
          assigned_by_platform_admin: true,
        },
        requestId: args.requestId ?? null,
      });
    });
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    // 23505 is the unique index on phone_number_id doing its job under a race.
    if (isUniqueViolation(error)) {
      throw new IntegrationError('NUMBER_ALREADY_ASSIGNED');
    }
    throw error;
  }

  log('assign.succeeded', {
    hospital_id: args.hospitalId,
    phone_number_id: phoneNumberId,
    operation: 'assign',
    result: 'success',
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
