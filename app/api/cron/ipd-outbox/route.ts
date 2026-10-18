import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/db/admin';
import { hospitals } from '@/lib/db/schema';
import { safeEqual } from '@/lib/security/tokens';
import {
  processPendingOutboxBatch,
  recoverStuckOutboxClaims,
} from '@/lib/services/ipd-emar-outbox';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * IPD eMAR Outbox Processing Cron Endpoint.
 *
 * Drains pending eMAR integration outbox events (medication billing, stock movements,
 * voids, and corrections) asynchronously with idempotent processing and retry backoff.
 * Protected by CRON_SECRET / INTERNAL_TICK_SECRET.
 */
async function handleOutboxDrain(request: Request) {
  const secret = process.env.CRON_SECRET || process.env.INTERNAL_TICK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not set' }, { status: 503 });
  }

  const authHeader = request.headers.get('authorization') ?? '';
  if (!safeEqual(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const targetHospitalId = url.searchParams.get('hospitalId');

  let hospitalIds: string[] = [];
  if (targetHospitalId) {
    hospitalIds = [targetHospitalId];
  } else {
    const adminDb = getAdminDb();
    const rows = await adminDb.select({ id: hospitals.id }).from(hospitals);
    hospitalIds = rows.map((r: { id: string }) => r.id);
  }

  let totalProcessed = 0;
  let totalPendingPricing = 0;
  let totalFailed = 0;
  let totalRecovered = 0;

  for (const hospitalId of hospitalIds) {
    try {
      const recovered = await recoverStuckOutboxClaims({ hospitalId });
      totalRecovered += recovered;

      const batchResult = await processPendingOutboxBatch({ hospitalId });
      totalProcessed += batchResult.processed;
      totalPendingPricing += batchResult.pendingPricing;
      totalFailed += batchResult.failed;
    } catch (err) {
      console.error(`[ipd-outbox-cron] Failed processing for hospital ${hospitalId}:`, err);
    }
  }

  return NextResponse.json({
    ok: true,
    processed: totalProcessed,
    pendingPricing: totalPendingPricing,
    failed: totalFailed,
    recoveredStuckClaims: totalRecovered,
  });
}

export async function POST(request: Request) {
  return handleOutboxDrain(request);
}

export async function GET(request: Request) {
  return handleOutboxDrain(request);
}
