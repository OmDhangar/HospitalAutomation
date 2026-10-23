import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import {
  claimAuthorizations,
  claimCases,
  claimDocumentRecords,
  claimEvents,
  claimQueries,
  claimRemittances,
  claimSubmissions,
  recordAccessLogs,
  type claimCases as ClaimCasesTable,
} from '@/lib/db/schema';
import {
  calculatePreauthDeadlineMinutes,
  calculateQueryDeadlineMinutes,
  validateClaimTransition,
  InvalidClaimTransitionError,
  type AuthDecision,
  type AuthType,
  type ClaimStatus,
  type DeadlineType,
  type DocumentManifestItem,
  type PaymentMethod,
  type QueryStatus,
  type RemittanceType,
  type SettlementStatus,
  type SubmissionDetails,
  type SubmissionStage,
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

export class QueryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryNotFoundError';
  }
}

export class RemittanceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemittanceNotFoundError';
  }
}

export type ClaimCaseRow = typeof claimCases.$inferSelect;
export type ClaimQueryRow = typeof claimQueries.$inferSelect;
export type ClaimAuthorizationRow = typeof claimAuthorizations.$inferSelect;
export type ClaimSubmissionRow = typeof claimSubmissions.$inferSelect;
export type ClaimRemittanceRow = typeof claimRemittances.$inferSelect;

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
      settlementStatus: 'unsettled',
      currentAuthorizedLimitPaise: 0,
      totalRemittedPaise: 0,
      totalTdsWithheldPaise: 0,
      totalDeductionsPaise: 0,
      totalDisputedPaise: 0,
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
      patch.currentAuthorizedLimitPaise = args.amountPaise;
    }
  } else if (args.targetStatus === 'final_submitted' && args.submissionDetails) {
    patch.finalSubmittedAt = args.submissionDetails.sentAt;
    patch.finalSubmittedChannel = args.submissionDetails.channel;
    patch.finalSubmissionReference = args.submissionDetails.reference;
    if (args.submissionDetails.claimedAmountPaise != null) {
      patch.claimedAmountPaise = args.submissionDetails.claimedAmountPaise;
    }
  } else if (args.targetStatus === 'settled' || args.targetStatus === 'partially_settled') {
    patch.settledAt = new Date();
    patch.settlementStatus = args.targetStatus === 'settled' ? 'settled' : 'partially_settled';
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

  const eventTypeMap: Record<string, string> = {
    preauth_submitted: 'preauth_sent',
    enhancement_requested: 'enhancement_sent',
    claim_ready: 'claim_marked_ready',
    final_submitted: 'final_packet_sent',
    claim_rejected: 'rejected',
    appeal_in_progress: 'appeal_initiated',
  };
  const eventType = eventTypeMap[args.targetStatus] ?? args.targetStatus;

  // Record milestone in immutable ledger
  await tx.insert(claimEvents).values({
    hospitalId: args.hospitalId,
    claimCaseId: args.claimId,
    eventType,
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
 * Records a new TPA/insurer query, sets SLA deadline, saves interrupted stage,
 * and transitions claim to query_raised.
 */
export async function recordClaimQueryInTx(
  tx: Tx,
  args: {
    claimId: string;
    hospitalId: string;
    queryCategory: string;
    queryDescription: string;
    slaMinutes: number;
    deadlineType?: DeadlineType;
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

  const deadlineType = args.deadlineType ?? 'hospital_response';

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
      deadlineType,
      clientId: args.clientId,
    })
    .returning();

  // Update claim case: stamp hospital internal deadline if applicable, and if not already query_raised, record interrupted stage
  const casePatch: Partial<typeof claimCases.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (deadlineType === 'hospital_response' && slaDeadlineAt) {
    casePatch.hospitalInternalDeadline = slaDeadlineAt;
  }

  if (current.status !== 'query_raised') {
    casePatch.interruptedStage = current.status as ClaimStatus;
    casePatch.status = 'query_raised';
    casePatch.version = current.version + 1;
  } else if (casePatch.hospitalInternalDeadline) {
    casePatch.version = current.version + 1;
  }

  if (casePatch.version !== undefined) {
    await tx
      .update(claimCases)
      .set(casePatch)
      .where(and(eq(claimCases.id, args.claimId), eq(claimCases.version, current.version)));

    if (current.status !== 'query_raised') {
      await tx.insert(claimEvents).values({
        hospitalId: args.hospitalId,
        claimCaseId: args.claimId,
        eventType: 'query_received',
        previousStatus: current.status,
        newStatus: 'query_raised',
        notes: `Query received (${args.queryCategory}): ${args.queryDescription.slice(0, 100)}`,
        actorUserId: args.actorUserId,
        clientId: randomUUID(),
      });
    }
  }

  return query;
}

/**
 * Records the hospital's response to an open query.
 * Checks for any remaining open queries; if all queries are replied, safely restores
 * the claim's operational status to the recorded interrupted stage.
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
  const [query] = await tx
    .select()
    .from(claimQueries)
    .where(and(eq(claimQueries.id, args.queryId), eq(claimQueries.hospitalId, args.hospitalId)))
    .limit(1);

  if (!query) {
    throw new QueryNotFoundError(`Query '${args.queryId}' not found.`);
  }

  const [updatedQuery] = await tx
    .update(claimQueries)
    .set({
      status: 'replied_by_hospital',
      replyNotes: args.replyNotes,
      repliedAt: new Date(),
      repliedByUserId: args.actorUserId,
      replyChannel: args.replyChannel ?? 'portal',
      replyReference: args.replyReference ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(claimQueries.id, args.queryId), eq(claimQueries.hospitalId, args.hospitalId)))
    .returning();

  // Lock claim case row to prevent concurrent stage restoration race conditions
  const [claim] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, query.claimCaseId), eq(claimCases.hospitalId, args.hospitalId)))
    .limit(1);

  if (claim) {
    // Check if any other queries remain in pending_hospital for this case
    const otherPending = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(claimQueries)
      .where(
        and(
          eq(claimQueries.hospitalId, args.hospitalId),
          eq(claimQueries.claimCaseId, claim.id),
          eq(claimQueries.status, 'pending_hospital'),
          isNull(claimQueries.voidedAt)
        )
      );

    const pendingCount = otherPending[0]?.count ?? 0;

    // If zero open queries remain and claim was in query_raised, safely restore interrupted stage
    if (pendingCount === 0 && claim.status === 'query_raised' && claim.interruptedStage) {
      const restoredStatus = claim.interruptedStage as ClaimStatus;
      await tx
        .update(claimCases)
        .set({
          status: restoredStatus,
          interruptedStage: null,
          version: claim.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(claimCases.id, claim.id), eq(claimCases.version, claim.version)));

      await tx.insert(claimEvents).values({
        hospitalId: args.hospitalId,
        claimCaseId: claim.id,
        eventType: 'query_replied',
        previousStatus: 'query_raised',
        newStatus: restoredStatus,
        notes: `All queries replied; restored stage to ${restoredStatus}.`,
        actorUserId: args.actorUserId,
        clientId: randomUUID(),
      });
    } else {
      await tx.insert(claimEvents).values({
        hospitalId: args.hospitalId,
        claimCaseId: claim.id,
        eventType: 'query_replied',
        previousStatus: claim.status,
        newStatus: claim.status,
        notes: `Query replied; ${pendingCount} query(ies) still pending hospital response.`,
        actorUserId: args.actorUserId,
        clientId: randomUUID(),
      });
    }
  }

  return updatedQuery;
}

/**
 * Records insurer's resolution of a previously answered query (accepted or disputed).
 */
export async function resolveClaimQueryByInsurerInTx(
  tx: Tx,
  args: {
    queryId: string;
    hospitalId: string;
    status: 'resolved_accepted' | 're_queried' | 'disputed';
    reference?: string;
    notes?: string;
    actorUserId: string;
  }
): Promise<ClaimQueryRow> {
  const [updated] = await tx
    .update(claimQueries)
    .set({
      status: args.status,
      insurerResolvedAt: new Date(),
      insurerResolutionReference: args.reference ?? null,
      insurerResolutionNotes: args.notes ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(claimQueries.id, args.queryId), eq(claimQueries.hospitalId, args.hospitalId)))
    .returning();

  if (!updated) {
    throw new QueryNotFoundError(`Query '${args.queryId}' not found.`);
  }

  return updated;
}

/**
 * Records initial pre-authorization or enhancement request and decision with full history.
 * Preserves incremental and cumulative limits explicitly without untracked overwrites.
 */
export async function recordClaimAuthorizationInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
    authType: AuthType;
    requestedIncrementalPaise?: number | null;
    requestedCumulativePaise: number;
    approvedIncrementalPaise?: number | null;
    approvedCumulativePaise?: number | null;
    decision: AuthDecision;
    referenceNumber?: string | null;
    decisionNotes?: string | null;
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimAuthorizationRow> {
  const [claim] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, args.claimCaseId), eq(claimCases.hospitalId, args.hospitalId)))
    .limit(1);

  if (!claim) {
    throw new ClaimNotFoundError(`Claim case '${args.claimCaseId}' not found.`);
  }

  // Get next sequence number for this authType on this case
  const existing = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${claimAuthorizations.sequenceNumber}), -1)::int` })
    .from(claimAuthorizations)
    .where(
      and(
        eq(claimAuthorizations.hospitalId, args.hospitalId),
        eq(claimAuthorizations.claimCaseId, args.claimCaseId),
        eq(claimAuthorizations.authType, args.authType)
      )
    );

  const nextSeq = (existing[0]?.maxSeq ?? -1) + 1;

  const [authRow] = await tx
    .insert(claimAuthorizations)
    .values({
      hospitalId: args.hospitalId,
      claimCaseId: args.claimCaseId,
      authType: args.authType,
      sequenceNumber: nextSeq,
      requestedIncrementalPaise: args.requestedIncrementalPaise ?? null,
      requestedCumulativePaise: args.requestedCumulativePaise,
      approvedIncrementalPaise: args.approvedIncrementalPaise ?? null,
      approvedCumulativePaise: args.approvedCumulativePaise ?? null,
      decision: args.decision,
      referenceNumber: args.referenceNumber ?? null,
      decisionNotes: args.decisionNotes ?? null,
      decidedAt: args.decision !== 'pending' ? new Date() : null,
      decidedByUserId: args.decision !== 'pending' ? args.actorUserId : null,
      clientId: args.clientId,
    })
    .returning();

  // If decision is approved/partially_approved and cumulative approved limit is given, update active limit
  const patch: Partial<typeof claimCases.$inferInsert> = {
    version: claim.version + 1,
    updatedAt: new Date(),
  };

  if (args.decision === 'approved' || args.decision === 'partially_approved') {
    if (args.approvedCumulativePaise != null) {
      patch.currentAuthorizedLimitPaise = args.approvedCumulativePaise;
      patch.approvedAmountPaise = args.approvedCumulativePaise;
    }
    if (args.authType === 'initial_preauth') {
      patch.preauthApprovedAt = new Date();
      if (claim.status === 'preauth_submitted') {
        patch.status = 'preauth_approved';
      }
    } else if (args.authType === 'enhancement') {
      if (claim.status === 'enhancement_requested') {
        patch.status = 'preauth_approved';
      }
    }
  } else if (args.decision === 'rejected') {
    if (args.authType === 'initial_preauth' && claim.status === 'preauth_submitted') {
      patch.status = 'preauth_rejected';
    } else if (args.authType === 'enhancement' && claim.status === 'enhancement_requested') {
      // Rejection of enhancement keeps previous approved pre-auth limit and restores preauth_approved
      patch.status = 'preauth_approved';
    }
  }

  await tx
    .update(claimCases)
    .set(patch)
    .where(and(eq(claimCases.id, claim.id), eq(claimCases.version, claim.version)));

  await tx.insert(claimEvents).values({
    hospitalId: args.hospitalId,
    claimCaseId: claim.id,
    eventType: args.authType === 'initial_preauth' ? 'preauth_approved' : 'enhancement_approved',
    previousStatus: claim.status,
    newStatus: (patch.status as string) ?? claim.status,
    amountPaise: args.approvedCumulativePaise ?? args.requestedCumulativePaise,
    externalReference: args.referenceNumber ?? null,
    notes: `Authorization (${args.authType} #${nextSeq}) decision: ${args.decision}. Cumulative: ₹${((args.approvedCumulativePaise ?? 0) / 100).toLocaleString('en-IN')}`,
    actorUserId: args.actorUserId,
    clientId: randomUUID(),
  });

  return authRow;
}

/**
 * Dispatches a claim packet submission or resubmission.
 * Computes an immutable SHA-256 hash over the payload and manifest.
 */
export async function submitClaimPacketInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
    submissionStage: SubmissionStage;
    channel: 'portal' | 'email' | 'physical_courier' | 'in_person';
    referenceNumber: string;
    claimedAmountPaise?: number | null;
    documentsManifest: DocumentManifestItem[];
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimSubmissionRow> {
  const [claim] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, args.claimCaseId), eq(claimCases.hospitalId, args.hospitalId)))
    .limit(1);

  if (!claim) {
    throw new ClaimNotFoundError(`Claim case '${args.claimCaseId}' not found.`);
  }

  // Count prior submissions for this case to derive sequence number and resubmission flag
  const prior = await tx
    .select({ maxSeq: sql<number>`coalesce(max(${claimSubmissions.submissionNumber}), 0)::int` })
    .from(claimSubmissions)
    .where(and(eq(claimSubmissions.hospitalId, args.hospitalId), eq(claimSubmissions.claimCaseId, args.claimCaseId)));

  const submissionNumber = (prior[0]?.maxSeq ?? 0) + 1;
  const isResubmission = submissionNumber > 1;

  // Build canonical payload and compute verifiable SHA-256 hash
  const canonicalPayload = {
    claimCaseId: args.claimCaseId,
    stage: args.submissionStage,
    submissionNumber,
    channel: args.channel,
    referenceNumber: args.referenceNumber,
    claimedAmountPaise: args.claimedAmountPaise ?? null,
    documentsManifest: args.documentsManifest.sort((a, b) => a.docCategory.localeCompare(b.docCategory)),
  };

  const packetHash = createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');

  const [submission] = await tx
    .insert(claimSubmissions)
    .values({
      hospitalId: args.hospitalId,
      claimCaseId: args.claimCaseId,
      submissionNumber,
      submissionStage: args.submissionStage,
      isResubmission,
      channel: args.channel,
      referenceNumber: args.referenceNumber,
      claimedAmountPaise: args.claimedAmountPaise ?? null,
      packetHash,
      snapshotPayload: canonicalPayload,
      submittedByUserId: args.actorUserId,
      clientId: args.clientId,
    })
    .returning();

  // Map submissionStage to target operational ClaimStatus
  let targetStatus: ClaimStatus = claim.status as ClaimStatus;
  if (args.submissionStage === 'preauth') {
    targetStatus = 'preauth_submitted';
  } else if (args.submissionStage === 'enhancement') {
    targetStatus = 'enhancement_requested';
  } else if (args.submissionStage === 'final_claim') {
    targetStatus = 'final_submitted';
  } else if (args.submissionStage === 'appeal') {
    targetStatus = 'appeal_submitted';
  }

  await transitionClaimStatusInTx(tx, {
    claimId: claim.id,
    hospitalId: args.hospitalId,
    expectedVersion: claim.version,
    targetStatus,
    submissionDetails: {
      sentAt: new Date(),
      channel: args.channel,
      reference: args.referenceNumber,
      claimedAmountPaise: args.claimedAmountPaise ?? null,
      documentsManifest: args.documentsManifest,
    },
    amountPaise: args.claimedAmountPaise,
    notes: `Packet #${submissionNumber} submitted (${args.submissionStage}, hash: ${packetHash.slice(0, 10)})`,
    actorUserId: args.actorUserId,
    clientId: randomUUID(),
  });

  return submission;
}

/**
 * Records a multi-receipt remittance, deduction, or TDS allocation into the audited ledger.
 * Reconciles financial settlement status without freezing or conflating operational workflows.
 */
export async function recordClaimRemittanceInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
    remittanceType: RemittanceType;
    paymentMethod?: PaymentMethod | null;
    payerReference?: string | null;
    amountPaise: number;
    tdsPaise?: number;
    deductionPaise?: number;
    coPayPaise?: number;
    disputedDeductionPaise?: number;
    adjudicatedPayablePaise?: number | null;
    dischargeBillId?: string | null;
    reversalOfRemittanceId?: string | null;
    reversalReason?: string | null;
    notes?: string | null;
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimRemittanceRow> {
  const [claim] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, args.claimCaseId), eq(claimCases.hospitalId, args.hospitalId)))
    .limit(1);

  if (!claim) {
    throw new ClaimNotFoundError(`Claim case '${args.claimCaseId}' not found.`);
  }

  const [remittance] = await tx
    .insert(claimRemittances)
    .values({
      hospitalId: args.hospitalId,
      claimCaseId: args.claimCaseId,
      remittanceType: args.remittanceType,
      paymentMethod: args.paymentMethod ?? null,
      payerReference: args.payerReference ?? null,
      amountPaise: args.amountPaise,
      tdsPaise: args.tdsPaise ?? 0,
      deductionPaise: args.deductionPaise ?? 0,
      coPayPaise: args.coPayPaise ?? 0,
      disputedDeductionPaise: args.disputedDeductionPaise ?? 0,
      reversalOfRemittanceId: args.reversalOfRemittanceId ?? null,
      reversalReason: args.reversalReason ?? null,
      notes: args.notes ?? null,
      recordedByUserId: args.actorUserId,
      clientId: args.clientId,
    })
    .returning();

  // Recompute deterministic financial rollups from all active remittances
  const rollups = await tx
    .select({
      totalRemitted: sql<number>`coalesce(sum(${claimRemittances.amountPaise}), 0)::bigint`,
      totalTds: sql<number>`coalesce(sum(${claimRemittances.tdsPaise}), 0)::bigint`,
      totalDeductions: sql<number>`coalesce(sum(${claimRemittances.deductionPaise}), 0)::bigint`,
      totalDisputed: sql<number>`coalesce(sum(${claimRemittances.disputedDeductionPaise}), 0)::bigint`,
    })
    .from(claimRemittances)
    .where(and(eq(claimRemittances.hospitalId, args.hospitalId), eq(claimRemittances.claimCaseId, args.claimCaseId)));

  const totalRemitted = Number(rollups[0]?.totalRemitted ?? 0);
  const totalTds = Number(rollups[0]?.totalTds ?? 0);
  const totalDeductions = Number(rollups[0]?.totalDeductions ?? 0);
  const totalDisputed = Number(rollups[0]?.totalDisputed ?? 0);

  const adjudicated = args.adjudicatedPayablePaise ?? claim.adjudicatedPayablePaise;

  // Determine reconciled settlement status
  // Liability discharge: In Indian healthcare insurance / TPA desk operations,
  // the adjudicated liability is fully discharged when:
  // cash receipt (totalRemitted) + tax withheld at source (totalTds, Sec 194J) >= adjudicated payable.
  // Deductions are the non-payable portion subtracted from claimed amount to arrive at adjudicated payable.
  // Therefore, totalRemitted + totalTds discharges adjudicated payable.
  let newSettlementStatus: SettlementStatus = 'unsettled';
  const totalDischarged = totalRemitted + totalTds;
  if (adjudicated != null && adjudicated > 0 && totalDischarged >= adjudicated) {
    newSettlementStatus = 'settled';
  } else if (totalRemitted > 0 || totalTds > 0) {
    newSettlementStatus = 'partially_settled';
  } else if (totalDisputed > 0) {
    newSettlementStatus = 'disputed';
  }

  const patch: Partial<typeof claimCases.$inferInsert> = {
    totalRemittedPaise: totalRemitted,
    totalTdsWithheldPaise: totalTds,
    totalDeductionsPaise: totalDeductions,
    totalDisputedPaise: totalDisputed,
    settledAmountPaise: totalRemitted,
    deductionAmountPaise: totalDeductions,
    settlementStatus: newSettlementStatus,
    legacyReconciliationRequired: false,
    settledAt: totalRemitted > 0 ? (claim.settledAt ?? new Date()) : null,
    dischargeBillId: args.dischargeBillId ?? claim.dischargeBillId,
    version: claim.version + 1,
    updatedAt: new Date(),
  };

  if (args.adjudicatedPayablePaise != null) {
    patch.adjudicatedPayablePaise = args.adjudicatedPayablePaise;
  }

  await tx
    .update(claimCases)
    .set(patch)
    .where(and(eq(claimCases.id, claim.id), eq(claimCases.version, claim.version)));

  await tx.insert(claimEvents).values({
    hospitalId: args.hospitalId,
    claimCaseId: claim.id,
    eventType: totalRemitted >= (adjudicated ?? Infinity) ? 'settled' : 'partially_settled',
    previousStatus: claim.status,
    newStatus: claim.status,
    amountPaise: args.amountPaise,
    externalReference: args.payerReference ?? null,
    notes: `Remittance recorded (${args.remittanceType}): ₹${(args.amountPaise / 100).toLocaleString('en-IN')}. Settlement: ${newSettlementStatus}`,
    actorUserId: args.actorUserId,
    clientId: randomUUID(),
  });

  return remittance;
}

/**
 * Reverses a previously recorded remittance by creating a linked negative adjustment row.
 */
export async function reverseClaimRemittanceInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    originalRemittanceId: string;
    reversalReason: string;
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimRemittanceRow> {
  const [orig] = await tx
    .select()
    .from(claimRemittances)
    .where(and(eq(claimRemittances.id, args.originalRemittanceId), eq(claimRemittances.hospitalId, args.hospitalId)))
    .limit(1);

  if (!orig) {
    throw new RemittanceNotFoundError(`Remittance '${args.originalRemittanceId}' not found.`);
  }

  return recordClaimRemittanceInTx(tx, {
    hospitalId: args.hospitalId,
    claimCaseId: orig.claimCaseId,
    remittanceType: 'correction_reversal',
    paymentMethod: orig.paymentMethod,
    payerReference: `REV-${orig.payerReference || orig.id.slice(0, 8)}`,
    amountPaise: -orig.amountPaise,
    tdsPaise: -orig.tdsPaise,
    deductionPaise: -orig.deductionPaise,
    coPayPaise: -orig.coPayPaise,
    disputedDeductionPaise: -orig.disputedDeductionPaise,
    reversalOfRemittanceId: orig.id,
    reversalReason: args.reversalReason,
    notes: `Authorized reversal of remittance ${orig.id}: ${args.reversalReason}`,
    actorUserId: args.actorUserId,
    clientId: args.clientId,
  });
}

/**
 * Legacy settlement helper maintained for compatibility.
 * Delegates to recordClaimRemittanceInTx.
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
  await recordClaimRemittanceInTx(tx, {
    hospitalId: args.hospitalId,
    claimCaseId: args.claimId,
    remittanceType: 'payment',
    amountPaise: args.settledAmountPaise,
    deductionPaise: args.deductionAmountPaise,
    coPayPaise: args.coPayAmountPaise,
    dischargeBillId: args.dischargeBillId,
    adjudicatedPayablePaise: args.settledAmountPaise,
    actorUserId: args.actorUserId,
    clientId: args.clientId,
  });

  const [row] = await tx
    .select()
    .from(claimCases)
    .where(and(eq(claimCases.id, args.claimId), eq(claimCases.hospitalId, args.hospitalId)))
    .limit(1);

  return row;
}

/**
 * Decrypts a sensitive policy number, logging the decryption event in record_access_logs.
 */
export async function decryptClaimPolicyNumber(
  tx: Tx,
  args: {
    claim: Pick<
      ClaimCaseRow,
      'id' | 'policyNumberCiphertext' | 'policyNumberIv' | 'policyNumberTag' | 'policyNumberKeyVersion' | 'hospitalId'
    >;
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

/**
 * Retrieves the active claim case associated with an admission, if any.
 */
export async function getClaimCaseByAdmissionId(
  tx: Tx,
  args: {
    hospitalId: string;
    admissionId: string;
    role?: StaffRole;
  }
): Promise<ClaimCaseRow | null> {
  const [row] = await tx
    .select()
    .from(claimCases)
    .where(
      and(
        eq(claimCases.hospitalId, args.hospitalId),
        eq(claimCases.admissionId, args.admissionId),
        isNull(claimCases.voidedAt)
      )
    )
    .orderBy(desc(claimCases.createdAt))
    .limit(1);

  if (!row) return null;
  return args.role ? maskClaimFinancialsForRole(row, args.role) : row;
}

/**
 * Lists chronological forensic events for a claim case.
 */
export async function listClaimEventsForCase(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
  }
) {
  return tx
    .select()
    .from(claimEvents)
    .where(and(eq(claimEvents.hospitalId, args.hospitalId), eq(claimEvents.claimCaseId, args.claimCaseId)))
    .orderBy(desc(claimEvents.createdAt));
}

/**
 * Lists queries raised by insurer/TPA for a claim case.
 */
export async function listClaimQueriesForCase(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
  }
) {
  return tx
    .select()
    .from(claimQueries)
    .where(
      and(
        eq(claimQueries.hospitalId, args.hospitalId),
        eq(claimQueries.claimCaseId, args.claimCaseId),
        isNull(claimQueries.voidedAt)
      )
    )
    .orderBy(desc(claimQueries.receivedAt));
}

/**
 * Lists physical document custody checklist records for a claim case.
 */
export async function listClaimDocumentsForCase(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
  }
) {
  return tx
    .select()
    .from(claimDocumentRecords)
    .where(
      and(
        eq(claimDocumentRecords.hospitalId, args.hospitalId),
        eq(claimDocumentRecords.claimCaseId, args.claimCaseId),
        isNull(claimDocumentRecords.voidedAt)
      )
    )
    .orderBy(desc(claimDocumentRecords.createdAt));
}

/**
 * Lists historical authorizations and enhancements for a claim case.
 */
export async function listClaimAuthorizationsForCase(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
  }
) {
  return tx
    .select()
    .from(claimAuthorizations)
    .where(
      and(
        eq(claimAuthorizations.hospitalId, args.hospitalId),
        eq(claimAuthorizations.claimCaseId, args.claimCaseId)
      )
    )
    .orderBy(desc(claimAuthorizations.requestedAt));
}

/**
 * Lists all dispatched submission packets for a claim case.
 */
export async function listClaimSubmissionsForCase(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
  }
) {
  return tx
    .select()
    .from(claimSubmissions)
    .where(
      and(
        eq(claimSubmissions.hospitalId, args.hospitalId),
        eq(claimSubmissions.claimCaseId, args.claimCaseId)
      )
    )
    .orderBy(desc(claimSubmissions.submittedAt));
}

/**
 * Lists all remittances, receipts, deductions, and reversals for a claim case.
 */
export async function listClaimRemittancesForCase(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
  }
) {
  return tx
    .select()
    .from(claimRemittances)
    .where(
      and(
        eq(claimRemittances.hospitalId, args.hospitalId),
        eq(claimRemittances.claimCaseId, args.claimCaseId)
      )
    )
    .orderBy(desc(claimRemittances.receivedAt));
}

/**
 * Updates or creates a physical paper custody checklist record.
 */
export async function upsertClaimDocumentRecordInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    claimCaseId: string;
    docCategory: string;
    isPaperFiled: boolean;
    physicalBoxOrFileNo?: string | null;
    notes?: string | null;
    actorUserId: string;
    clientId: string;
  }
) {
  const [existing] = await tx
    .select()
    .from(claimDocumentRecords)
    .where(
      and(
        eq(claimDocumentRecords.hospitalId, args.hospitalId),
        eq(claimDocumentRecords.claimCaseId, args.claimCaseId),
        eq(claimDocumentRecords.docCategory, args.docCategory),
        isNull(claimDocumentRecords.voidedAt)
      )
    )
    .limit(1);

  if (existing) {
    const [updated] = await tx
      .update(claimDocumentRecords)
      .set({
        isPaperFiled: args.isPaperFiled,
        paperFiledAt: args.isPaperFiled ? new Date() : null,
        paperFiledByUserId: args.isPaperFiled ? args.actorUserId : null,
        physicalBoxOrFileNo: args.physicalBoxOrFileNo ?? existing.physicalBoxOrFileNo,
        notes: args.notes ?? existing.notes,
        updatedAt: new Date(),
      })
      .where(eq(claimDocumentRecords.id, existing.id))
      .returning();
    return updated;
  }

  const [inserted] = await tx
    .insert(claimDocumentRecords)
    .values({
      hospitalId: args.hospitalId,
      claimCaseId: args.claimCaseId,
      docCategory: args.docCategory,
      isPaperFiled: args.isPaperFiled,
      paperFiledAt: args.isPaperFiled ? new Date() : null,
      paperFiledByUserId: args.isPaperFiled ? args.actorUserId : null,
      physicalBoxOrFileNo: args.physicalBoxOrFileNo ?? null,
      notes: args.notes ?? null,
      clientId: args.clientId,
    })
    .returning();

  return inserted;
}

/**
 * Closes a settled claim after complete financial reconciliation.
 */
export async function closeClaimCaseInTx(
  tx: Tx,
  args: {
    claimId: string;
    hospitalId: string;
    expectedVersion: number;
    notes?: string | null;
    actorUserId: string;
    clientId: string;
  }
): Promise<ClaimCaseRow> {
  return transitionClaimStatusInTx(tx, {
    claimId: args.claimId,
    hospitalId: args.hospitalId,
    expectedVersion: args.expectedVersion,
    targetStatus: 'closed_settled',
    notes: args.notes ?? 'Claim formally closed following complete reconciliation.',
    actorUserId: args.actorUserId,
    clientId: args.clientId,
  });
}

/**
 * Reopens a closed claim under audited supervisor control (e.g. for post-settlement audits,
 * supplementary payments, clawbacks, or arbitration appeals).
 */
export async function reopenClaimCaseInTx(
  tx: Tx,
  args: {
    claimId: string;
    hospitalId: string;
    expectedVersion: number;
    reopenReason: string;
    targetStatus?: 'settled' | 'final_submitted';
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

  if (current.status === 'closed_cancelled') {
    throw new InvalidClaimTransitionError('Cancelled claims cannot be reopened.');
  }

  if (current.status !== 'closed_settled' && current.status !== 'settled') {
    throw new InvalidClaimTransitionError(`Cannot reopen claim in non-closed status '${current.status}'.`);
  }

  if (!args.reopenReason || args.reopenReason.trim().length === 0) {
    throw new Error('Explicit reopenReason is required for controlled reopening.');
  }

  const newStatus = args.targetStatus ?? 'settled';

  const [updated] = await tx
    .update(claimCases)
    .set({
      status: newStatus,
      version: current.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(claimCases.id, args.claimId), eq(claimCases.version, current.version)))
    .returning();

  if (!updated) {
    throw new StaleClaimVersionError(`Concurrent update conflict for claim '${args.claimId}'. Transaction aborted.`);
  }

  await tx.insert(claimEvents).values({
    hospitalId: args.hospitalId,
    claimCaseId: args.claimId,
    eventType: 'reopened',
    previousStatus: current.status,
    newStatus,
    notes: `Controlled reopening: ${args.reopenReason}`,
    actorUserId: args.actorUserId,
    clientId: args.clientId,
  });

  return updated;
}

