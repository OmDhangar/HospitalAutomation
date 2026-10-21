import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createClaimCaseInTx,
  transitionClaimStatusInTx,
  recordClaimQueryInTx,
  replyClaimQueryInTx,
  recordClaimSettlementInTx,
  decryptClaimPolicyNumber,
  StaleClaimVersionError,
  ClaimNotFoundError,
} from '../claims';
import { ClaimsDecryptionError } from '@/lib/security/claims-encryption';

describe('Claims Core Service Operations', () => {
  const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const TEST_SALT = 'fedcba9876543210fedcba9876543210';
  const hospitalId = 'h-1';
  const branchId = 'b-1';
  const admissionId = 'a-1';
  const encounterId = 'e-1';
  const patientId = 'p-1';
  const encounterPayerId = 'ep-1';
  const payerProfileId = 'pp-1';
  const actorUserId = 'u-1';

  beforeEach(() => {
    process.env.CLAIMS_ENCRYPTION_KEY = TEST_KEY;
    process.env.CLAIMS_BLIND_INDEX_SALT = TEST_SALT;
  });

  // Mock transaction builder helper
  function createMockTx(initialClaim?: any) {
    let storedClaim = initialClaim ? { ...initialClaim } : null;
    const events: any[] = [];
    const queries: any[] = [];
    const accessLogs: any[] = [];

    const tx: any = {
      select: vi.fn().mockImplementation((fields) => {
        return {
          from: vi.fn().mockImplementation((table) => {
            return {
              where: vi.fn().mockImplementation(() => {
                return {
                  limit: vi.fn().mockImplementation(() => (storedClaim ? [storedClaim] : [])),
                  orderBy: vi.fn().mockReturnValue(storedClaim ? [storedClaim] : []),
                  then: (resolve: any) => resolve(storedClaim ? [storedClaim] : []),
                };
              }),
            };
          }),
        };
      }),
      insert: vi.fn().mockImplementation((table) => {
        return {
          values: vi.fn().mockImplementation((data) => {
            if (data.status && data.admissionId) {
              storedClaim = { ...data, id: data.id || 'claim-1' };
              return {
                returning: vi.fn().mockReturnValue([storedClaim]),
                then: (resolve: any) => resolve([storedClaim]),
              };
            }
            if (data.eventType) {
              events.push(data);
              return { then: (resolve: any) => resolve([data]) };
            }
            if (data.queryDescription) {
              queries.push(data);
              return {
                returning: vi.fn().mockReturnValue([data]),
                then: (resolve: any) => resolve([data]),
              };
            }
            if (data.action) {
              accessLogs.push(data);
              return { then: (resolve: any) => resolve([data]) };
            }
            return { then: (resolve: any) => resolve([data]) };
          }),
        };
      }),
      update: vi.fn().mockImplementation((table) => {
        return {
          set: vi.fn().mockImplementation((patch) => {
            return {
              where: vi.fn().mockImplementation(() => {
                if (storedClaim) {
                  storedClaim = { ...storedClaim, ...patch };
                }
                return {
                  returning: vi.fn().mockReturnValue([storedClaim]),
                  then: (resolve: any) => resolve([storedClaim]),
                };
              }),
            };
          }),
        };
      }),
      _getStoredClaim: () => storedClaim,
      _getEvents: () => events,
      _getQueries: () => queries,
      _getAccessLogs: () => accessLogs,
    };

    return tx;
  }

  it('creates claim case with AAD encrypted policy number and initial event', async () => {
    const tx = createMockTx();
    const result = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      claimType: 'cashless',
      rawPolicyNumber: 'STAR-POL-445566',
      estimatedCostPaise: 2500000,
      actorUserId,
      clientId: 'client-1',
    });

    expect(result).toBeDefined();
    expect(result.status).toBe('draft');
    expect(result.version).toBe(1);
    expect(result.policyNumberMasked).toBe('•••• 5566');
    expect(result.policyNumberBidx).toBeDefined();
    expect(result.policyNumberCiphertext).toBeDefined();

    const events = tx._getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('created');
    expect(events[0].newStatus).toBe('draft');
  });

  it('transitions claim status and increments version with optimistic locking', async () => {
    const tx = createMockTx({
      id: 'claim-1',
      hospitalId,
      admissionId,
      status: 'draft',
      version: 1,
    });

    const updated = await transitionClaimStatusInTx(tx, {
      claimId: 'claim-1',
      hospitalId,
      expectedVersion: 1,
      targetStatus: 'preauth_submitted',
      submissionDetails: { sentAt: new Date(), channel: 'portal', reference: 'ACK-999' },
      actorUserId,
      clientId: 'client-2',
    });

    expect(updated.status).toBe('preauth_submitted');
    expect(updated.version).toBe(2);

    const events = tx._getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('preauth_submitted');
    expect(events[0].previousStatus).toBe('draft');
    expect(events[0].newStatus).toBe('preauth_submitted');
  });

  it('throws StaleClaimVersionError when expectedVersion does not match current version', async () => {
    const tx = createMockTx({
      id: 'claim-1',
      hospitalId,
      status: 'draft',
      version: 2, // version already bumped
    });

    await expect(
      transitionClaimStatusInTx(tx, {
        claimId: 'claim-1',
        hospitalId,
        expectedVersion: 1, // outdated version
        targetStatus: 'preauth_submitted',
        submissionDetails: { sentAt: new Date(), channel: 'portal', reference: 'ACK-999' },
        actorUserId,
        clientId: 'client-3',
      })
    ).rejects.toThrow(StaleClaimVersionError);
  });

  it('records a query, calculates SLA deadline, and transitions to query_raised', async () => {
    const tx = createMockTx({
      id: 'claim-1',
      hospitalId,
      status: 'preauth_submitted',
      version: 2,
    });

    const query = await recordClaimQueryInTx(tx, {
      claimId: 'claim-1',
      hospitalId,
      queryCategory: 'medical_necessity',
      queryDescription: 'Please provide admission clinical notes and pre-existing disease history',
      slaMinutes: 120, // 2 hours
      actorUserId,
      clientId: 'client-4',
    });

    expect(query).toBeDefined();
    expect(query.status).toBe('pending_hospital');
    expect(query.slaDeadlineAt).toBeDefined();

    const stored = tx._getStoredClaim();
    expect(stored.status).toBe('query_raised');
    expect(stored.version).toBe(3);
  });

  it('records settlement, links discharge bill, and marks terminal state', async () => {
    const tx = createMockTx({
      id: 'claim-1',
      hospitalId,
      status: 'final_submitted',
      version: 4,
    });

    const settled = await recordClaimSettlementInTx(tx, {
      claimId: 'claim-1',
      hospitalId,
      expectedVersion: 4,
      settledAmountPaise: 4000000,
      deductionAmountPaise: 500000,
      coPayAmountPaise: 500000,
      dischargeBillId: 'bill-1',
      actorUserId,
      clientId: 'client-5',
    });

    expect(settled.status).toBe('partially_settled');
    expect(settled.settledAmountPaise).toBe(4000000);
    expect(settled.deductionAmountPaise).toBe(500000);
    expect(settled.dischargeBillId).toBe('bill-1');
  });

  it('decrypts policy number cleanly and logs access audit record', async () => {
    const tx = createMockTx();
    const created = await createClaimCaseInTx(tx, {
      hospitalId,
      branchId,
      admissionId,
      encounterId,
      patientId,
      encounterPayerId,
      payerProfileId,
      claimType: 'cashless',
      rawPolicyNumber: 'STAR-SECRET-7788',
      actorUserId,
      clientId: 'client-6',
    });

    const decrypted = await decryptClaimPolicyNumber(tx, {
      claim: created,
      actorUserId,
      patientId,
      encounterId,
    });

    expect(decrypted).toBe('STAR-SECRET-7788');
    const logs = tx._getAccessLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('decrypt_claim_identifier');
  });
});
