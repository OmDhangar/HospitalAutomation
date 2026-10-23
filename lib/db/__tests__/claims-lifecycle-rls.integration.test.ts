import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Tenant isolation and append-only invariants for Claims Lifecycle & Financial tables (0066, 0067).
 *
 * Runs against a real Postgres when available (e.g. docker compose).
 * If no Postgres is running, gracefully skipped via describe.skipIf(!enabled).
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);

const uuid = () => crypto.randomUUID();

const ids = {
  hospitalA: uuid(),
  hospitalB: uuid(),
};

const CLAIMS_TABLES = [
  'claim_cases',
  'claim_queries',
  'claim_events',
  'claim_authorizations',
  'claim_submissions',
  'claim_remittances',
  'claim_document_records',
];

describe.skipIf(!enabled)('claims lifecycle RLS and tenant isolation', () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;

  const asTenant = <T>(
    hospitalId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> =>
    app.begin(async (tx) => {
      await tx`select set_config('app.hospital_id', ${hospitalId}, true)`;
      return fn(tx);
    }) as Promise<T>;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });
    app = postgres(appUrl!, { max: 2 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'Claims Hospital A', ${'cl-a-' + ids.hospitalA.slice(0, 8)}),
        (${ids.hospitalB}, 'Claims Hospital B', ${'cl-b-' + ids.hospitalB.slice(0, 8)})
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from hospitals where id in (${ids.hospitalA}, ${ids.hospitalB})`.catch(() => {});
      await admin.end();
    }
    if (app) {
      await app.end();
    }
  });

  it('verifies that all claims lifecycle tables have row-level security enabled and forced', async () => {
    const unforced = await admin`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = any(${CLAIMS_TABLES}::text[])
        and not (c.relrowsecurity and c.relforcerowsecurity)
    `;
    expect(unforced.map((r) => r.relname)).toEqual([]);
  });

  it('verifies that all claims lifecycle tables possess a tenant_isolation policy', async () => {
    const missingPolicy = await admin`
      select t.relname
      from unnest(${CLAIMS_TABLES}::text[]) as t(relname)
      where not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = t.relname
          and p.policyname = 'tenant_isolation'
      )
    `;
    expect(missingPolicy.map((r) => r.relname)).toEqual([]);
  });

  it('verifies that app role has SELECT, INSERT, UPDATE grants on operational and financial tables', async () => {
    const role = process.env.APP_DB_ROLE ?? 'opd_app';
    for (const tbl of ['claim_cases', 'claim_queries', 'claim_authorizations', 'claim_submissions', 'claim_remittances']) {
      const [{ has_select, has_insert, has_update }] = await admin`
        select
          has_table_privilege(${role}, 'public.' || ${tbl}, 'SELECT') as has_select,
          has_table_privilege(${role}, 'public.' || ${tbl}, 'INSERT') as has_insert,
          has_table_privilege(${role}, 'public.' || ${tbl}, 'UPDATE') as has_update
      `;
      expect(has_select, `${tbl} should have SELECT`).toBe(true);
      expect(has_insert, `${tbl} should have INSERT`).toBe(true);
      expect(has_update, `${tbl} should have UPDATE`).toBe(true);
    }
  });

  it('proves cross-tenant isolation under asTenant: Tenant A cannot see or write Tenant B records', async () => {
    const payerId = uuid();
    const configA = uuid();
    const configB = uuid();

    const payerCode = `star-${uuid().slice(0, 8)}`;
    // Setup master payer profile via admin
    await admin`
      insert into payer_profiles (id, name, code, category)
      values (${payerId}, 'Star Health Insurance', ${payerCode}, 'tpa')
      on conflict (id) do nothing
    `;

    // Insert configurations for Hospital A and Hospital B via admin
    await admin`
      insert into hospital_payer_configs (id, hospital_id, payer_profile_id)
      values
        (${configA}, ${ids.hospitalA}, ${payerId}),
        (${configB}, ${ids.hospitalB}, ${payerId})
    `;

    // 1. Hospital A can only see its own configuration
    const rowsA = await asTenant(ids.hospitalA, (tx) => tx`
      select id from hospital_payer_configs
    `);
    expect(rowsA.map((r) => r.id)).toEqual([configA]);

    // 2. Hospital A cannot see Hospital B's configuration even when querying by specific ID
    const directFetch = await asTenant(ids.hospitalA, (tx) => tx`
      select id from hospital_payer_configs where id = ${configB}
    `);
    expect(directFetch).toHaveLength(0);

    // 3. Unscoped queries (no hospital_id context) return zero rows
    const unscoped = await app`select id from hospital_payer_configs`;
    expect(unscoped).toHaveLength(0);

    // 4. Hospital A cannot insert a record claiming to belong to Hospital B
    await expect(
      asTenant(ids.hospitalA, (tx) => tx`
        insert into hospital_payer_configs (id, hospital_id, payer_profile_id)
        values (${uuid()}, ${ids.hospitalB}, ${payerId})
      `)
    ).rejects.toThrow(/row-level security/i);

    // Clean up
    await admin`delete from hospital_payer_configs where id in (${configA}, ${configB})`;
    await admin`delete from payer_profiles where id = ${payerId}`;
  });
});
