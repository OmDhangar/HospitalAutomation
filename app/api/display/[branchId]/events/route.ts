import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { displayEvents } from '@/lib/services/display-events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-Sent Events (SSE) stream for Waiting Room TV displays.
 *
 * Provides real-time push notifications when "Call Next Patient" or queue mutations occur.
 * Connected displays refresh instantaneously (<50ms) instead of waiting for a 10s static timer.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ branchId: string }> },
) {
  try {
    const session = await requireSession();
    const { branchId } = await params;

    const encoder = new TextEncoder();
    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        // Send initial connection event
        try {
          controller.enqueue(
            encoder.encode(`event: connected\ndata: ${JSON.stringify({ branchId, ok: true })}\n\n`),
          );
        } catch {
          return;
        }

        const onUpdate = () => {
          try {
            controller.enqueue(
              encoder.encode(`event: queue_update\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`),
            );
          } catch {
            // Stream was closed by client
          }
        };

        // 25s ping to keep connection alive through firewall / proxies
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            clearInterval(heartbeat);
          }
        }, 25000);

        const branchKey = `branch:${branchId}`;
        const hospitalKey = `hospital:${session.hospitalId}`;

        displayEvents.on(branchKey, onUpdate);
        displayEvents.on(hospitalKey, onUpdate);

        cleanup = () => {
          clearInterval(heartbeat);
          displayEvents.off(branchKey, onUpdate);
          displayEvents.off(hospitalKey, onUpdate);
        };
      },
      cancel() {
        if (cleanup) cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: unknown) {
    return new Response('Unauthorized or invalid display session', { status: 401 });
  }
}
