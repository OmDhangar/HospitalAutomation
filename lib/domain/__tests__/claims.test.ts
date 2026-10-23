import { describe, it, expect } from 'vitest';
import {
  validateClaimTransition,
  isTerminalClaimStatus,
  calculatePreauthDeadlineMinutes,
  calculateQueryDeadlineMinutes,
  InvalidClaimTransitionError,
  ImmutableSettledClaimError,
  MissingSubmissionDetailsError,
  type ClaimStatus,
} from '../claims';

describe('Claims Domain State Machine & Clocks', () => {
  it('allows valid cashless progression steps', () => {
    // draft -> preauth_submitted with submission details
    expect(() =>
      validateClaimTransition({
        currentStatus: 'draft',
        targetStatus: 'preauth_submitted',
        submissionDetails: { sentAt: new Date(), channel: 'portal', reference: 'ACK-123' },
      })
    ).not.toThrow();

    // preauth_submitted -> preauth_approved
    expect(() =>
      validateClaimTransition({
        currentStatus: 'preauth_submitted',
        targetStatus: 'preauth_approved',
      })
    ).not.toThrow();

    // preauth_approved -> claim_ready
    expect(() =>
      validateClaimTransition({
        currentStatus: 'preauth_approved',
        targetStatus: 'claim_ready',
      })
    ).not.toThrow();

    // claim_ready -> final_submitted with submission details
    expect(() =>
      validateClaimTransition({
        currentStatus: 'claim_ready',
        targetStatus: 'final_submitted',
        submissionDetails: { sentAt: new Date(), channel: 'portal', reference: 'FINAL-999' },
      })
    ).not.toThrow();

    // final_submitted -> settled
    expect(() =>
      validateClaimTransition({
        currentStatus: 'final_submitted',
        targetStatus: 'settled',
      })
    ).not.toThrow();
  });

  it('allows valid reimbursement progression steps', () => {
    expect(() =>
      validateClaimTransition({
        currentStatus: 'reimbursement_draft',
        targetStatus: 'reimbursement_docs_gathering',
        isReimbursement: true,
      })
    ).not.toThrow();

    expect(() =>
      validateClaimTransition({
        currentStatus: 'reimbursement_docs_gathering',
        targetStatus: 'reimbursement_dossier_ready',
        isReimbursement: true,
      })
    ).not.toThrow();

    expect(() =>
      validateClaimTransition({
        currentStatus: 'reimbursement_dossier_ready',
        targetStatus: 'dossier_handed_to_patient',
        isReimbursement: true,
      })
    ).not.toThrow();
  });

  it('allows post-rejection appeal paths', () => {
    expect(() =>
      validateClaimTransition({
        currentStatus: 'preauth_rejected',
        targetStatus: 'appeal_in_progress',
      })
    ).not.toThrow();

    expect(() =>
      validateClaimTransition({
        currentStatus: 'appeal_in_progress',
        targetStatus: 'appeal_submitted',
        submissionDetails: { sentAt: new Date(), channel: 'email', reference: 'APP-101' },
      })
    ).not.toThrow();

    expect(() =>
      validateClaimTransition({
        currentStatus: 'appeal_submitted',
        targetStatus: 'appeal_won',
      })
    ).not.toThrow();
  });

  it('requires explicit submission details when transitioning to preauth_submitted or final_submitted', () => {
    expect(() =>
      validateClaimTransition({
        currentStatus: 'draft',
        targetStatus: 'preauth_submitted',
      })
    ).toThrow(MissingSubmissionDetailsError);

    expect(() =>
      validateClaimTransition({
        currentStatus: 'claim_ready',
        targetStatus: 'final_submitted',
      })
    ).toThrow(MissingSubmissionDetailsError);
  });

  it('blocks illegal transition hops', () => {
    expect(() =>
      validateClaimTransition({
        currentStatus: 'draft',
        targetStatus: 'settled',
      })
    ).toThrow(InvalidClaimTransitionError);

    expect(() =>
      validateClaimTransition({
        currentStatus: 'preauth_submitted',
        targetStatus: 'claim_ready',
      })
    ).toThrow(InvalidClaimTransitionError);
  });

  it('enforces that closed_cancelled is terminal and partial settlements do not lock the claim', () => {
    expect(isTerminalClaimStatus('closed_cancelled')).toBe(true);
    expect(isTerminalClaimStatus('settled')).toBe(false);
    expect(isTerminalClaimStatus('partially_settled')).toBe(false);
    expect(isTerminalClaimStatus('draft')).toBe(false);

    // Closed / cancelled claims cannot transition further
    expect(() =>
      validateClaimTransition({
        currentStatus: 'closed_cancelled',
        targetStatus: 'draft',
      })
    ).toThrow(ImmutableSettledClaimError);

    // Partially settled claims are not permanently frozen: can transition to settled or appeal
    expect(() =>
      validateClaimTransition({
        currentStatus: 'partially_settled',
        targetStatus: 'settled',
      })
    ).not.toThrow();

    expect(() =>
      validateClaimTransition({
        currentStatus: 'partially_settled',
        targetStatus: 'appeal_in_progress',
      })
    ).not.toThrow();

    // Partially settled claims cannot hop back to draft
    expect(() =>
      validateClaimTransition({
        currentStatus: 'partially_settled',
        targetStatus: 'draft',
      })
    ).toThrow(InvalidClaimTransitionError);
  });

  it('calculates minute-based SLA deadlines accurately', () => {
    const baseDate = new Date('2026-10-21T10:00:00.000Z');
    
    // 360 minutes (6 hours)
    const preauthDeadline = calculatePreauthDeadlineMinutes(baseDate, 360);
    expect(preauthDeadline.toISOString()).toBe('2026-10-21T16:00:00.000Z');

    // 120 minutes (2 hours)
    const queryDeadline = calculateQueryDeadlineMinutes(baseDate, 120);
    expect(queryDeadline.toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });
});
