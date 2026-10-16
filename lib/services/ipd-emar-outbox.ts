import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import {
  admissions,
  careEntries,
  hospitals,
  ipdEmarIntegrationOutbox,
  ipdMedicationAdministrations,
  medicines,
  type SelectIpdEmarIntegrationOutbox,
} from '@/lib/db/schema';
import { postCareEntryLineInTx, voidCareEntryLineInTx } from '@/lib/services/ipd-billing';

export interface ProcessOutboxResult {
  outcome: 'processed' | 'pending_pricing' | 'retry' | 'failed';
  error?: string;
}

/**
 * Claims a batch of pending outbox events for a hospital using FOR UPDATE SKIP LOCKED.
 * Transitions claimed rows to 'processing' and records claimed_at lease.
 */
export async function claimOutboxBatch(args: {
  hospitalId: string;
  limit?: number;
  now?: Date;
}): Promise<SelectIpdEmarIntegrationOutbox[]> {
  const limit = args.limit ?? 10;
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();

  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const result = await tx.execute<SelectIpdEmarIntegrationOutbox>(sql`
        WITH candidates AS (
          SELECT id FROM ipd_emar_integration_outbox
          WHERE hospital_id = ${args.hospitalId}::uuid
            AND status = 'pending'
            AND scheduled_for <= ${nowIso}::timestamptz
          ORDER BY scheduled_for ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ipd_emar_integration_outbox
        SET status = 'processing', claimed_at = now()
        FROM candidates
        WHERE ipd_emar_integration_outbox.id = candidates.id
        RETURNING ipd_emar_integration_outbox.*;
      `);

      return (result || []).map((r: any) => ({
        id: r.id,
        hospitalId: r.hospital_id,
        administrationId: r.administration_id,
        integrationType: r.integration_type,
        eventType: r.event_type,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        status: r.status,
        attempts: r.attempts,
        scheduledFor: new Date(r.scheduled_for),
        claimedAt: r.claimed_at ? new Date(r.claimed_at) : null,
        lastError: r.last_error,
        processedAt: r.processed_at ? new Date(r.processed_at) : null,
        createdAt: new Date(r.created_at),
      })) as SelectIpdEmarIntegrationOutbox[];
    },
    { clinical: true },
  );
}

/**
 * Resets outbox claims stuck in 'processing' past maxClaimAgeMs back to 'pending'.
 */
export async function recoverStuckOutboxClaims(args: {
  hospitalId: string;
  maxClaimAgeMs?: number;
  now?: Date;
}): Promise<number> {
  const maxAge = args.maxClaimAgeMs ?? 5 * 60 * 1000;
  const now = args.now ?? new Date();
  const stuckThreshold = new Date(now.getTime() - maxAge).toISOString();

  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE ipd_emar_integration_outbox
        SET status = 'pending', claimed_at = NULL
        WHERE hospital_id = ${args.hospitalId}::uuid
          AND status = 'processing'
          AND claimed_at < ${stuckThreshold}::timestamptz
        RETURNING id;
      `);

      return result?.length ?? 0;
    },
    { clinical: true },
  );
}

/**
 * Exponential backoff calculation for outbox retries.
 * Formula: min(300, 2^attempts * 5)
 */
export function calculateOutboxBackoffSeconds(attempts: number): number {
  return Math.min(300, Math.pow(2, attempts) * 5);
}

/**
 * Processes an individual outbox integration event.
 * Dispatches billing charges, applies void strike-throughs, handles unpriced items,
 * and records retry backoff on failures.
 */
export async function processOutboxItem(args: {
  item: SelectIpdEmarIntegrationOutbox;
  actorUserId?: string;
}): Promise<ProcessOutboxResult> {
  const item = args.item;
  const now = new Date();

  try {
    return await withTenant(
      item.hospitalId,
      async (tx: Tx) => {
        const payload = (item.payload as Record<string, any>) ?? {};

        if (item.integrationType === 'billing') {
          if (item.eventType === 'administer') {
            const medicineId = payload.medicineId;
            const [medicine] = await tx
              .select()
              .from(medicines)
              .where(
                and(
                  eq(medicines.hospitalId, item.hospitalId),
                  eq(medicines.id, medicineId),
                ),
              );

            if (!medicine || medicine.sellingPricePaise === null) {
              // Unpriced item: move to pending_pricing without incrementing attempts
              await tx
                .update(ipdEmarIntegrationOutbox)
                .set({
                  status: 'pending_pricing',
                  claimedAt: null,
                })
                .where(eq(ipdEmarIntegrationOutbox.id, item.id));

              return { outcome: 'pending_pricing' };
            }

            // Fetch administration and admission details
            const [admin] = await tx
              .select()
              .from(ipdMedicationAdministrations)
              .where(
                and(
                  eq(ipdMedicationAdministrations.hospitalId, item.hospitalId),
                  eq(ipdMedicationAdministrations.id, item.administrationId),
                ),
              );

            if (!admin) throw new Error('Administration record not found for outbox event');

            // If already linked to a care entry (e.g. through synchronous billing or view sync),
            // simply mark outbox item processed and return
            if (admin.careEntryId) {
              await tx
                .update(ipdEmarIntegrationOutbox)
                .set({
                  status: 'processed',
                  processedAt: now,
                  claimedAt: null,
                })
                .where(eq(ipdEmarIntegrationOutbox.id, item.id));

              return { outcome: 'processed' };
            }

            const [admission] = await tx
              .select()
              .from(admissions)
              .where(
                and(
                  eq(admissions.hospitalId, item.hospitalId),
                  eq(admissions.id, admin.admissionId),
                ),
              );

            if (!admission) throw new Error('Admission not found for administration');

            // Insert care entry line
            const [careEntry] = await tx
              .insert(careEntries)
              .values({
                hospitalId: item.hospitalId,
                admissionId: admission.id,
                encounterId: admission.encounterId,
                patientId: admission.patientId,
                medicineId: medicine.id,
                description: medicine.name,
                quantity: payload.quantity ?? 1,
                occurredAt: admin.actualTime ?? admin.recordedAt,
                recordedAt: now,
                recordedByUserId: args.actorUserId ?? admin.nurseUserId,
                clientId: admin.clientId,
              })
              .returning();

            // Post to draft bill
            await postCareEntryLineInTx(tx, {
              entry: careEntry,
              actorUserId: args.actorUserId ?? admin.nurseUserId,
            });

            // Link care_entry_id to administration
            await tx
              .update(ipdMedicationAdministrations)
              .set({ careEntryId: careEntry.id })
              .where(eq(ipdMedicationAdministrations.id, admin.id));

            // Mark outbox item processed
            await tx
              .update(ipdEmarIntegrationOutbox)
              .set({
                status: 'processed',
                processedAt: now,
                claimedAt: null,
              })
              .where(eq(ipdEmarIntegrationOutbox.id, item.id));

            return { outcome: 'processed' };
          }

          if (item.eventType === 'void') {
            const [admin] = await tx
              .select()
              .from(ipdMedicationAdministrations)
              .where(
                and(
                  eq(ipdMedicationAdministrations.hospitalId, item.hospitalId),
                  eq(ipdMedicationAdministrations.id, item.administrationId),
                ),
              );

            if (admin?.careEntryId) {
              await voidCareEntryLineInTx(tx, {
                careEntryId: admin.careEntryId,
                actorUserId: args.actorUserId ?? admin.nurseUserId,
                reason: payload.voidReason ?? 'Medication administration voided',
              });
            }

            await tx
              .update(ipdEmarIntegrationOutbox)
              .set({
                status: 'processed',
                processedAt: now,
                claimedAt: null,
              })
              .where(eq(ipdEmarIntegrationOutbox.id, item.id));

            return { outcome: 'processed' };
          }

          if (item.eventType === 'correction') {
            // Void prior administration's care entry if present
            if (payload.originalAdministrationId) {
              const [origAdmin] = await tx
                .select()
                .from(ipdMedicationAdministrations)
                .where(
                  and(
                    eq(ipdMedicationAdministrations.hospitalId, item.hospitalId),
                    eq(ipdMedicationAdministrations.id, payload.originalAdministrationId),
                  ),
                );

              if (origAdmin?.careEntryId) {
                await voidCareEntryLineInTx(tx, {
                  careEntryId: origAdmin.careEntryId,
                  actorUserId: args.actorUserId ?? origAdmin.nurseUserId,
                  reason: payload.correctionReason ?? 'Corrected by successor administration',
                });
              }
            }

            await tx
              .update(ipdEmarIntegrationOutbox)
              .set({
                status: 'processed',
                processedAt: now,
                claimedAt: null,
              })
              .where(eq(ipdEmarIntegrationOutbox.id, item.id));

            return { outcome: 'processed' };
          }
        }

        if (item.integrationType === 'stock') {
          // Stock movement for risk-class medicines
          await tx
            .update(ipdEmarIntegrationOutbox)
            .set({
              status: 'processed',
              processedAt: now,
              claimedAt: null,
            })
            .where(eq(ipdEmarIntegrationOutbox.id, item.id));

          return { outcome: 'processed' };
        }

        return { outcome: 'processed' };
      },
      { clinical: true },
    );
  } catch (err: any) {
    const attempts = (item.attempts ?? 0) + 1;

    return await withTenant(
      item.hospitalId,
      async (tx: Tx) => {
        if (attempts >= 5) {
          await tx
            .update(ipdEmarIntegrationOutbox)
            .set({
              status: 'failed',
              attempts,
              lastError: err?.message ?? 'Unknown error',
              claimedAt: null,
            })
            .where(eq(ipdEmarIntegrationOutbox.id, item.id));

          return { outcome: 'failed', error: err?.message };
        }

        const backoffSeconds = calculateOutboxBackoffSeconds(attempts);
        const scheduledFor = new Date(Date.now() + backoffSeconds * 1000);

        await tx
          .update(ipdEmarIntegrationOutbox)
          .set({
            status: 'pending',
            attempts,
            scheduledFor,
            lastError: err?.message ?? 'Unknown error',
            claimedAt: null,
          })
          .where(eq(ipdEmarIntegrationOutbox.id, item.id));

        return { outcome: 'retry', error: err?.message };
      },
      { clinical: true },
    );
  }
}

/**
 * Lists outbox items that are failed or pending pricing (dead-letter queue).
 */
export async function listDeadLetterOutboxItems(args: {
  hospitalId: string;
  limit?: number;
}): Promise<SelectIpdEmarIntegrationOutbox[]> {
  const limit = args.limit ?? 50;
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const rows = await tx
        .select()
        .from(ipdEmarIntegrationOutbox)
        .where(
          and(
            eq(ipdEmarIntegrationOutbox.hospitalId, args.hospitalId),
            inArray(ipdEmarIntegrationOutbox.status, ['failed', 'pending_pricing']),
          ),
        )
        .orderBy(desc(ipdEmarIntegrationOutbox.createdAt))
        .limit(limit);

      return rows as SelectIpdEmarIntegrationOutbox[];
    },
    { clinical: true },
  );
}

/**
 * Resets a dead-lettered or failed outbox item back to pending for immediate retry.
 */
export async function retryDeadLetterItem(args: {
  hospitalId: string;
  outboxId: string;
}): Promise<boolean> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      await tx
        .update(ipdEmarIntegrationOutbox)
        .set({
          status: 'pending',
          attempts: 0,
          scheduledFor: new Date(),
          claimedAt: null,
          lastError: null,
        })
        .where(
          and(
            eq(ipdEmarIntegrationOutbox.hospitalId, args.hospitalId),
            eq(ipdEmarIntegrationOutbox.id, args.outboxId),
          ),
        );
      return true;
    },
    { clinical: true },
  );
}

/**
 * Reconciles outbox events in 'pending_pricing' back to 'pending' once
 * their medicine has received a price in the formulary.
 */
export async function reconcilePendingPricingItems(args: {
  hospitalId: string;
  medicineId: string;
}): Promise<number> {
  return withTenant(
    args.hospitalId,
    async (tx: Tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE ipd_emar_integration_outbox
        SET status = 'pending', scheduled_for = now()
        WHERE hospital_id = ${args.hospitalId}::uuid
          AND status = 'pending_pricing'
          AND payload->>'medicineId' = ${args.medicineId}
        RETURNING id;
      `);

      return result?.length ?? 0;
    },
    { clinical: true },
  );
}

/**
 * Helper to process all currently pending outbox items for a hospital.
 */
export async function processPendingOutboxBatch(args: {
  hospitalId: string;
  limit?: number;
}): Promise<{ processed: number; pendingPricing: number; failed: number }> {
  const items = await claimOutboxBatch({
    hospitalId: args.hospitalId,
    limit: args.limit ?? 20,
  });

  let processed = 0;
  let pendingPricing = 0;
  let failed = 0;

  for (const item of items) {
    const res = await processOutboxItem({ item });
    if (res.outcome === 'processed') processed += 1;
    else if (res.outcome === 'pending_pricing') pendingPricing += 1;
    else if (res.outcome === 'failed') failed += 1;
  }

  return { processed, pendingPricing, failed };
}

/**
 * Cross-tenant drain of IPD eMAR outbox across all hospitals.
 * Recovers stuck claims past lease timeout and processes pending batches.
 */
export async function drainAllHospitalsIpdEmarOutbox(now: Date = new Date()): Promise<{
  processed: number;
  pendingPricing: number;
  failed: number;
  recoveredStuckClaims: number;
}> {
  const adminDb = getAdminDb();
  let hospitalIds: string[] = [];
  try {
    const rows = await adminDb.select({ id: hospitals.id }).from(hospitals);
    hospitalIds = rows.map((r: { id: string }) => r.id);
  } catch {
    hospitalIds = [];
  }

  let totalProcessed = 0;
  let totalPendingPricing = 0;
  let totalFailed = 0;
  let totalRecovered = 0;

  for (const hospitalId of hospitalIds) {
    try {
      const recovered = await recoverStuckOutboxClaims({ hospitalId, now });
      totalRecovered += recovered;

      const batch = await processPendingOutboxBatch({ hospitalId });
      totalProcessed += batch.processed;
      totalPendingPricing += batch.pendingPricing;
      totalFailed += batch.failed;
    } catch (err) {
      console.error(`[ipd-outbox-drain] Failed processing for hospital ${hospitalId}:`, err);
    }
  }

  return {
    processed: totalProcessed,
    pendingPricing: totalPendingPricing,
    failed: totalFailed,
    recoveredStuckClaims: totalRecovered,
  };
}
