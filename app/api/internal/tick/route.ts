import { NextResponse } from 'next/server';
import { drainOutbox } from '@/lib/notify/worker';
import { runSweeps } from '@/lib/services/sweeps';

export const dynamic = 'force-dynamic';

/**
 * Sixty seconds, which is correct whether or not Fluid compute is enabled.
 *
 * The two Hobby modes disagree about the default and the repository cannot see
 * which one it is deployed under. Without Fluid the default is ten seconds,
 * which would kill a full `BATCH_SIZE` drain partway through and leave the
 * remaining rows in `sending` until the stuck-row reclaim picks them up five
 * minutes later. With Fluid the default is five minutes, long enough for one
 * hung request to span five scheduler intervals.
 *
 * Sixty is at or under the ceiling in both modes, so it cannot fail deployment
 * validation, and it bounds a runaway tick to a single interval. Overlapping
 * runs are already safe — the worker claims rows with SKIP LOCKED.
 */
export const maxDuration = 60;

/**
 * Drains the notification outbox.
 *
 * An HTTP endpoint rather than a long-lived process so the same deployment
 * works whether it is poked by cron, a platform scheduler, or a container
 * running `curl` in a loop — no separate worker to operate.
 *
 * Protected by a shared secret because it is reachable from the internet.
 */
export async function POST(request: Request) {
  const secret = process.env.INTERNAL_TICK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'INTERNAL_TICK_SECRET is not set' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  const result = await drainOutbox();

  /**
   * Housekeeping runs after the drain, and never blocks it.
   *
   * Expiring yesterday's stale rows is not worth delaying a token link a
   * patient is waiting on, and runSweeps swallows its own failures for the
   * same reason — a broken sweep must not turn a successful drain into a
   * non-2xx that the scheduler then retries.
   */
  const sweeps = await runSweeps();

  return NextResponse.json({ ...result, sweeps });
}
