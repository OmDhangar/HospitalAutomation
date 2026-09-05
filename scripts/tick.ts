import 'dotenv/config';
import { closeAdminDb } from '@/lib/db/admin';
import { drainOutbox } from '@/lib/notify/worker';

/**
 * Drains the notification outbox once, from the command line.
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
  await closeAdminDb();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
