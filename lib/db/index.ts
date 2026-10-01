import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { isRequestReadOnly } from './request-context';
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

    try {
      const url = new URL(connectionString);
      console.log(`[DB:init] host=${url.host} | vercel_region=${process.env.VERCEL_REGION ?? 'local'}`);
    } catch {
      // ignore URL parsing error if connectionString is custom format
    }

    cachedClient = postgres(connectionString, {
      max: 10,
      prepare: false,
      idle_timeout: 30,
      connect_timeout: 10,
    });
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
  options: {
    readOnly?: boolean;
    /**
     * Opens the clinical tables (diagnoses, notes, prescriptions) for this
     * transaction. Only clinical services pass it, and it is refused on a
     * read-only request — which is what every support session is — so an
     * operator looking into a hospital never sees a medical record, whichever
     * code path they reach. See 0028_clinical_opd.sql.
     */
    clinical?: boolean;
  } = {},
): Promise<T> {
  if (!UUID_RE.test(hospitalId)) {
    throw new Error('withTenant requires a UUID hospital id');
  }

  const t0 = performance.now();
  return getDb().transaction(async (tx) => {
    const tTx = performance.now();
    /**
     * Both settings are written on every transaction, not only when read-only
     * is wanted. `app.read_only` governs a restrictive policy on every tenant
     * table, so leaving it to whatever the pooled connection last held is the
     * one way this could fail open.
     */
    const readOnly = options.readOnly ?? isRequestReadOnly();
    // Written every time, never left to the pooled connection's last value.
    const clinical = options.clinical === true && !readOnly;
    await tx.execute(
      sql`select
        set_config('app.hospital_id', ${hospitalId}, true),
        set_config('app.read_only', ${readOnly ? 'true' : 'false'}, true),
        set_config('app.clinical_access', ${clinical ? 'true' : 'false'}, true)`,
    );
    const tConfig = performance.now();
    const result = await fn(tx);
    const tEnd = performance.now();
    console.log(`[PERF:withTenant] acquire+begin: ${(tTx - t0).toFixed(1)}ms | set_config: ${(tConfig - tTx).toFixed(1)}ms | callback: ${(tEnd - tConfig).toFixed(1)}ms | total: ${(tEnd - t0).toFixed(1)}ms`);
    return result;
  });
}

export * from './schema';
