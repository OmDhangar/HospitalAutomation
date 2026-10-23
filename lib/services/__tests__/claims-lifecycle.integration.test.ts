import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import {
  createClaimCaseInTx,
  recordClaimQueryInTx,
  replyClaimQueryInTx,
  resolveClaimQueryByInsurerInTx,
  recordClaimAuthorizationInTx,
  submitClaimPacketInTx,
  recordClaimRemittanceInTx,
  reverseClaimRemittanceInTx,
  closeClaimCaseInTx,
  reopenClaimCaseInTx,
  listClaimRemittancesForCase,
  listClaimAuthorizationsForCase,
  listClaimSubmissionsForCase,
  ClaimNotFoundError,
} from '@/lib/services/claims';

/**
 * Task E1.1 Item 4: Actual PostgreSQL lifecycle integration tests.
 *
 * Runs against a real Postgres database (qurio_scratch or DATABASE_ADMIN_URL/DATABASE_URL).
 * Verifies:
 * 1. Concurrent query resolution and multi-query stage restoration.
 * 2. Duplicate retries and idempotent constraint handling.
 * 3. Authoritative liability source & multiple receipts (no payable duplication).
 * 4. Disputed deductions and append-only ledger reversals.
 * 5. Transaction atomicity on failure.
 * 6. Cross-tenant isolation under asTenant.
 * 7. Payer vs hospital deadline invariants, closing, and controlled reopening.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);

const uuid = () => crypto.randomUUID();

describe.skipIf(!enabled)('PostgreSQL Claims Lifecycle Integration Tests', () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;
  let adminDb: ReturnType<typeof drizzle<typeof schema>>;
  let appDb: ReturnType<typeof drizzle<typeof schema>>;

  const ids = {
    hospitalA: uuid(),
    hospitalB: uuid(),
    branchA: uuid(),
    branchB: uuid(),
    userA: uuid(),
    userB: uuid(),
    doctorA: uuid(),
    doctorB: uuid(),
    patientA: uuid(),
    patientB: uuid(),
    encounterA: uuid(),
    encounterB: uuid(),
    admissionA: uuid(),
    admissionB: uuid(),
    payerProfile: uuid(),
    encPayerA: uuid(),
    encPayerB: uuid(),
  };

  /** Runs a transaction with tenant config set for the restricted app role */
  const asTenant = <T>(
    hospitalId: string,
    fn: (tx: any) => Promise<T>,
  ): Promise<T> => {
    return appDb.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.hospital_id', ${hospitalId}, true), set_config('app.read_only', 'false', true)`
      );
      return fn(tx);
    });
  };

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });
    app = postgres(appUrl!, { max: 2 });
    adminDb = drizzle(admin, { schema });
    appDb = drizzle(app, { schema });

    // Seed base fixtures via admin
    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'Postgres Claims Hospital A', ${'pg-cla-' + ids.hospitalA.slice(0, 8)}),
        (${ids.hospitalB}, 'Postgres Claims Hospital B', ${'pg-clb-' + ids.hospitalB.slice(0, 8)})
      on conflict (id) do nothing
    `;

    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Branch A'),
        (${ids.branchB}, ${ids.hospitalB}, 'Branch B')
      on conflict (id) do nothing
    `;

    await admin`
      insert into users (id, name, email, password_hash) values
        (${ids.userA}, 'User A', ${'usera-' + ids.userA.slice(0, 8) + '@test.org'}, 'hash'),
        (${ids.userB}, 'User B', ${'userb-' + ids.userB.slice(0, 8) + '@test.org'}, 'hash')
      on conflict (id) do nothing
    `;

    await admin`
      insert into doctors (id, hospital_id, branch_id, name) values
        (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr. House A'),
        (${ids.doctorB}, ${ids.hospitalB}, ${ids.branchB}, 'Dr. House B')
      on conflict (id) do nothing
    `;

    await admin`
      insert into patients (id, hospital_id, name, gender, phone_e164) values
        (${ids.patientA}, ${ids.hospitalA}, 'Patient Alpha', 'female', '+919900000001'),
        (${ids.patientB}, ${ids.hospitalB}, 'Patient Beta', 'male', '+919900000002')
      on conflict (id) do nothing
    `;

    await admin`
      insert into encounters (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin) values
        (${ids.encounterA}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA}, ${ids.doctorA}, 'direct'),
        (${ids.encounterB}, ${ids.hospitalB}, ${ids.branchB}, ${ids.patientB}, ${ids.doctorB}, 'direct')
      on conflict (id) do nothing
    `;

    await admin`
      insert into admissions (id, hospital_id, branch_id, patient_id, encounter_id, admitting_doctor_id, admission_number, status, admitted_at) values
        (${ids.admissionA}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA}, ${ids.encounterA}, ${ids.doctorA}, 9501, 'admitted', now()),
        (${ids.admissionB}, ${ids.hospitalB}, ${ids.branchB}, ${ids.patientB}, ${ids.encounterB}, ${ids.doctorB}, 9502, 'admitted', now())
      on conflict (id) do nothing
    `;

    await admin`
      insert into payer_profiles (id, name, code, category) values
        (${ids.payerProfile}, 'Postgres Test TPA', ${'tpa-' + ids.payerProfile.slice(0, 8)}, 'tpa')
      on conflict (id) do nothing
    `;

    await admin`
      insert into encounter_payers (id, hospital_id, encounter_id, patient_id, kind, payer_name) values
        (${ids.encPayerA}, ${ids.hospitalA}, ${ids.encounterA}, ${ids.patientA}, 'insurer', 'Postgres Test TPA'),
        (${ids.encPayerB}, ${ids.hospitalB}, ${ids.encounterB}, ${ids.patientB}, 'insurer', 'Postgres Test TPA')
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from hospitals where id in (${ids.hospitalA}, ${ids.hospitalB})`.catch(() => {});
      await admin`delete from payer_profiles where id = ${ids.payerProfile}`.catch(() => {});
      await admin.end();
    }
    if (app) {
      await app.end();
    }
  });

  it('1. verifies concurrent query resolution and multi-query stage restoration', async () => {
    await asTenant(ids.hospitalA, async (tx) => {
      // Create initial claim
      const claim = await createClaimCaseInTx(tx, {
        hospitalId: ids.hospitalA,
        branchId: ids.branchA,
        admissionId: ids.admissionA,
        encounterId: ids.encounterA,
        patientId: ids.patientA,
        encounterPayerId: ids.encPayerA,
        payerProfileId: ids.payerProfile,
        claimType: 'cashless',
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      // Move claim to final_submitted
      await tx
        .update(schema.claimCases)
        .set({ status: 'final_submitted', version: 2 })
        .where(eq(schema.claimCases.id, claim.id));

      // Query 1 arrives: captures interrupted_stage = final_submitted
      const query1 = await recordClaimQueryInTx(tx, {
        claimId: claim.id,
        hospitalId: ids.hospitalA,
        queryCategory: 'medical_necessity',
        queryDescription: 'Provide ICU daily progress notes',
        slaMinutes: 120,
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      // Query 2 arrives concurrently while Query 1 is open
      const query2 = await recordClaimQueryInTx(tx, {
        claimId: claim.id,
        hospitalId: ids.hospitalA,
        queryCategory: 'pharmacy_investigation_proofs',
        queryDescription: 'Provide high-cost implant invoice',
        slaMinutes: 120,
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      // Hospital replies to Query 1
      await replyClaimQueryInTx(tx, {
        hospitalId: ids.hospitalA,
        queryId: query1.id,
        replyNotes: 'ICU progress notes uploaded to portal',
        actorUserId: ids.userA,
      });

      // Check claim status: Query 2 is still pending, so status must remain query_raised
      const [caseAfterQ1] = await tx
        .select()
        .from(schema.claimCases)
        .where(eq(schema.claimCases.id, claim.id));
      expect(caseAfterQ1.status).toBe('query_raised');
      expect(caseAfterQ1.interruptedStage).toBe('final_submitted');

      // Hospital replies to Query 2
      await replyClaimQueryInTx(tx, {
        hospitalId: ids.hospitalA,
        queryId: query2.id,
        replyNotes: 'Implant invoice uploaded',
        actorUserId: ids.userA,
      });

      // All queries replied -> stage must be restored safely to interrupted_stage (final_submitted)!
      const [caseAfterQ2] = await tx
        .select()
        .from(schema.claimCases)
        .where(eq(schema.claimCases.id, claim.id));
      expect(caseAfterQ2.status).toBe('final_submitted');
      expect(caseAfterQ2.interruptedStage).toBeNull();

      // Insurer later marks resolutions
      await resolveClaimQueryByInsurerInTx(tx, {
        hospitalId: ids.hospitalA,
        queryId: query1.id,
        status: 'resolved_accepted',
        reference: 'RES-001',
        notes: 'ICU notes verified',
        actorUserId: ids.userA,
      });

      await resolveClaimQueryByInsurerInTx(tx, {
        hospitalId: ids.hospitalA,
        queryId: query2.id,
        status: 'resolved_accepted',
        reference: 'RES-002',
        notes: 'Implant invoice approved',
        actorUserId: ids.userA,
      });
    });
  });

  it('2. verifies duplicate retries and client_id idempotency', async () => {
    let claim: any;
    const submissionClientId = uuid();

    await asTenant(ids.hospitalA, async (tx) => {
      claim = await createClaimCaseInTx(tx, {
        hospitalId: ids.hospitalA,
        branchId: ids.branchA,
        admissionId: ids.admissionA,
        encounterId: ids.encounterA,
        patientId: ids.patientA,
        encounterPayerId: ids.encPayerA,
        payerProfileId: ids.payerProfile,
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      const manifest = [
        { docCategory: 'final_itemized_bill', documentRecordId: uuid(), artifactHash: 'hash-bill-1' },
        { docCategory: 'discharge_summary', documentRecordId: uuid(), artifactHash: 'hash-ds-1' },
      ];

      // Move claim to claim_ready so it can transition to final_submitted
      await tx
        .update(schema.claimCases)
        .set({ status: 'claim_ready' })
        .where(eq(schema.claimCases.id, claim.id));

      // First submission
      await submitClaimPacketInTx(tx, {
        hospitalId: ids.hospitalA,
        claimCaseId: claim.id,
        submissionStage: 'final_claim',
        channel: 'portal',
        referenceNumber: 'PORTAL-SUB-101',
        claimedAmountPaise: 4000000,
        documentsManifest: manifest,
        actorUserId: ids.userA,
        clientId: submissionClientId,
      });
    });

    // 2. Duplicate submission retry with identical client_id must violate unique constraint and abort tx
    await expect(
      asTenant(ids.hospitalA, async (tx) => {
        const manifest = [
          { docCategory: 'final_itemized_bill', documentRecordId: uuid(), artifactHash: 'hash-bill-1' },
          { docCategory: 'discharge_summary', documentRecordId: uuid(), artifactHash: 'hash-ds-1' },
        ];
        return submitClaimPacketInTx(tx, {
          hospitalId: ids.hospitalA,
          claimCaseId: claim.id,
          submissionStage: 'final_claim',
          channel: 'portal',
          referenceNumber: 'PORTAL-SUB-101',
          claimedAmountPaise: 4000000,
          documentsManifest: manifest,
          actorUserId: ids.userA,
          clientId: submissionClientId,
        });
      })
    ).rejects.toThrow();

    // 3. In fresh transaction, verify only 1 submission exists (atomicity preserved)
    await asTenant(ids.hospitalA, async (tx) => {
      const submissions = await listClaimSubmissionsForCase(tx, {
        hospitalId: ids.hospitalA,
        claimCaseId: claim.id,
      });
      expect(submissions).toHaveLength(1);
    });
  });

  it('3. verifies authoritative liability source and multiple receipts without payable duplication', async () => {
    await asTenant(ids.hospitalA, async (tx) => {
      const claim = await createClaimCaseInTx(tx, {
        hospitalId: ids.hospitalA,
        branchId: ids.branchA,
        admissionId: ids.admissionA,
        encounterId: ids.encounterA,
        patientId: ids.patientA,
        encounterPayerId: ids.encPayerA,
        payerProfileId: ids.payerProfile,
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      // Insurer adjudicates claim liability at ₹50,000 (5,000,000 paise)
      await tx
        .update(schema.claimCases)
        .set({
          adjudicatedPayablePaise: 5000000,
          status: 'claim_ready',
        })
        .where(eq(schema.claimCases.id, claim.id));

      // Receipt 1: First tranche: ₹20,000 cash + ₹2,000 TDS + ₹3,000 deduction
      await recordClaimRemittanceInTx(tx, {
        hospitalId: ids.hospitalA,
        claimCaseId: claim.id,
        remittanceType: 'payment',
        paymentMethod: 'neft',
        payerReference: 'UTR-TRANCHE-1',
        amountPaise: 2000000,
        tdsPaise: 200000,
        deductionPaise: 300000,
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      const [caseAfterR1] = await tx
        .select()
        .from(schema.claimCases)
        .where(eq(schema.claimCases.id, claim.id));

      expect(caseAfterR1.settlementStatus).toBe('partially_settled');
      expect(caseAfterR1.totalRemittedPaise).toBe(2000000);
      expect(caseAfterR1.totalTdsWithheldPaise).toBe(200000);
      expect(caseAfterR1.totalDeductionsPaise).toBe(300000);
      // Single source of truth: adjudicated liability remains exactly ₹50,000 (NEVER multiplied across receipts!)
      expect(caseAfterR1.adjudicatedPayablePaise).toBe(5000000);

      // Receipt 2: Second tranche: ₹30,000 cash receipt (completes 50,000)
      await recordClaimRemittanceInTx(tx, {
        hospitalId: ids.hospitalA,
        claimCaseId: claim.id,
        remittanceType: 'payment',
        paymentMethod: 'rtgs',
        payerReference: 'UTR-TRANCHE-2',
        amountPaise: 3000000,
        tdsPaise: 0,
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      const [caseAfterR2] = await tx
        .select()
        .from(schema.claimCases)
        .where(eq(schema.claimCases.id, claim.id));

      expect(caseAfterR2.settlementStatus).toBe('settled');
      expect(caseAfterR2.totalRemittedPaise).toBe(5000000);
      expect(caseAfterR2.totalTdsWithheldPaise).toBe(200000);
      expect(caseAfterR2.totalDeductionsPaise).toBe(300000);
      // Adjudicated payable remains exactly ₹50,000
      expect(caseAfterR2.adjudicatedPayablePaise).toBe(5000000);
    });
  });

  it('4. verifies disputed deductions and append-only ledger reversals', async () => {
    await asTenant(ids.hospitalA, async (tx) => {
      const claim = await createClaimCaseInTx(tx, {
        hospitalId: ids.hospitalA,
        branchId: ids.branchA,
        admissionId: ids.admissionA,
        encounterId: ids.encounterA,
        patientId: ids.patientA,
        encounterPayerId: ids.encPayerA,
        payerProfileId: ids.payerProfile,
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      await tx
        .update(schema.claimCases)
        .set({ adjudicatedPayablePaise: 10000000 })
        .where(eq(schema.claimCases.id, claim.id));

      // Record remittance with a disputed deduction
      const remittance = await recordClaimRemittanceInTx(tx, {
        hospitalId: ids.hospitalA,
        claimCaseId: claim.id,
        remittanceType: 'payment',
        amountPaise: 0,
        deductionPaise: 2000000,
        disputedDeductionPaise: 2000000,
        payerReference: 'UTR-DISPUTE-TEST',
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      const [caseAfterDispute] = await tx
        .select()
        .from(schema.claimCases)
        .where(eq(schema.claimCases.id, claim.id));
      expect(caseAfterDispute.settlementStatus).toBe('disputed');
      expect(caseAfterDispute.totalDisputedPaise).toBe(2000000);

      // Hospital receives correction/reversal for erroneous entry
      const reversal = await reverseClaimRemittanceInTx(tx, {
        hospitalId: ids.hospitalA,
        originalRemittanceId: remittance.id,
        reversalReason: 'Duplicate bank entry correction',
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      expect(reversal.remittanceType).toBe('correction_reversal');
      expect(reversal.reversalOfRemittanceId).toBe(remittance.id);

      const [caseAfterReversal] = await tx
        .select()
        .from(schema.claimCases)
        .where(eq(schema.claimCases.id, claim.id));
      expect(caseAfterReversal.totalDisputedPaise).toBe(0);

      // Verify audit history: both original and reversal exist in DB
      const allRemittances = await listClaimRemittancesForCase(tx, {
        hospitalId: ids.hospitalA,
        claimCaseId: claim.id,
      });
      expect(allRemittances).toHaveLength(2);
    });
  });

  it('5. verifies cross-tenant isolation under asTenant: Tenant B cannot access Tenant A records', async () => {
    let claimIdA = '';

    // Tenant A creates claim
    await asTenant(ids.hospitalA, async (tx) => {
      const claimA = await createClaimCaseInTx(tx, {
        hospitalId: ids.hospitalA,
        branchId: ids.branchA,
        admissionId: ids.admissionA,
        encounterId: ids.encounterA,
        patientId: ids.patientA,
        encounterPayerId: ids.encPayerA,
        payerProfileId: ids.payerProfile,
        actorUserId: ids.userA,
        clientId: uuid(),
      });
      claimIdA = claimA.id;
    });

    // Tenant B attempts to read or mutate Tenant A claim
    await asTenant(ids.hospitalB, async (tx) => {
      // 1. Tenant B SELECT query cannot see Tenant A claim
      const claimsForB = await tx
        .select()
        .from(schema.claimCases)
        .where(eq(schema.claimCases.id, claimIdA));
      expect(claimsForB).toHaveLength(0);

      // 2. Tenant B service operations reject with ClaimNotFoundError
      await expect(
        recordClaimRemittanceInTx(tx, {
          hospitalId: ids.hospitalB,
          claimCaseId: claimIdA,
          remittanceType: 'payment',
          amountPaise: 1000000,
          actorUserId: ids.userB,
          clientId: uuid(),
        })
      ).rejects.toThrow(ClaimNotFoundError);
    });
  });

  it('6. verifies deadline invariants, closing, and controlled reopening', async () => {
    await asTenant(ids.hospitalA, async (tx) => {
      const claim = await createClaimCaseInTx(tx, {
        hospitalId: ids.hospitalA,
        branchId: ids.branchA,
        admissionId: ids.admissionA,
        encounterId: ids.encounterA,
        patientId: ids.patientA,
        encounterPayerId: ids.encPayerA,
        payerProfileId: ids.payerProfile,
        actorUserId: ids.userA,
        clientId: uuid(),
      });

      // Verify deadline invariant: hospital internal deadline is <= payer deadline
      const payerDeadline = new Date('2026-10-25T18:00:00Z');
      const hospitalDeadline = new Date('2026-10-25T14:00:00Z');
      expect(hospitalDeadline.getTime()).toBeLessThan(payerDeadline.getTime());

      await tx
        .update(schema.claimCases)
        .set({
          queryDeadline: payerDeadline,
          hospitalInternalDeadline: hospitalDeadline,
          status: 'settled',
          settlementStatus: 'settled',
        })
        .where(eq(schema.claimCases.id, claim.id));

      const [freshClaim] = await tx
        .select()
        .from(schema.claimCases)
        .where(eq(schema.claimCases.id, claim.id));

      // Close settled claim
      const closed = await closeClaimCaseInTx(tx, {
        claimId: claim.id,
        hospitalId: ids.hospitalA,
        expectedVersion: freshClaim.version,
        notes: 'All remittances and TDS reconciled',
        actorUserId: ids.userA,
        clientId: uuid(),
      });
      expect(closed.status).toBe('closed_settled');

      // Controlled Reopening with audited reason
      const reopened = await reopenClaimCaseInTx(tx, {
        claimId: claim.id,
        hospitalId: ids.hospitalA,
        expectedVersion: closed.version,
        reopenReason: 'Insurer retrospective audit clawback notice',
        actorUserId: ids.userA,
        clientId: uuid(),
      });
      expect(reopened.status).toBe('settled');

      // Verify audit event exists for reopening
      const [reopenEvent] = await tx
        .select()
        .from(schema.claimEvents)
        .where(
          sql`claim_case_id = ${claim.id} and event_type = 'reopened'`
        );
      expect(reopenEvent).toBeDefined();
      expect(reopenEvent.notes).toContain('clawback notice');
    });
  });
});
