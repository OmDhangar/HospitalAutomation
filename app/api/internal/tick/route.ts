import { NextResponse } from 'next/server';
import { drainOutbox } from '@/lib/notify/worker';

export const dynamic = 'force-dynamic';

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
  return NextResponse.json(result);
}
