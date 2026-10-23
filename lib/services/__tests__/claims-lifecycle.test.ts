import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableName } from 'drizzle-orm';
import {
  createClaimCaseInTx,
  recordClaimQueryInTx,
  replyClaimQueryInTx,
  resolveClaimQueryByInsurerInTx,
  recordClaimAuthorizationInTx,
  submitClaimPacketInTx,
  recordClaimRemittanceInTx,
  reverseClaimRemittanceInTx,
  listClaimAuthorizationsForCase,
  listClaimSubmissionsForCase,
  listClaimRemittancesForCase,
  transitionClaimStatusInTx,
  closeClaimCaseInTx,
  reopenClaimCaseInTx,
  StaleClaimVersionError,
  ClaimNotFoundError,
} from '../claims';
import { randomUUID } from 'node:crypto';

describe('Task E1.1: Claims Lifecycle & Financial Model Corrections', () => {
  const hospitalId = '11111111-1111-4111-8111-111111111111';
  const hospitalIdB = '22222222-2222-4222-8222-222222222222';
  const branchId = '33333333-3333-4333-8333-333333333333';
  const admissionId = '44444444-4444-4444-8444-444444444444';
  const encounterId = '55555555-5555-4555-8555-555555555555';
  const patientId = '66666666-6666-4666-8666-666666666666';
  const encounterPayerId = '77777777-7777-4777-8777-777777777777';
  const payerProfileId = '88888888-8888-4888-8888-888888888888';
  const actorUserId = '99999999-9999-4999-8999-999999999999';

  function safeInspect(obj: any, depth = 0): string {
    if (obj == null || depth > 10) return '';
    if (typeof obj === 'string') return obj;
    if (typeof obj === 'number') return String(obj);
    if (Array.isArray(obj)) return obj.map((x) => safeInspect(x, depth + 1)).join(' ');
    if (typeof obj === 'object') {
      const parts: string[] = [];
      if ('value' in obj) parts.push(safeInspect(obj.value, depth + 1));
      if ('queryChunks' in obj) parts.push(safeInspect(obj.queryChunks, depth + 1));
      return parts.join(' ');
    }
    return '';
  }

  function createMockStore() {
    const claims = new Map<string, any>();
    const queries = new Map<string, any>();
    const authorizations: any[] = [];
    const submissions: any[] = [];
    const remittances: any[] = [];
    const events: any[] = [];

    const tx: any = {
      select: vi.fn().mockImplementation((fields) => {
        return {
          from: vi.fn().mockImplementation((table) => {
            const tableName = table ? getTableName(table) : '';
            return {
              where: vi.fn().mockImplementation((predicate) => {
                const predStr = predicate ? safeInspect(predicate) : '';

                // Remittances rollups
                if (fields && 'totalRemitted' in fields) {
                  const rems = remittances.filter((r) => !r.voidedAt);
                  const totalRemitted = rems.reduce((sum, r) => sum + (r.amountPaise || 0), 0);
                  const totalTds = rems.reduce((sum, r) => sum + (r.tdsPaise || 0), 0);
                  const totalDeductions = rems.reduce((sum, r) => sum + (r.deductionPaise || 0), 0);
                  const totalDisputed = rems.reduce((sum, r) => sum + (r.disputedDeductionPaise || 0), 0);
                  const res = [{ totalRemitted, totalTds, totalDeductions, totalDisputed }];
                  return {
                    limit: vi.fn().mockReturnValue(res),
                    orderBy: vi.fn().mockReturnValue(res),
                    then: (resolve: any) => resolve(res),
                  };
                }

                // Submissions sequence count
                if (tableName === 'claim_submissions' && fields && 'maxSeq' in fields) {
                  const maxSeq = submissions.reduce((max, s) => Math.max(max, s.submissionNumber ?? 0), 0);
                  const res = [{ maxSeq }];
                  return {
                    limit: vi.fn().mockReturnValue(res),
                    orderBy: vi.fn().mockReturnValue(res),
                    then: (resolve: any) => resolve(res),
                  };
                }

                // Authorizations sequence count
                if (tableName === 'claim_authorizations' && fields && 'maxSeq' in fields) {
                  let filtered = authorizations;
                  if (predStr.includes('enhancement')) {
                    filtered = authorizations.filter((a) => a.authType === 'enhancement');
                  } else if (predStr.includes('initial_preauth')) {
                    filtered = authorizations.filter((a) => a.authType === 'initial_preauth');
                  }
                  const maxSeq = filtered.reduce((max, a) => Math.max(max, a.sequenceNumber ?? -1), -1);
                  const res = [{ maxSeq }];
                  return {
                    limit: vi.fn().mockReturnValue(res),
                    orderBy: vi.fn().mockReturnValue(res),
                    then: (resolve: any) => resolve(res),
                  };
                }

                // Query pending count
                if (fields && 'count' in fields) {
                  const pending = Array.from(queries.values()).filter(
                    (q) => q.status === 'pending_hospital' && !q.voidedAt
                  );
                  const res = [{ count: pending.length }];
                  return {
                    limit: vi.fn().mockReturnValue(res),
                    orderBy: vi.fn().mockReturnValue(res),
                    then: (resolve: any) => resolve(res),
                  };
                }

                // Remittances select
                if (tableName === 'claim_remittances') {
                  const remList = remittances;
                  return {
                    limit: vi.fn().mockImplementation((n) => remList.slice(0, n)),
                    orderBy: vi.fn().mockReturnValue(remList),
                    then: (resolve: any) => resolve(remList),
                  };
                }

                // Submissions select
                if (tableName === 'claim_submissions') {
                  const subList = submissions;
                  return {
                    limit: vi.fn().mockImplementation((n) => subList.slice(0, n)),
                    orderBy: vi.fn().mockReturnValue(subList),
                    then: (resolve: any) => resolve(subList),
                  };
                }

                // Authorizations select
                if (tableName === 'claim_authorizations') {
                  const authList = authorizations;
                  return {
                    limit: vi.fn().mockImplementation((n) => authList.slice(0, n)),
                    orderBy: vi.fn().mockReturnValue(authList),
                    then: (resolve: any) => resolve(authList),
                  };
                }

                // Queries select
                if (tableName === 'claim_queries') {
                  const qList = Array.from(queries.values());
                  let filtered = qList;
                  if (predStr.length > 0) {
                    filtered = qList.filter((q) => {
                      const idMatches = predStr.includes(q.id);
                      const hospMatches = !q.hospitalId || predStr.includes(q.hospitalId);
                      return idMatches && hospMatches;
                    });
                  }
                  return {
                    limit: vi.fn().mockImplementation((n) => filtered.slice(0, n)),
                    orderBy: vi.fn().mockReturnValue(filtered),
                    then: (resolve: any) => resolve(filtered),
                  };
                }

                // Default: Claims select
                const allClaims = Array.from(claims.values());
                let filteredClaims = allClaims;
                if (predStr.length > 0) {
                  filteredClaims = allClaims.filter((c) => {
                    const idMatches = predStr.includes(c.id);
                    const hospMatches = !c.hospitalId || predStr.includes(c.hospitalId);
                    return idMatches && hospMatches;
                  });
                }
                return {
                  limit: vi.fn().mockImplementation((n) => filteredClaims.slice(0, n)),
                  orderBy: vi.fn().mockReturnValue(filteredClaims),
                  then: (resolve: any) => resolve(filteredClaims),
                };
              }),
            };
          }),
        };
      }),
      insert: vi.fn().mockImplementation((table) => {
        const tableName = table ? getTableName(table) : '';
        return {
          values: vi.fn().mockImplementation((data) => {
            const row = { ...data, id: data.id || randomUUID(), version: data.version ?? 1 };
            if (tableName === 'claim_authorizations' || data.authType !== undefined) {
              authorizations.push(row);
            } else if (tableName === 'claim_submissions' || data.packetHash !== undefined) {
              submissions.push(row);
            } else if (tableName === 'claim_remittances' || data.remittanceType !== undefined) {
              remittances.push(row);
            } else if (tableName === 'claim_queries' || data.queryDescription !== undefined) {
              queries.set(row.id, row);
            } else if (tableName === 'claim_cases' || data.claimNumber !== undefined) {
              claims.set(row.id, row);
            } else if (tableName === 'claim_events' || data.eventType !== undefined) {
              events.push(row);
            }
            return {
              returning: vi.fn().mockReturnValue([row]),
              then: (resolve: any) => resolve([row]),
            };
          }),
        };
      }),
      update: vi.fn().mockImplementation((table) => {
        const tableName = table ? getTableName(table) : '';
        return {
          set: vi.fn().mockImplementation((patch) => {
            return {
              where: vi.fn().mockImplementation((predicate) => {
                const predStr = predicate ? safeInspect(predicate) : '';
                if (tableName === 'claim_queries') {
                  const target =
                    Array.from(queries.values()).find((q) => predStr.includes(q.id)) ||
                    Array.from(queries.values())[0];
                  if (target) {
                    const merged = { ...target, ...patch };
                    queries.set(target.id, merged);
                    return {
                      returning: vi.fn().mockReturnValue([merged]),
                      then: (resolve: any) => resolve([merged]),
                    };
                  }
                } else if (tableName === 'claim_remittances') {
                  const target = remittances.find((r) => predStr.includes(r.id)) || remittances[0];
                  if (target) {
                    Object.assign(target, patch);
                    return {
                      returning: vi.fn().mockReturnValue([target]),
                      then: (resolve: any) => resolve([target]),
                    };
                  }
                } else {
                  // claim_cases
                  const target =
                    Array.from(claims.values()).find((c) => predStr.includes(c.id)) ||
                    Array.from(claims.values())[0];
                  if (target) {
                    const merged = { ...target, ...patch };
                    claims.set(target.id, merged);
                    return {
                      returning: vi.fn().mockReturnValue([merged]),
                      then: (resolve: any) => resolve([merged]),
                    };
                  }
                }
                return {
                  returning: vi.fn().mockReturnValue([]),
                  then: (resolve: any) => resolve([]),
                };
              }),
            };
          }),
        };
      }),
      _claims: claims,
      _queries: queries,
      _authorizations: authorizations,
      _submissions: submissions,
      _remittances: remittances,
      _events: events,
    };

    return tx;
  }

  it('preserves interrupted stage under multiple open queries and restores status only when all queries resolve', async () => {
    const tx = createMockStore();

    // 1. Create claim case in final_submitted
    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-1',
    });

    // Manually set claim to final_submitted stage
    tx._claims.set(claim.id, {
      ...claim,
      status: 'final_submitted',
      version: 2,
    });

    // 2. Query 1 arrives during final_submitted
    const q1 = await recordClaimQueryInTx(tx, {
      claimId: claim.id,
      hospitalId,
      queryCategory: 'medical_necessity',
      queryDescription: 'Why was 5-day ICU care required?',
      slaMinutes: 120,
      deadlineType: 'hospital_response',
      actorUserId,
      clientId: 'client-q1',
    });

    let currentClaim = tx._claims.get(claim.id);
    expect(currentClaim.status).toBe('query_raised');
    expect(currentClaim.interruptedStage).toBe('final_submitted');

    // 3. Query 2 arrives while still in query_raised
    const q2 = await recordClaimQueryInTx(tx, {
      claimId: claim.id,
      hospitalId,
      queryCategory: 'line_item_breakup',
      queryDescription: 'Provide detailed pharmacy bill batch numbers',
      slaMinutes: 120,
      deadlineType: 'hospital_response',
      actorUserId,
      clientId: 'client-q2',
    });

    currentClaim = tx._claims.get(claim.id);
    // Still query_raised, and interruptedStage preserved as final_submitted
    expect(currentClaim.status).toBe('query_raised');
    expect(currentClaim.interruptedStage).toBe('final_submitted');

    // 4. Hospital replies to Query 1
    await replyClaimQueryInTx(tx, {
      queryId: q1.id,
      hospitalId,
      replyNotes: 'ICU required due to acute respiratory distress; clinical notes attached',
      actorUserId,
    });

    // Because Query 2 is still pending, claim remains in query_raised
    // In mock store, update query status for q1:
    tx._queries.set(q1.id, { ...tx._queries.get(q1.id), status: 'replied_by_hospital' });

    // 5. Hospital replies to Query 2
    tx._queries.set(q2.id, { ...tx._queries.get(q2.id), status: 'replied_by_hospital' });
    await replyClaimQueryInTx(tx, {
      queryId: q2.id,
      hospitalId,
      replyNotes: 'Itemized pharmacy batch slips provided',
      actorUserId,
    });

    currentClaim = tx._claims.get(claim.id);
    // When last query is replied, safely restores status back to final_submitted!
    expect(currentClaim.status).toBe('final_submitted');
    expect(currentClaim.interruptedStage).toBeNull();

    // 6. Insurer accepts resolution
    const resolved = await resolveClaimQueryByInsurerInTx(tx, {
      queryId: q1.id,
      hospitalId,
      status: 'resolved_accepted',
      reference: 'TPA-ACK-9921',
      notes: 'Clarification accepted',
      actorUserId,
    });
    expect(resolved.status).toBe('resolved_accepted');
  });

  it('tracks initial pre-auth and multiple sequential enhancements preserving incremental vs cumulative limits', async () => {
    const tx = createMockStore();

    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-auth-1',
    });

    tx._claims.set(claim.id, {
      ...claim,
      status: 'preauth_submitted',
      version: 1,
    });

    // 1. Initial Pre-auth: Requested cumulative ₹50,000, Approved cumulative ₹30,000
    const auth0 = await recordClaimAuthorizationInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      authType: 'initial_preauth',
      requestedCumulativePaise: 5000000,
      approvedCumulativePaise: 3000000,
      decision: 'partially_approved',
      referenceNumber: 'GOP-1001',
      decisionNotes: 'Initial GOP issued with 20% room cap deduction',
      actorUserId,
      clientId: 'auth-client-0',
    });

    expect(auth0.sequenceNumber).toBe(0);
    expect(auth0.approvedCumulativePaise).toBe(3000000);

    let currentClaim = tx._claims.get(claim.id);
    expect(currentClaim.status).toBe('preauth_approved');
    expect(currentClaim.currentAuthorizedLimitPaise).toBe(3000000);

    // 2. Enhancement 1: Requested incremental ₹25,000 (new cumulative ₹75,000). Approved incremental ₹15,000 (new cumulative ₹45,000)
    tx._claims.set(claim.id, { ...currentClaim, status: 'enhancement_requested' });

    const auth1 = await recordClaimAuthorizationInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      authType: 'enhancement',
      requestedIncrementalPaise: 2500000,
      requestedCumulativePaise: 7500000,
      approvedIncrementalPaise: 1500000,
      approvedCumulativePaise: 4500000,
      decision: 'approved',
      referenceNumber: 'GOP-1002-ENH1',
      decisionNotes: 'ICU stay extension approved',
      actorUserId,
      clientId: 'auth-client-1',
    });

    expect(auth1.sequenceNumber).toBe(0); // first enhancement
    expect(auth1.approvedIncrementalPaise).toBe(1500000);
    expect(auth1.approvedCumulativePaise).toBe(4500000);

    currentClaim = tx._claims.get(claim.id);
    expect(currentClaim.status).toBe('preauth_approved');
    expect(currentClaim.currentAuthorizedLimitPaise).toBe(4500000);

    // 3. Enhancement 2: Requested incremental ₹30,000 (cumulative ₹105,000). Rejected!
    tx._claims.set(claim.id, { ...currentClaim, status: 'enhancement_requested' });

    const auth2 = await recordClaimAuthorizationInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      authType: 'enhancement',
      requestedIncrementalPaise: 3000000,
      requestedCumulativePaise: 10500000,
      decision: 'rejected',
      referenceNumber: 'DENIAL-ENH2',
      decisionNotes: 'Policy sum insured exhausted',
      actorUserId,
      clientId: 'auth-client-2',
    });

    expect(auth2.sequenceNumber).toBe(1); // second enhancement
    expect(auth2.decision).toBe('rejected');

    currentClaim = tx._claims.get(claim.id);
    // Rejection of enhancement keeps the previous active authorized limit ₹45,000!
    expect(currentClaim.currentAuthorizedLimitPaise).toBe(4500000);
    expect(currentClaim.status).toBe('preauth_approved');
    expect(tx._authorizations.length).toBe(3);
  });

  it('creates immutable submission snapshots with verified SHA-256 content hashes and document manifests', async () => {
    const tx = createMockStore();

    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-sub-1',
    });

    tx._claims.set(claim.id, {
      ...claim,
      status: 'claim_ready',
      version: 2,
    });

    // 1. Initial submission with Document Version 1
    const sub1 = await submitClaimPacketInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      submissionStage: 'final_claim',
      channel: 'portal',
      referenceNumber: 'PORTAL-ACK-001',
      claimedAmountPaise: 8000000,
      documentsManifest: [
        { docCategory: 'discharge_summary', recordId: 'ds-1', version: 1, contentHash: 'hash-ds-v1' },
        { docCategory: 'final_itemized_bill', recordId: 'bill-1', version: 1, contentHash: 'hash-bill-v1' },
      ],
      actorUserId,
      clientId: 'sub-client-1',
    });

    expect(sub1.submissionNumber).toBe(1);
    expect(sub1.isResubmission).toBe(false);
    expect(sub1.packetHash).toBeDefined();
    expect(sub1.snapshotPayload).toBeDefined();

    let currentClaim = tx._claims.get(claim.id);
    expect(currentClaim.status).toBe('final_submitted');
    expect(currentClaim.claimedAmountPaise).toBe(8000000);

    // 2. Resubmission with amended bill Version 2
    tx._claims.set(claim.id, { ...currentClaim, status: 'claim_ready', version: 3 });

    const sub2 = await submitClaimPacketInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      submissionStage: 'final_claim',
      channel: 'portal',
      referenceNumber: 'PORTAL-ACK-002-RESUB',
      claimedAmountPaise: 8500000,
      documentsManifest: [
        { docCategory: 'discharge_summary', recordId: 'ds-1', version: 1, contentHash: 'hash-ds-v1' },
        { docCategory: 'final_itemized_bill', recordId: 'bill-1', version: 2, contentHash: 'hash-bill-v2' },
      ],
      actorUserId,
      clientId: 'sub-client-2',
    });

    expect(sub2.submissionNumber).toBe(2);
    expect(sub2.isResubmission).toBe(true);
    expect(sub2.packetHash).not.toBe(sub1.packetHash); // Distinct cryptographic hash per packet!
    expect(tx._submissions.length).toBe(2);
  });

  it('records multi-receipt remittances against one claim and separates operational workflow from financial settlement', async () => {
    const tx = createMockStore();

    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-rem-1',
    });

    // Claim is in final_submitted awaiting adjudication
    tx._claims.set(claim.id, {
      ...claim,
      status: 'final_submitted',
      claimedAmountPaise: 10000000, // ₹100,000 claimed
      adjudicatedPayablePaise: 8000000, // ₹80,000 net approved by insurer
      version: 5,
    });

    // 1. First remittance arrives: Tranche 1 of ₹50,000 via NEFT
    const rem1 = await recordClaimRemittanceInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      remittanceType: 'payment',
      paymentMethod: 'neft',
      payerReference: 'NEFT-TR-001',
      amountPaise: 5000000, // ₹50,000
      tdsPaise: 500000, // ₹5,000 TDS withheld
      deductionPaise: 1000000, // ₹10,000 deduction
      coPayPaise: 1000000, // ₹10,000 copay
      adjudicatedPayablePaise: 8000000,
      actorUserId,
      clientId: 'rem-client-1',
    });

    expect(rem1.amountPaise).toBe(5000000);

    let currentClaim = tx._claims.get(claim.id);
    // Operational status MUST NOT be overwritten or frozen; it stays final_submitted!
    expect(currentClaim.status).toBe('final_submitted');
    // Financial settlementStatus is partially_settled
    expect(currentClaim.settlementStatus).toBe('partially_settled');
    expect(currentClaim.totalRemittedPaise).toBe(5000000);

    // 2. Second remittance arrives: Tranche 2 of balance ₹30,000 via RTGS
    const rem2 = await recordClaimRemittanceInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      remittanceType: 'payment',
      paymentMethod: 'rtgs',
      payerReference: 'RTGS-TR-002',
      amountPaise: 3000000, // ₹30,000
      tdsPaise: 300000,
      adjudicatedPayablePaise: 8000000,
      actorUserId,
      clientId: 'rem-client-2',
    });

    currentClaim = tx._claims.get(claim.id);
    // Total remitted is now ₹80,000, which satisfies the adjudicated liability!
    expect(currentClaim.totalRemittedPaise).toBe(8000000);
    expect(currentClaim.settlementStatus).toBe('settled');
    expect(tx._remittances.length).toBe(2);
  });

  it('supports disputed deductions and controlled audited reversals without untracked overwrites', async () => {
    const tx = createMockStore();

    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-rev-1',
    });

    tx._claims.set(claim.id, {
      ...claim,
      status: 'final_submitted',
      version: 3,
    });

    // 1. Initial settlement with ₹20,000 disputed deduction
    const rem1 = await recordClaimRemittanceInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      remittanceType: 'payment',
      paymentMethod: 'neft',
      payerReference: 'NEFT-DISPUTE-01',
      amountPaise: 6000000,
      deductionPaise: 2000000,
      disputedDeductionPaise: 2000000,
      adjudicatedPayablePaise: 8000000,
      notes: '₹20,000 deducted under investigation clause; hospital disputed',
      actorUserId,
      clientId: 'rem-disp-1',
    });

    let currentClaim = tx._claims.get(claim.id);
    expect(currentClaim.settlementStatus).toBe('partially_settled');
    expect(currentClaim.totalDisputedPaise).toBe(2000000);

    // 2. Controlled reversal of erroneous payment record
    const rev = await reverseClaimRemittanceInTx(tx, {
      hospitalId,
      originalRemittanceId: rem1.id,
      reversalReason: 'Duplicate bank entry entered by coordinator',
      actorUserId,
      clientId: 'rev-client-1',
    });

    expect(rev.amountPaise).toBe(-6000000); // Linked negative entry
    expect(rev.reversalOfRemittanceId).toBe(rem1.id);
    expect(rev.reversalReason).toBe('Duplicate bank entry entered by coordinator');

    currentClaim = tx._claims.get(claim.id);
    // After reversal, remitted balance is correctly zeroed without untracked updates
    expect(currentClaim.totalRemittedPaise).toBe(0);
    expect(currentClaim.settlementStatus).toBe('unsettled');
    expect(tx._remittances.length).toBe(2);
  });

  it('rejects concurrent update conflict on status transition with StaleClaimVersionError', async () => {
    const tx = createMockStore();

    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-ver-1',
    });

    // Version in db is 1
    // Another worker updates claim bumping version to 2
    tx._claims.set(claim.id, {
      ...tx._claims.get(claim.id),
      version: 2,
    });

    await expect(
      transitionClaimStatusInTx(tx, {
        claimId: claim.id,
        hospitalId,
        expectedVersion: 1, // Stale!
        targetStatus: 'preauth_submitted',
        submissionDetails: { sentAt: new Date(), channel: 'portal', reference: 'REF-001' },
        actorUserId,
        clientId: 'c-ver-2',
      })
    ).rejects.toThrow(StaleClaimVersionError);
  });

  it('enforces cross-tenant isolation: Hospital A cannot access or manipulate claims belonging to Hospital B', async () => {
    const tx = createMockStore();

    // Claim belongs to Hospital B
    const claimB = await createClaimCaseInTx(tx, {
      hospitalId: hospitalIdB,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-hosp-b',
    });

    // Hospital A actor attempts to record an authorization on Hospital B's claim
    await expect(
      recordClaimAuthorizationInTx(tx, {
        hospitalId: hospitalId, // Hospital A context!
        claimCaseId: claimB.id,
        authType: 'initial_preauth',
        requestedCumulativePaise: 5000000,
        approvedCumulativePaise: 5000000,
        decision: 'approved',
        actorUserId,
        clientId: 'cross-tenant-1',
      })
    ).rejects.toThrow(ClaimNotFoundError);

    // Hospital A actor attempts to record a remittance on Hospital B's claim
    await expect(
      recordClaimRemittanceInTx(tx, {
        hospitalId: hospitalId, // Hospital A context!
        claimCaseId: claimB.id,
        remittanceType: 'payment',
        paymentMethod: 'neft',
        amountPaise: 5000000,
        adjudicatedPayablePaise: 5000000,
        actorUserId,
        clientId: 'cross-tenant-2',
      })
    ).rejects.toThrow(ClaimNotFoundError);
  });

  it('supports closing settled claims and controlled reopening with audited justification', async () => {
    const tx = createMockStore();

    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-close-1',
    });

    // Move claim to settled stage
    tx._claims.set(claim.id, {
      ...tx._claims.get(claim.id),
      status: 'settled',
      settlementStatus: 'settled',
      version: 2,
    });

    // 1. Close the settled claim
    const closed = await closeClaimCaseInTx(tx, {
      claimId: claim.id,
      hospitalId,
      expectedVersion: 2,
      notes: 'Final bank reconciliation verified against EOB',
      actorUserId,
      clientId: 'c-close-action',
    });

    expect(closed.status).toBe('closed_settled');

    // 2. Attempting to reopen without justification throws
    await expect(
      reopenClaimCaseInTx(tx, {
        claimId: claim.id,
        hospitalId,
        expectedVersion: 3,
        reopenReason: '', // Empty reason!
        actorUserId,
        clientId: 'c-reopen-empty',
      })
    ).rejects.toThrow(/reopenReason is required/i);

    // 3. Controlled reopening with valid reason succeeds and logs audit event
    const reopened = await reopenClaimCaseInTx(tx, {
      claimId: claim.id,
      hospitalId,
      expectedVersion: 3,
      reopenReason: 'Insurer issued supplementary payment cheque for room rent appeal',
      targetStatus: 'settled',
      actorUserId,
      clientId: 'c-reopen-valid',
    });

    expect(reopened.status).toBe('settled');

    // Event log verification
    const reopenEvent = tx._events.find((e: any) => e.eventType === 'reopened');
    expect(reopenEvent).toBeDefined();
    expect(reopenEvent.notes).toContain('supplementary payment cheque');
  });

  it('clears legacyReconciliationRequired flag upon recording first verified remittance', async () => {
    const tx = createMockStore();

    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-legacy-1',
    });

    // Simulate 0066 legacy backfilled claim flagged for reconciliation
    tx._claims.set(claim.id, {
      ...tx._claims.get(claim.id),
      settlementStatus: 'legacy_reconciliation_required',
      legacyReconciliationRequired: true,
      settledAmountPaise: 4000000, // Legacy unverified ₹40,000
      totalRemittedPaise: 0,
      version: 2,
    });

    // Record verified remittance from bank UTR advice
    await recordClaimRemittanceInTx(tx, {
      hospitalId,
      claimCaseId: claim.id,
      remittanceType: 'payment',
      paymentMethod: 'neft',
      payerReference: 'UTR-VERIFIED-991',
      amountPaise: 3600000, // ₹36,000 net bank credit
      tdsPaise: 400000,     // ₹4,000 TDS (Section 194J)
      adjudicatedPayablePaise: 4000000, // ₹40,000 gross liability
      actorUserId,
      clientId: 'rem-verified-1',
    });

    const reconciled = tx._claims.get(claim.id);
    expect(reconciled.legacyReconciliationRequired).toBe(false);
    expect(reconciled.settlementStatus).toBe('settled');
    expect(reconciled.totalRemittedPaise).toBe(3600000);
    expect(reconciled.totalTdsWithheldPaise).toBe(400000);
  });

  it('distinguishes insurer response SLA countdowns from internal hospital task deadlines', async () => {
    const tx = createMockStore();

    const claim = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      actorUserId,
      clientId: 'c-deadline-1',
    });

    // 1. Submit pre-auth: sets preauthSlaDeadline (insurer countdown, e.g. 360 mins)
    const sentAt = new Date('2026-10-22T10:00:00.000Z');
    await transitionClaimStatusInTx(tx, {
      claimId: claim.id,
      hospitalId,
      expectedVersion: 1,
      targetStatus: 'preauth_submitted',
      submissionDetails: {
        sentAt,
        channel: 'portal',
        reference: 'TPA-PREAUTH-101',
      },
      actorUserId,
      clientId: 'sub-details-1',
    });

    let current = tx._claims.get(claim.id);
    // Insurer deadline: 360 minutes from submission
    expect(current.preauthSlaDeadline).toEqual(new Date('2026-10-22T16:00:00.000Z'));

    // 2. Query received: sets hospital response task deadline (hospital task, e.g. 120 mins)
    const query = await recordClaimQueryInTx(tx, {
      claimId: claim.id,
      hospitalId,
      queryCategory: 'deficiency',
      queryDescription: 'Provide signed patient declaration form',
      slaMinutes: 120,
      deadlineType: 'hospital_response',
      actorUserId,
      clientId: 'q-task-1',
    });

    expect(query.deadlineType).toBe('hospital_response');
    current = tx._claims.get(claim.id);
    expect(current.hospitalInternalDeadline).toBeDefined();
    // Hospital deadline is 120 mins from query receipt
    expect(current.hospitalInternalDeadline!.getTime() - Date.now()).toBeLessThanOrEqual(120 * 60 * 1000 + 5000);
  });
});

