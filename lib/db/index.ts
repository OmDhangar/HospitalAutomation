import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

let cachedClient: postgres.Sql | undefined;
let cachedDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

/**
 * Connected lazily so that importing this module — which every service does —
 * does not require a configured database. Without that, test files could not
 * even be collected on a machine with no DATABASE_URL.
 */
export function getDb() {
  if (!cachedDb) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');

    cachedClient = postgres(connectionString, { max: 10 });
    cachedDb = drizzle(cachedClient, { schema });
  }
  return cachedDb;
}

/** Closes the pool. For scripts and test teardown; the server never calls this. */
export async function closeDb() {
  await cachedClient?.end();
  cachedClient = undefined;
  cachedDb = undefined;
}

export type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction scoped to one hospital.
 *
 * Row-level security policies read `app.hospital_id`, so every query inside the
 * callback is filtered by Postgres itself rather than by remembering to add a
 * `where hospitalId = ...` clause. Forgetting one is then a no-rows bug rather
 * than a cross-tenant data leak.
 *
 * `set_config(..., true)` makes the setting transaction-local. That third
 * argument is load-bearing: without it the value would persist on the pooled
 * connection and leak into whichever tenant's request picked it up next.
 */
export async function withTenant<T>(
  hospitalId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(hospitalId)) {
    throw new Error('withTenant requires a UUID hospital id');
  }

  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.hospital_id', ${hospitalId}, true)`);
    return fn(tx);
  });
}

export * from './schema';
