import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import {
  claimCases,
  claimEvents,
  claimQueries,
  recordAccessLogs,
  type claimCases as ClaimCasesTable,
} from '@/lib/db/schema';
import {
  calculatePreauthDeadlineMinutes,
  calculateQueryDeadlineMinutes,
  validateClaimTransition,
  type ClaimStatus,
  type SubmissionDetails,
} from '@/lib/domain/claims';
import {
  decryptClaimIdentifier,
  encryptClaimIdentifier,
} from '@/lib/security/claims-encryption';
import { maskClaimFinancialsForRole } from './claims-masking';
import type { StaffRole } from '@/lib/domain/permissions';

export class StaleClaimVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleClaimVersionError';
  }
}

export class ClaimNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimNotFoundError';
  }
}

export type ClaimCaseRow = typeof claimCases.$inferSelect;
export type ClaimQueryRow = typeof claimQueries.$inferSelect;

/**
 * Creates a new claim case within a transaction.
 * Encrypts policy and member identifiers using AAD bound to the claim ID.
 * Inserts the initial 'created' event into the append-only ledger.
 */
export async function createClaimCaseInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    branchId: string;
    admissionId: string;
    encounterId: string;
    patientId: string;
    encounterPayerId: string;
    payerProfileId: string;
    claimType?: 'cashless' | 'reimbursement';
    priority?: 'standard' | 'urgent' | 'emergency';
    rawPolicyNumber?: string | null;
    rawMemberId?: string | null;
    estimatedCostPaise?: number | null;
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimCaseRow> {
  const claimId = randomUUID();

  let policyEnc: ReturnType<typeof encryptClaimIdentifier> | null = null;
  if (args.rawPolicyNumber) {
    policyEnc = encryptClaimIdentifier(args.rawPolicyNumber, claimId);
  }

  let memberEnc: ReturnType<typeof encryptClaimIdentifier> | null = null;
  if (args.rawMemberId) {
    memberEnc = encryptClaimIdentifier(args.rawMemberId, claimId);
  }

  const initialStatus: ClaimStatus = args.claimType === 'reimbursement' ? 'reimbursement_draft' : 'draft';

  const [created] = await tx
    .insert(claimCases)
    .values({
      id: claimId,
      hospitalId: args.hospitalId,
      branchId: args.branchId,
      admissionId: args.admissionId,
      encounterId: args.encounterId,
      patientId: args.patientId,
      encounterPayerId: args.encounterPayerId,
      payerProfileId: args.payerProfileId,
      claimType: args.claimType || 'cashless',
      priority: args.priority || 'standard',
      version: 1,
      clientId: args.clientId,
      status: initialStatus,
      estimatedCostPaise: args.estimatedCostPaise ?? null,
      policyNumberCiphertext: policyEnc?.ciphertext ?? null,
      policyNumberIv: policyEnc?.iv ?? null,
      policyNumberTag: policyEnc?.tag ?? null,
      policyNumberKeyVersion: policyEnc?.keyVersion ?? null,
      policyNumberMasked: policyEnc?.masked ?? null,
      policyNumberBidx: policyEnc?.blindIndex ?? null,
      memberIdCiphertext: memberEnc?.ciphertext ?? null,
      memberIdIv: memberEnc?.iv ?? null,
      memberIdTag: memberEnc?.tag ?? null,
      memberIdKeyVersion: memberEnc?.keyVersion ?? null,
      memberIdMasked: memberEnc?.masked ?? null,
      memberIdBidx: memberEnc?.blindIndex ?? null,
    })
    .returning();

  // Write immutable initial event to ledger
  await tx.insert(claimEvents).values({
    hospitalId: args.hospitalId,
    claimCaseId: claimId,
    eventType: 'created',
    previousStatus: null,
    newStatus: initialStatus,
    amountPaise: args.estimatedCostPaise ?? null,
    actorUserId: args.actorUserId,
    clientId: randomUUID(),
  });

  return created;
}

/**
 * Transitions a claim status with optimistic locking and records the milestone event.
 */
export async function transitionClaimStatusInTx(
  tx: Tx,
  args: {
    claimId: string;
    hospitalId: string;
    expectedVersion: number;
    targetStatus: ClaimStatus;
    submissionDetails?: SubmissionDetails;
    amountPaise?: number | null;
    notes?: string | null;
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimCaseRow> {
  const [current] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, args.claimId), eq(claimCases.hospitalId, args.hospitalId)))
    .limit(1);

  if (!current) {
    throw new ClaimNotFoundError(`Claim case '${args.claimId}' not found.`);
  }

  if (current.version !== args.expectedVersion) {
    throw new StaleClaimVersionError(
      `Claim '${args.claimId}' version mismatch: expected ${args.expectedVersion}, found ${current.version}.`
    );
  }

  validateClaimTransition({
    currentStatus: current.status as ClaimStatus,
    targetStatus: args.targetStatus,
    submissionDetails: args.submissionDetails,
  });

  const patch: Partial<typeof claimCases.$inferInsert> = {
    status: args.targetStatus,
    version: current.version + 1,
    updatedAt: new Date(),
  };

  if (args.targetStatus === 'preauth_submitted' && args.submissionDetails) {
    patch.preauthSubmittedAt = args.submissionDetails.sentAt;
    patch.preauthSlaDeadline = calculatePreauthDeadlineMinutes(args.submissionDetails.sentAt, 360);
  } else if (args.targetStatus === 'preauth_approved') {
    patch.preauthApprovedAt = new Date();
    if (args.amountPaise != null) {
      patch.approvedAmountPaise = args.amountPaise;
    }
  } else if (args.targetStatus === 'final_submitted' && args.submissionDetails) {
    patch.finalSubmittedAt = args.submissionDetails.sentAt;
    patch.finalSubmittedChannel = args.submissionDetails.channel;
    patch.finalSubmissionReference = args.submissionDetails.reference;
  } else if (args.targetStatus === 'settled' || args.targetStatus === 'partially_settled') {
    patch.settledAt = new Date();
  }

  const [updated] = await tx
    .update(claimCases)
    .set(patch)
    .where(and(eq(claimCases.id, args.claimId), eq(claimCases.version, current.version)))
    .returning();

  if (!updated) {
    throw new StaleClaimVersionError(
      `Concurrent update conflict for claim '${args.claimId}'. Transaction aborted.`
    );
  }

  // Record milestone in immutable ledger
  await tx.insert(claimEvents).values({
    hospitalId: args.hospitalId,
    claimCaseId: args.claimId,
    eventType: args.targetStatus,
    previousStatus: current.status,
    newStatus: args.targetStatus,
    amountPaise: args.amountPaise ?? null,
    submissionChannel: args.submissionDetails?.channel ?? null,
    externalReference: args.submissionDetails?.reference ?? null,
    notes: args.notes ?? null,
    actorUserId: args.actorUserId,
    clientId: args.clientId,
  });

  return updated;
}

/**
 * Records a new TPA query, sets the SLA deadline, and transitions claim to query_raised.
 */
export async function recordClaimQueryInTx(
  tx: Tx,
  args: {
    claimId: string;
    hospitalId: string;
    queryCategory: string;
    queryDescription: string;
    slaMinutes: number;
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimQueryRow> {
  const [current] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, args.claimId), eq(claimCases.hospitalId, args.hospitalId)))
    .limit(1);

  if (!current) {
    throw new ClaimNotFoundError(`Claim case '${args.claimId}' not found.`);
  }

  const receivedAt = new Date();
  const slaDeadlineAt = calculateQueryDeadlineMinutes(receivedAt, args.slaMinutes);

  const [query] = await tx
    .insert(claimQueries)
    .values({
      hospitalId: args.hospitalId,
      claimCaseId: args.claimId,
      queryCategory: args.queryCategory,
      queryDescription: args.queryDescription,
      receivedAt,
      slaDeadlineAt,
      status: 'pending_hospital',
      clientId: args.clientId,
    })
    .returning();

  // If claim is currently preauth_submitted or final_submitted, flag as query_raised
  if (current.status === 'preauth_submitted' || current.status === 'final_submitted') {
    await transitionClaimStatusInTx(tx, {
      claimId: args.claimId,
      hospitalId: args.hospitalId,
      expectedVersion: current.version,
      targetStatus: 'query_raised',
      notes: `TPA Query received: ${args.queryDescription.slice(0, 100)}`,
      actorUserId: args.actorUserId,
      clientId: randomUUID(),
    });
  }

  return query;
}

/**
 * Records the hospital's response to an open query.
 */
export async function replyClaimQueryInTx(
  tx: Tx,
  args: {
    queryId: string;
    hospitalId: string;
    replyNotes: string;
    replyChannel?: 'portal' | 'email' | 'physical_courier';
    replyReference?: string;
    actorUserId: string;
  }
): Promise<ClaimQueryRow> {
  const [updated] = await tx
    .update(claimQueries)
    .set({
      status: 'replied',
      replyNotes: args.replyNotes,
      repliedAt: new Date(),
      repliedByUserId: args.actorUserId,
      replyChannel: args.replyChannel ?? 'portal',
      replyReference: args.replyReference ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(claimQueries.id, args.queryId), eq(claimQueries.hospitalId, args.hospitalId)))
    .returning();

  return updated;
}

/**
 * Records final settlement breakdown and links to the finalized discharge bill.
 */
export async function recordClaimSettlementInTx(
  tx: Tx,
  args: {
    claimId: string;
    hospitalId: string;
    expectedVersion: number;
    settledAmountPaise: number;
    deductionAmountPaise: number;
    coPayAmountPaise: number;
    dischargeBillId: string;
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimCaseRow> {
  const [current] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, args.claimId), eq(claimCases.hospitalId, args.hospitalId)))
    .limit(1);

  if (!current) {
    throw new ClaimNotFoundError(`Claim case '${args.claimId}' not found.`);
  }

  const targetStatus: ClaimStatus = args.deductionAmountPaise > 0 ? 'partially_settled' : 'settled';

  const updated = await transitionClaimStatusInTx(tx, {
    claimId: args.claimId,
    hospitalId: args.hospitalId,
    expectedVersion: args.expectedVersion,
    targetStatus,
    amountPaise: args.settledAmountPaise,
    notes: `Settled: ₹${args.settledAmountPaise / 100}, Deductions: ₹${args.deductionAmountPaise / 100}`,
    actorUserId: args.actorUserId,
    clientId: args.clientId,
  });

  const [settled] = await tx
    .update(claimCases)
    .set({
      settledAmountPaise: args.settledAmountPaise,
      deductionAmountPaise: args.deductionAmountPaise,
      coPayAmountPaise: args.coPayAmountPaise,
      dischargeBillId: args.dischargeBillId,
    })
    .where(eq(claimCases.id, args.claimId))
    .returning();

  return settled;
}

/**
 * Decrypts a sensitive policy number, logging the decryption event in record_access_logs.
 */
export async function decryptClaimPolicyNumber(
  tx: Tx,
  args: {
    claim: Pick<ClaimCaseRow, 'id' | 'policyNumberCiphertext' | 'policyNumberIv' | 'policyNumberTag' | 'policyNumberKeyVersion' | 'hospitalId'>;
    actorUserId: string;
    patientId: string;
    encounterId?: string | null;
  }
): Promise<string | null> {
  const { claim } = args;
  if (!claim.policyNumberCiphertext || !claim.policyNumberIv || !claim.policyNumberTag || !claim.policyNumberKeyVersion) {
    return null;
  }

  const decrypted = decryptClaimIdentifier(
    {
      ciphertext: claim.policyNumberCiphertext,
      iv: claim.policyNumberIv,
      tag: claim.policyNumberTag,
      keyVersion: claim.policyNumberKeyVersion,
    },
    claim.id
  );

  // Log decryption audit row
  await tx.insert(recordAccessLogs).values({
    hospitalId: claim.hospitalId,
    actorUserId: args.actorUserId,
    patientId: args.patientId,
    encounterId: args.encounterId ?? null,
    action: 'decrypt_claim_identifier',
  });

  return decrypted;
}

/**
 * Retrieves a single claim case by ID with role-based financial masking applied.
 */
export async function getClaimCaseById(
  tx: Tx,
  args: {
    claimId: string;
    hospitalId: string;
    role?: StaffRole;
  }
): Promise<ClaimCaseRow | null> {
  const [row] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, args.claimId), eq(claimCases.hospitalId, args.hospitalId), isNull(claimCases.voidedAt)))
    .limit(1);

  if (!row) return null;
  return args.role ? maskClaimFinancialsForRole(row, args.role) : row;
}

/**
 * Lists all active claim cases for a hospital with optional status filter and role masking.
 */
export async function listClaimCasesForHospital(
  tx: Tx,
  args: {
    hospitalId: string;
    status?: ClaimStatus;
    role?: StaffRole;
  }
): Promise<ClaimCaseRow[]> {
  const conditions = [eq(claimCases.hospitalId, args.hospitalId), isNull(claimCases.voidedAt)];
  if (args.status) {
    conditions.push(eq(claimCases.status, args.status));
  }

  const rows = await tx
    .select()
    .from(claimCases)
    .where(and(...conditions))
    .orderBy(desc(claimCases.createdAt));

  return args.role ? rows.map((r) => maskClaimFinancialsForRole(r, args.role!)) : rows;
}
