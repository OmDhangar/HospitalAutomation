/**
 * Claims Domain: State machine, transition validation, terminal status guards,
 * operational vs settlement separation, authorization limits, and SLA clock calculations.
 */

export const CLAIM_STATUSES = [
  'draft',
  'preauth_submitted',
  'query_raised',
  'preauth_approved',
  'preauth_rejected',
  'enhancement_requested',
  'claim_ready',
  'final_submitted',
  'settled',
  'partially_settled',
  'closed_settled',
  'claim_rejected',
  'appeal_in_progress',
  'appeal_submitted',
  'appeal_won',
  'appeal_lost',
  'reimbursement_draft',
  'reimbursement_docs_gathering',
  'reimbursement_dossier_ready',
  'dossier_handed_to_patient',
  'closed_cancelled',
] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const SETTLEMENT_STATUSES = [
  'unsettled',
  'partially_settled',
  'settled',
  'disputed',
  'written_off',
  'legacy_reconciliation_required',
] as const;

export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const AUTH_TYPES = ['initial_preauth', 'enhancement'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const AUTH_DECISIONS = ['pending', 'approved', 'partially_approved', 'rejected'] as const;
export type AuthDecision = (typeof AUTH_DECISIONS)[number];

export const SUBMISSION_STAGES = ['preauth', 'enhancement', 'final_claim', 'appeal'] as const;
export type SubmissionStage = (typeof SUBMISSION_STAGES)[number];

export const REMITTANCE_TYPES = [
  'payment',
  'tds_withholding',
  'deduction',
  'disputed_deduction',
  'correction_reversal',
  'legacy_backfill',
] as const;
export type RemittanceType = (typeof REMITTANCE_TYPES)[number];

export const PAYMENT_METHODS = ['neft', 'rtgs', 'cheque', 'portal_credit', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const QUERY_STATUSES = [
  'pending_hospital',
  'replied_by_hospital',
  'replied',
  'resolved_accepted',
  're_queried',
  'disputed',
  'escalated_to_doctor',
] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

export const DEADLINE_TYPES = ['hospital_response', 'insurer_sla'] as const;
export type DeadlineType = (typeof DEADLINE_TYPES)[number];

export class InvalidClaimTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidClaimTransitionError';
  }
}

export class ImmutableSettledClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImmutableSettledClaimError';
  }
}

export class MissingSubmissionDetailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingSubmissionDetailsError';
  }
}

export type SubmissionChannel = 'portal' | 'email' | 'physical_courier' | 'in_person';

export type DocumentManifestItem = {
  docCategory: string;
  recordId?: string | null;
  version?: number | null;
  label?: string | null;
  contentHash?: string | null;
  isPaperOriginal?: boolean;
};

export type SubmissionDetails = {
  sentAt: Date;
  channel: SubmissionChannel;
  reference: string;
  claimedAmountPaise?: number | null;
  documentsManifest?: DocumentManifestItem[];
};

export type ClaimTransitionInput = {
  currentStatus: ClaimStatus;
  targetStatus: ClaimStatus;
  isReimbursement?: boolean;
  submissionDetails?: SubmissionDetails;
};

const ALLOWED_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ['preauth_submitted', 'closed_cancelled'],
  preauth_submitted: ['query_raised', 'preauth_approved', 'preauth_rejected', 'closed_cancelled'],
  query_raised: [
    'preauth_submitted',
    'enhancement_requested',
    'final_submitted',
    'preauth_rejected',
    'closed_cancelled',
  ],
  preauth_approved: ['enhancement_requested', 'claim_ready', 'final_submitted', 'closed_cancelled'],
  enhancement_requested: ['preauth_approved', 'query_raised', 'closed_cancelled'],
  claim_ready: ['final_submitted', 'closed_cancelled'],
  final_submitted: ['settled', 'partially_settled', 'claim_rejected', 'query_raised', 'closed_cancelled'],
  settled: ['closed_settled', 'partially_settled', 'appeal_in_progress', 'closed_cancelled'],
  partially_settled: ['settled', 'appeal_in_progress', 'closed_cancelled'],
  closed_settled: [],
  preauth_rejected: ['appeal_in_progress', 'closed_cancelled'],
  claim_rejected: ['appeal_in_progress', 'closed_cancelled'],
  appeal_in_progress: ['appeal_submitted', 'closed_cancelled'],
  appeal_submitted: ['appeal_won', 'appeal_lost', 'closed_cancelled'],
  appeal_won: ['preauth_approved', 'settled', 'claim_ready'],
  appeal_lost: ['closed_cancelled'],
  reimbursement_draft: ['reimbursement_docs_gathering', 'closed_cancelled'],
  reimbursement_docs_gathering: ['reimbursement_dossier_ready', 'closed_cancelled'],
  reimbursement_dossier_ready: ['dossier_handed_to_patient', 'closed_cancelled'],
  dossier_handed_to_patient: ['settled', 'partially_settled', 'claim_rejected', 'closed_cancelled'],
  closed_cancelled: [],
};

const REQUIRES_SUBMISSION_DETAILS: ReadonlySet<ClaimStatus> = new Set([
  'preauth_submitted',
  'final_submitted',
  'appeal_submitted',
]);

/**
 * Returns true only when a claim has been irreversibly closed or cancelled.
 * Settled claims are operational milestones and can still receive audited financial adjustments or appeals.
 */
export function isTerminalClaimStatus(status: ClaimStatus): boolean {
  return status === 'closed_cancelled';
}

/**
 * Returns true when a claim is in any closed state (normal closed_settled or closed_cancelled).
 */
export function isClosedClaimStatus(status: ClaimStatus): boolean {
  return status === 'closed_settled' || status === 'closed_cancelled';
}

/**
 * Validates a state machine transition. Throws typed domain errors on violation.
 */
export function validateClaimTransition(input: ClaimTransitionInput): void {
  const { currentStatus, targetStatus, submissionDetails } = input;

  if (isTerminalClaimStatus(currentStatus)) {
    throw new ImmutableSettledClaimError(
      `Cannot transition from terminal status '${currentStatus}'. Closed claims cannot be transitioned.`
    );
  }

  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(targetStatus)) {
    throw new InvalidClaimTransitionError(
      `Invalid claim transition from '${currentStatus}' to '${targetStatus}'.`
    );
  }

  if (REQUIRES_SUBMISSION_DETAILS.has(targetStatus)) {
    if (!submissionDetails || !submissionDetails.sentAt || !submissionDetails.channel || !submissionDetails.reference) {
      throw new MissingSubmissionDetailsError(
        `Transition to '${targetStatus}' requires explicit submission details (sentAt, channel, reference).`
      );
    }
  }
}

/**
 * Calculates pre-auth SLA deadline in minutes.
 */
export function calculatePreauthDeadlineMinutes(submittedAt: Date, slaMinutes: number): Date {
  return new Date(submittedAt.getTime() + slaMinutes * 60 * 1000);
}

/**
 * Calculates query response SLA deadline in minutes.
 */
export function calculateQueryDeadlineMinutes(receivedAt: Date, slaMinutes: number): Date {
  return new Date(receivedAt.getTime() + slaMinutes * 60 * 1000);
}
