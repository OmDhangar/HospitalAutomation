import { describe, expect, it } from 'vitest';
import {
  computeNoticeSelection,
  SelectionCapacityConflictError,
  type MandatoryInput,
  type RecipientCandidate,
} from '../notice-selection';

describe('computeNoticeSelection', () => {
  const baseDate = new Date('2026-10-23T10:00:00Z');

  function makeCandidate(
    i: number,
    opts: Partial<RecipientCandidate> = {},
  ): RecipientCandidate {
    const phone = `+9198200${String(i).padStart(5, '0')}`;
    return {
      phoneE164: phone,
      patientId: `p-${i}`,
      patientName: `Patient ${i}`,
      lastActivityAt: new Date(baseDate.getTime() + i * 60_000),
      activityType: 'appointment',
      hasConsent: true,
      isOptedOut: false,
      ...opts,
    };
  }

  it('handles zero eligible candidates with no mandatory inputs', () => {
    const result = computeNoticeSelection({
      candidates: [],
      mandatory: [],
      availableAccountCapacity: 250,
    });

    expect(result.totalEligibleRecipients).toBe(0);
    expect(result.totalSelectedRecipients).toBe(0);
    expect(result.mandatoryIncludedCount).toBe(0);
    expect(result.displacedCount).toBe(0);
    expect(result.finalRecipients).toEqual([]);
  });

  it('handles fewer than 250 candidates', () => {
    const candidates = [
      makeCandidate(1),
      makeCandidate(2),
      makeCandidate(3),
    ];

    const result = computeNoticeSelection({
      candidates,
      mandatory: [],
      availableAccountCapacity: 250,
    });

    expect(result.totalEligibleRecipients).toBe(3);
    expect(result.totalSelectedRecipients).toBe(3);
    // Highest activity time first
    expect(result.finalRecipients[0].phoneE164).toBe(candidates[2].phoneE164);
    expect(result.finalRecipients[1].phoneE164).toBe(candidates[1].phoneE164);
    expect(result.finalRecipients[2].phoneE164).toBe(candidates[0].phoneE164);
  });

  it('enforces campaign cap of 250 when more than 250 candidates exist', () => {
    const candidates = Array.from({ length: 300 }, (_, i) => makeCandidate(i));

    const result = computeNoticeSelection({
      candidates,
      mandatory: [],
      availableAccountCapacity: 500,
    });

    expect(result.campaignCapacity).toBe(250);
    expect(result.totalEligibleRecipients).toBe(300);
    expect(result.totalSelectedRecipients).toBe(250);
    // Most recent (i=299 down to 50) selected
    expect(result.finalRecipients[0].phoneE164).toBe(candidates[299].phoneE164);
    expect(result.finalRecipients[249].phoneE164).toBe(candidates[50].phoneE164);
  });

  it('prioritizes patients with affected appointments over higher recency', () => {
    const recentPatient = makeCandidate(10, {
      lastActivityAt: new Date(baseDate.getTime() + 100_000),
      hasAffectedAppointment: false,
    });
    const affectedPatient = makeCandidate(1, {
      lastActivityAt: new Date(baseDate.getTime() + 1_000),
      hasAffectedAppointment: true,
    });

    const result = computeNoticeSelection({
      candidates: [recentPatient, affectedPatient],
      mandatory: [],
      availableAccountCapacity: 250,
    });

    expect(result.finalRecipients[0].phoneE164).toBe(affectedPatient.phoneE164);
    expect(result.finalRecipients[0].selectionReason).toBe('affected_appointment');
    expect(result.finalRecipients[1].phoneE164).toBe(recentPatient.phoneE164);
    expect(result.finalRecipients[1].selectionReason).toBe('recent_activity');
  });

  it('places mandatory recipients at top and displaces least recent non-mandatory recipients', () => {
    // 250 candidates: i = 0 to 249.
    // Default top 250 includes all 0..249.
    const candidates = Array.from({ length: 250 }, (_, i) => makeCandidate(i));

    // Admin adds 2 mandatory recipients from outside the top 250:
    // candidate with older activity or custom phone
    const outsideMandatory1: MandatoryInput = {
      phoneE164: '+919999900001',
      patientName: 'VIP 1',
      hasConsent: true,
      isOptedOut: false,
    };
    const outsideMandatory2: MandatoryInput = {
      phoneE164: '+919999900002',
      patientName: 'VIP 2',
      hasConsent: true,
      isOptedOut: false,
    };

    const result = computeNoticeSelection({
      candidates,
      mandatory: [outsideMandatory1, outsideMandatory2],
      availableAccountCapacity: 250,
    });

    expect(result.totalSelectedRecipients).toBe(250);
    expect(result.mandatoryIncludedCount).toBe(2);
    expect(result.mandatoryAddedFromOutsideCount).toBe(2);
    expect(result.mandatoryAlreadyInDefaultCount).toBe(0);
    expect(result.displacedCount).toBe(2);

    // The 2 displaced should be the 2 least-recent candidates (i=0 and i=1)
    const displacedPhones = result.displacedRecipients.map((d) => d.phoneE164);
    expect(displacedPhones).toContain(candidates[0].phoneE164);
    expect(displacedPhones).toContain(candidates[1].phoneE164);

    // Final recipients must have mandatory at top with priority 100
    expect(result.finalRecipients[0].priority).toBe(100);
    expect(result.finalRecipients[0].selectionReason).toBe('mandatory');
    expect(result.finalRecipients[1].priority).toBe(100);
    expect(result.finalRecipients[1].selectionReason).toBe('mandatory');
  });

  it('correctly calculates mandatory recipients already in default top 250', () => {
    const candidates = Array.from({ length: 300 }, (_, i) => makeCandidate(i));

    // Candidate 290 is already in default top 250
    // Candidate 10 is outside default top 250 (since 300 candidates, top 250 is 50..299)
    const mandatory1: MandatoryInput = {
      phoneE164: candidates[290].phoneE164,
      patientName: candidates[290].patientName,
      hasConsent: true,
    };
    const mandatory2: MandatoryInput = {
      phoneE164: candidates[10].phoneE164,
      patientName: candidates[10].patientName,
      hasConsent: true,
    };

    const result = computeNoticeSelection({
      candidates,
      mandatory: [mandatory1, mandatory2],
      availableAccountCapacity: 250,
    });

    expect(result.totalSelectedRecipients).toBe(250);
    expect(result.mandatoryIncludedCount).toBe(2);
    expect(result.mandatoryAlreadyInDefaultCount).toBe(1);
    expect(result.mandatoryAddedFromOutsideCount).toBe(1);
    expect(result.displacedCount).toBe(1);
    // Candidate 50 (the 250th in default) was displaced by mandatory2 (candidate 10)
    expect(result.displacedRecipients[0].phoneE164).toBe(candidates[50].phoneE164);
  });

  it('deduplicates multiple patient records sharing the same phone number', () => {
    const phone = '+919820011111';
    const candidate1 = makeCandidate(1, {
      phoneE164: phone,
      lastActivityAt: new Date(baseDate.getTime() + 10_000),
      hasConsent: true,
    });
    const candidate2 = makeCandidate(2, {
      phoneE164: phone,
      lastActivityAt: new Date(baseDate.getTime() + 50_000), // more recent
      hasConsent: true,
    });

    const result = computeNoticeSelection({
      candidates: [candidate1, candidate2],
      mandatory: [],
      availableAccountCapacity: 250,
    });

    expect(result.totalEligibleRecipients).toBe(1);
    expect(result.totalSelectedRecipients).toBe(1);
    expect(result.finalRecipients[0].phoneE164).toBe(phone);
    expect(result.finalRecipients[0].lastActivityAt).toEqual(candidate2.lastActivityAt);
  });

  it('excludes candidates without consent or who have opted out', () => {
    const consenting = makeCandidate(1, { hasConsent: true, isOptedOut: false });
    const noConsent = makeCandidate(2, { hasConsent: false, isOptedOut: false });
    const optedOut = makeCandidate(3, { hasConsent: true, isOptedOut: true });

    const result = computeNoticeSelection({
      candidates: [consenting, noConsent, optedOut],
      mandatory: [],
      availableAccountCapacity: 250,
    });

    expect(result.totalEligibleRecipients).toBe(1);
    expect(result.totalSelectedRecipients).toBe(1);
    expect(result.finalRecipients[0].phoneE164).toBe(consenting.phoneE164);
  });

  it('flags ineligible mandatory recipients with exact reasons', () => {
    const invalidPhoneMandatory: MandatoryInput = {
      phoneE164: '12345',
      patientName: 'Bad Phone',
    };
    const noConsentMandatory: MandatoryInput = {
      phoneE164: '+919820011111',
      patientName: 'No Consent',
      hasConsent: false,
    };
    const optedOutMandatory: MandatoryInput = {
      phoneE164: '+919820022222',
      patientName: 'Opted Out',
      hasConsent: true,
      isOptedOut: true,
    };

    const result = computeNoticeSelection({
      candidates: [],
      mandatory: [invalidPhoneMandatory, noConsentMandatory, optedOutMandatory],
      availableAccountCapacity: 250,
    });

    expect(result.mandatoryIncludedCount).toBe(0);
    expect(result.ineligibleMandatoryCount).toBe(3);
    expect(result.ineligibleRecipients).toEqual([
      { phoneE164: '12345', patientName: 'Bad Phone', reason: 'invalid_phone' },
      { phoneE164: '+919820011111', patientName: 'No Consent', reason: 'no_consent' },
      { phoneE164: '+919820022222', patientName: 'Opted Out', reason: 'opted_out' },
    ]);
  });

  it('throws SelectionCapacityConflictError when eligible mandatory exceeds effective capacity', () => {
    const mandatoryInputs: MandatoryInput[] = Array.from({ length: 60 }, (_, i) => ({
      phoneE164: `+9198200${String(i).padStart(5, '0')}`,
      hasConsent: true,
      isOptedOut: false,
    }));

    // Available account capacity is only 50
    expect(() =>
      computeNoticeSelection({
        candidates: [],
        mandatory: mandatoryInputs,
        availableAccountCapacity: 50,
      }),
    ).toThrow(SelectionCapacityConflictError);
  });

  it('respects account available capacity when below 250', () => {
    const candidates = Array.from({ length: 100 }, (_, i) => makeCandidate(i));

    const result = computeNoticeSelection({
      candidates,
      mandatory: [],
      availableAccountCapacity: 40,
    });

    expect(result.campaignCapacity).toBe(40);
    expect(result.totalEligibleRecipients).toBe(100);
    expect(result.totalSelectedRecipients).toBe(40);
  });

  it('uses phoneE164 as stable tie-breaker when activity timestamps are identical', () => {
    const sameTime = new Date('2026-10-23T12:00:00Z');
    const c1 = makeCandidate(2, { phoneE164: '+919820099999', lastActivityAt: sameTime });
    const c2 = makeCandidate(1, { phoneE164: '+919820011111', lastActivityAt: sameTime });

    const result = computeNoticeSelection({
      candidates: [c1, c2],
      mandatory: [],
      availableAccountCapacity: 250,
    });

    // '+919820011111' sorts before '+919820099999' alphabetically
    expect(result.finalRecipients[0].phoneE164).toBe('+919820011111');
    expect(result.finalRecipients[1].phoneE164).toBe('+919820099999');
  });
});
