import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

let cachedClient: postgres.Sql | undefined;
let cachedDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

/**
 * The cross-tenant connection, used only by background work that legitimately
 * spans hospitals: the notification worker, migrations, and scheduled jobs.
 *
 * This role bypasses row-level security, so it must never serve a web request.
 * If you find yourself importing this from anything under `app/`, the design
 * has gone wrong — use withTenant instead.
 */
export function getAdminDb() {
  if (!cachedDb) {
    const connectionString = process.env.DATABASE_ADMIN_URL;
    if (!connectionString) throw new Error('DATABASE_ADMIN_URL is not set');

    cachedClient = postgres(connectionString, { max: 4 });
    cachedDb = drizzle(cachedClient, { schema });
  }
  return cachedDb;
}

export async function closeAdminDb() {
  await cachedClient?.end();
  cachedClient = undefined;
  cachedDb = undefined;
}
