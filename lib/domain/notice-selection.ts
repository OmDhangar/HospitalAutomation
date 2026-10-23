import { normalizeIndianPhone } from './phone';

export type RecipientCandidate = {
  phoneE164: string;
  patientId: string | null;
  patientName: string;
  lastActivityAt: Date;
  activityType: 'appointment' | 'whatsapp_inbound' | 'check_in' | 'registration';
  hasConsent: boolean;
  isOptedOut: boolean;
  hasAffectedAppointment?: boolean;
};

export type MandatoryInput = {
  phoneE164: string;
  patientId?: string | null;
  patientName?: string;
  hasConsent?: boolean;
  isOptedOut?: boolean;
};

export type IneligibleRecipient = {
  phoneE164: string;
  patientName?: string;
  reason: 'invalid_phone' | 'no_consent' | 'opted_out';
};

export type DisplacedRecipient = {
  phoneE164: string;
  patientId: string | null;
  patientName: string;
  lastActivityAt: Date;
  reason: string;
};

export type SelectedRecipient = {
  phoneE164: string;
  patientId: string | null;
  patientName: string;
  priority: number;
  selectionReason: 'mandatory' | 'recent_activity' | 'affected_appointment';
  lastActivityAt: Date;
  activityType: string;
  isEligible: boolean;
};

export type NoticeSelectionResult = {
  campaignCapacity: number;
  accountAvailableCapacity: number;
  totalEligibleRecipients: number;
  totalSelectedRecipients: number;
  mandatoryIncludedCount: number;
  mandatoryAlreadyInDefaultCount: number;
  mandatoryAddedFromOutsideCount: number;
  displacedCount: number;
  ineligibleMandatoryCount: number;
  ineligibleRecipients: IneligibleRecipient[];
  displacedRecipients: DisplacedRecipient[];
  finalRecipients: SelectedRecipient[];
};

export class SelectionCapacityConflictError extends Error {
  constructor(
    public readonly eligibleMandatoryCount: number,
    public readonly effectiveCapacity: number,
  ) {
    super(
      `Cannot confirm notice campaign: distinct eligible mandatory recipients (${eligibleMandatoryCount}) exceed effective capacity (${effectiveCapacity}).`,
    );
    this.name = 'SelectionCapacityConflictError';
  }
}

/**
 * Computes deterministic recipient selection with priority displacement.
 *
 * Algorithm:
 * 1. Calculate effective capacity: min(maxCampaignCap (250), availableAccountCapacity).
 * 2. Deduplicate and normalize mandatory inputs. Validate format, consent, and opt-outs.
 * 3. Deduplicate candidate patients by normalized phoneE164.
 * 4. Separate candidates into eligible vs ineligible.
 * 5. Compute what the default selection would be without mandatory overrides (most recent + affected appointments).
 * 6. Place all eligible mandatory recipients at the top of the selection (priority 100).
 * 7. Track which mandatory recipients were already in the default top selection vs added from outside.
 * 8. Fill remaining slots with the top non-mandatory candidates.
 * 9. Identify precisely which candidates were displaced from the default top selection.
 */
export function computeNoticeSelection(params: {
  candidates: RecipientCandidate[];
  mandatory: MandatoryInput[];
  availableAccountCapacity: number;
  maxCampaignCap?: number;
}): NoticeSelectionResult {
  const maxCap = params.maxCampaignCap ?? 250;
  const effectiveCapacity = Math.max(0, Math.min(maxCap, params.availableAccountCapacity));

  // --- Step 1: Normalize & Deduplicate Mandatory Recipients ---
  const normalizedMandatoryMap = new Map<
    string,
    {
      phoneE164: string;
      patientId: string | null;
      patientName: string;
      hasConsent?: boolean;
      isOptedOut?: boolean;
    }
  >();

  const rawIneligibleMandatory: IneligibleRecipient[] = [];

  for (const m of params.mandatory) {
    const raw = m.phoneE164.trim();
    const normalized = normalizeIndianPhone(raw);
    if (!normalized) {
      rawIneligibleMandatory.push({
        phoneE164: raw,
        patientName: m.patientName,
        reason: 'invalid_phone',
      });
      continue;
    }

    if (!normalizedMandatoryMap.has(normalized)) {
      normalizedMandatoryMap.set(normalized, {
        phoneE164: normalized,
        patientId: m.patientId ?? null,
        patientName: m.patientName ?? '',
        hasConsent: m.hasConsent,
        isOptedOut: m.isOptedOut,
      });
    }
  }

  // --- Step 2: Normalize & Deduplicate Candidate Patients ---
  // In case multiple patient records share a phone, merge to the most recent activity.
  const candidateMap = new Map<string, RecipientCandidate>();
  for (const c of params.candidates) {
    const normalized = normalizeIndianPhone(c.phoneE164.trim());
    if (!normalized) continue;

    const existing = candidateMap.get(normalized);
    if (!existing) {
      candidateMap.set(normalized, { ...c, phoneE164: normalized });
    } else {
      // Keep most recent activity and positive consent if either has it
      const moreRecent =
        c.lastActivityAt.getTime() > existing.lastActivityAt.getTime() ? c : existing;
      candidateMap.set(normalized, {
        ...moreRecent,
        phoneE164: normalized,
        hasConsent: existing.hasConsent || c.hasConsent,
        isOptedOut: existing.isOptedOut || c.isOptedOut,
        hasAffectedAppointment:
          existing.hasAffectedAppointment || c.hasAffectedAppointment,
      });
    }
  }

  // --- Step 3: Evaluate Mandatory Eligibility with Candidate Data ---
  const eligibleMandatory: Array<{
    phoneE164: string;
    patientId: string | null;
    patientName: string;
    lastActivityAt: Date;
    activityType: string;
  }> = [];

  const ineligibleList: IneligibleRecipient[] = [...rawIneligibleMandatory];

  for (const [phone, m] of normalizedMandatoryMap.entries()) {
    const matchedCandidate = candidateMap.get(phone);
    const hasConsent =
      m.hasConsent !== undefined
        ? m.hasConsent
        : matchedCandidate
          ? matchedCandidate.hasConsent
          : false;
    const isOptedOut =
      m.isOptedOut !== undefined
        ? m.isOptedOut
        : matchedCandidate
          ? matchedCandidate.isOptedOut
          : false;

    if (isOptedOut) {
      ineligibleList.push({
        phoneE164: phone,
        patientName: m.patientName || matchedCandidate?.patientName,
        reason: 'opted_out',
      });
      continue;
    }

    if (!hasConsent) {
      ineligibleList.push({
        phoneE164: phone,
        patientName: m.patientName || matchedCandidate?.patientName,
        reason: 'no_consent',
      });
      continue;
    }

    const patientName =
      m.patientName || matchedCandidate?.patientName || 'Mandatory Recipient';
    const patientId = m.patientId || matchedCandidate?.patientId || null;
    const lastActivityAt = matchedCandidate?.lastActivityAt ?? new Date(0);
    const activityType = matchedCandidate?.activityType ?? 'manual_mandatory';

    eligibleMandatory.push({
      phoneE164: phone,
      patientId,
      patientName,
      lastActivityAt,
      activityType,
    });
  }

  // Reject confirmation if distinct eligible mandatory recipients exceed capacity
  if (eligibleMandatory.length > effectiveCapacity) {
    throw new SelectionCapacityConflictError(eligibleMandatory.length, effectiveCapacity);
  }

  // --- Step 4: Sort All Eligible Non-Mandatory Candidates by Priority & Recency ---
  const mandatoryPhoneSet = new Set(normalizedMandatoryMap.keys());

  const eligibleNonMandatory: RecipientCandidate[] = [];
  for (const c of candidateMap.values()) {
    if (mandatoryPhoneSet.has(c.phoneE164)) continue;
    if (c.isOptedOut || !c.hasConsent) continue;
    eligibleNonMandatory.push(c);
  }

  // Deterministic sorting:
  // 1. Affected appointment holders first
  // 2. Most recent interaction timestamp descending
  // 3. Stable tie-breaker: phoneE164 ascending
  const candidateSorter = (a: RecipientCandidate, b: RecipientCandidate): number => {
    if (Boolean(a.hasAffectedAppointment) !== Boolean(b.hasAffectedAppointment)) {
      return a.hasAffectedAppointment ? -1 : 1;
    }
    const timeDiff = b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.phoneE164.localeCompare(b.phoneE164);
  };

  eligibleNonMandatory.sort(candidateSorter);

  // --- Step 5: Calculate Default Selection (Without Mandatory Overrides) ---
  const allEligibleCandidates = Array.from(candidateMap.values()).filter(
    (c) => c.hasConsent && !c.isOptedOut,
  );
  allEligibleCandidates.sort(candidateSorter);

  const defaultTopSelection = allEligibleCandidates.slice(0, effectiveCapacity);
  const defaultTopPhoneSet = new Set(defaultTopSelection.map((c) => c.phoneE164));

  // Determine how many mandatory recipients were already in the default top
  let mandatoryAlreadyInDefaultCount = 0;
  let mandatoryAddedFromOutsideCount = 0;

  for (const em of eligibleMandatory) {
    if (defaultTopPhoneSet.has(em.phoneE164)) {
      mandatoryAlreadyInDefaultCount++;
    } else {
      mandatoryAddedFromOutsideCount++;
    }
  }

  // --- Step 6: Assemble Final Selection ---
  const remainingSlots = Math.max(0, effectiveCapacity - eligibleMandatory.length);
  const nonMandatorySelected = eligibleNonMandatory.slice(0, remainingSlots);

  const finalSelectedPhones = new Set<string>();
  const finalRecipients: SelectedRecipient[] = [];

  // 1. Mandatory recipients first (priority 100)
  for (const em of eligibleMandatory) {
    finalSelectedPhones.add(em.phoneE164);
    finalRecipients.push({
      phoneE164: em.phoneE164,
      patientId: em.patientId,
      patientName: em.patientName,
      priority: 100,
      selectionReason: 'mandatory',
      lastActivityAt: em.lastActivityAt,
      activityType: em.activityType,
      isEligible: true,
    });
  }

  // 2. Fill remaining slots with top non-mandatory candidates (priority 10)
  for (const c of nonMandatorySelected) {
    finalSelectedPhones.add(c.phoneE164);
    finalRecipients.push({
      phoneE164: c.phoneE164,
      patientId: c.patientId,
      patientName: c.patientName,
      priority: 10,
      selectionReason: c.hasAffectedAppointment
        ? 'affected_appointment'
        : 'recent_activity',
      lastActivityAt: c.lastActivityAt,
      activityType: c.activityType,
      isEligible: true,
    });
  }

  // --- Step 7: Identify Displaced Recipients ---
  // Any candidate who was in defaultTopSelection, is NOT mandatory, and is NOT in finalRecipients
  const displacedRecipients: DisplacedRecipient[] = [];
  for (const def of defaultTopSelection) {
    if (!mandatoryPhoneSet.has(def.phoneE164) && !finalSelectedPhones.has(def.phoneE164)) {
      displacedRecipients.push({
        phoneE164: def.phoneE164,
        patientId: def.patientId,
        patientName: def.patientName,
        lastActivityAt: def.lastActivityAt,
        reason: 'displaced_by_mandatory',
      });
    }
  }

  const totalEligible = allEligibleCandidates.length;

  return {
    campaignCapacity: effectiveCapacity,
    accountAvailableCapacity: params.availableAccountCapacity,
    totalEligibleRecipients: totalEligible,
    totalSelectedRecipients: finalRecipients.length,
    mandatoryIncludedCount: eligibleMandatory.length,
    mandatoryAlreadyInDefaultCount,
    mandatoryAddedFromOutsideCount,
    displacedCount: displacedRecipients.length,
    ineligibleMandatoryCount: ineligibleList.length,
    ineligibleRecipients: ineligibleList,
    displacedRecipients,
    finalRecipients,
  };
}
