import 'dotenv/config';
import { closeAdminDb } from '@/lib/db/admin';
import { drainOutbox } from '@/lib/notify/worker';
import { runSweeps } from '@/lib/services/sweeps';

/**
 * Drains the notification outbox and runs scheduled housekeeping, once.
 *
 * The same work is exposed at POST /api/internal/tick for a scheduler to call.
 * Having both means the worker can be run by hand while debugging without
 * standing up a cron entry or guessing at a secret.
 */
async function main() {
  const result = await drainOutbox();
  console.log(
    `sent ${result.sent}, failed ${result.failed}, suppressed ${result.suppressed}`,
  );

  // After the drain, not before: expiring a stale appointment must never
  // delay a message a patient is waiting on right now.
  const sweeps = await runSweeps();
  console.log(
    `expired ${sweeps.appointmentsExpired} appointment(s), ` +
      `${sweeps.subscriptionsExpired} subscription(s), ` +
      `${sweeps.paymentLinksExpired} payment link(s)`,
  );

  await closeAdminDb();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
