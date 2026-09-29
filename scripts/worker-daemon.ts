import 'dotenv/config';
import { closeAdminDb } from '@/lib/db/admin';
import { drainOutbox } from '@/lib/notify/worker';
import { runSweeps } from '@/lib/services/sweeps';

let running = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('[worker] QueueCare background daemon started.');
  let lastSweep = 0;

  while (running) {
    try {
      // 1. Drain pending outbox notifications (checked every 5s)
      const outbox = await drainOutbox();
      if (outbox.sent > 0 || outbox.failed > 0 || outbox.suppressed > 0) {
        console.log(
          `[outbox] Sent: ${outbox.sent}, Failed: ${outbox.failed}, Suppressed: ${outbox.suppressed}`,
        );
      }

      // 2. Run housekeeping sweeps every 60s
      if (Date.now() - lastSweep > 60_000) {
        const sweeps = await runSweeps();
        if (
          sweeps.appointmentsExpired > 0 ||
          sweeps.appointmentsResumed > 0 ||
          sweeps.subscriptionsExpired > 0 ||
          sweeps.paymentLinksExpired > 0
        ) {
          console.log(
            `[sweeps] Expired appointments: ${sweeps.appointmentsExpired}, ` +
              `Resumed: ${sweeps.appointmentsResumed}, ` +
              `Expired subscriptions: ${sweeps.subscriptionsExpired}, ` +
              `Expired payment links: ${sweeps.paymentLinksExpired}`,
          );
        }
        lastSweep = Date.now();
      }
    } catch (error) {
      console.error('[worker:error]', error);
    }

    // Wait 5 seconds before next outbox check
    await sleep(5000);
  }

  await closeAdminDb();
  console.log('[worker] Daemon shut down cleanly.');
}

process.on('SIGINT', () => {
  console.log('\n[worker] Received SIGINT, shutting down...');
  running = false;
});

process.on('SIGTERM', () => {
  console.log('\n[worker] Received SIGTERM, shutting down...');
  running = false;
});

main().catch(async (error) => {
  console.error('[worker:fatal]', error);
  await closeAdminDb();
  process.exit(1);
});
