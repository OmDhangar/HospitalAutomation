/**
 * Claims Domain: State machine, transition validation, terminal status guards,
 * and operational minute-accurate SLA clock calculations.
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

export type SubmissionDetails = {
  sentAt: Date;
  channel: SubmissionChannel;
  reference: string;
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
  query_raised: ['preauth_submitted', 'preauth_rejected', 'closed_cancelled'],
  preauth_approved: ['enhancement_requested', 'claim_ready', 'final_submitted', 'closed_cancelled'],
  enhancement_requested: ['preauth_approved', 'query_raised', 'closed_cancelled'],
  claim_ready: ['final_submitted', 'closed_cancelled'],
  final_submitted: ['settled', 'partially_settled', 'claim_rejected', 'query_raised'],
  settled: [],
  partially_settled: [],
  preauth_rejected: ['appeal_in_progress', 'closed_cancelled'],
  claim_rejected: ['appeal_in_progress', 'closed_cancelled'],
  appeal_in_progress: ['appeal_submitted', 'closed_cancelled'],
  appeal_submitted: ['appeal_won', 'appeal_lost', 'closed_cancelled'],
  appeal_won: ['preauth_approved', 'settled', 'claim_ready'],
  appeal_lost: ['closed_cancelled'],
  reimbursement_draft: ['reimbursement_docs_gathering', 'closed_cancelled'],
  reimbursement_docs_gathering: ['reimbursement_dossier_ready', 'closed_cancelled'],
  reimbursement_dossier_ready: ['dossier_handed_to_patient', 'closed_cancelled'],
  dossier_handed_to_patient: ['settled', 'partially_settled', 'claim_rejected'],
  closed_cancelled: [],
};

const REQUIRES_SUBMISSION_DETAILS: ReadonlySet<ClaimStatus> = new Set([
  'preauth_submitted',
  'final_submitted',
  'appeal_submitted',
]);

export function isTerminalClaimStatus(status: ClaimStatus): boolean {
  return status === 'settled' || status === 'partially_settled';
}

/**
 * Validates a state machine transition. Throws typed domain errors on violation.
 */
export function validateClaimTransition(input: ClaimTransitionInput): void {
  const { currentStatus, targetStatus, submissionDetails } = input;

  if (isTerminalClaimStatus(currentStatus)) {
    throw new ImmutableSettledClaimError(
      `Cannot transition from terminal status '${currentStatus}'. Settled claims are immutable.`
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
