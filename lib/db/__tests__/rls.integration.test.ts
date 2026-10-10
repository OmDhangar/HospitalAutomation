import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertFixturePatient } from '@/lib/test/patient-fixture';

/**
 * These run against a real Postgres because row-level security cannot be
 * meaningfully unit tested — the whole point is that the database, not our
 * code, is the thing enforcing isolation.
 *
 * Start one with: docker compose -f infra/docker/docker-compose.yml up -d
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);

const uuid = () => crypto.randomUUID();

/** Platform identity tables (0039): definer-only, never tenant-readable. */
const PLATFORM_IDENTITY_TABLES = [
  'persons',
  'person_identity_corrections',
  'person_merges',
  'person_merge_items',
  'person_merge_requests',
  'person_verification_attempts',
];

const ids = {
  hospitalA: uuid(),
  hospitalB: uuid(),
  branchA: uuid(),
  branchB: uuid(),
  doctorA: uuid(),
  patientA: uuid(),
  appointmentA: uuid(),
  queueEventA: uuid(),
};

describe.skipIf(!enabled)('row-level security', () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;

  /** Runs a callback with the tenant context the application would set. */
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
        (${ids.hospitalA}, 'Hospital A', ${'a-' + ids.hospitalA.slice(0, 8)}),
        (${ids.hospitalB}, 'Hospital B', ${'b-' + ids.hospitalB.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Main A'),
        (${ids.branchB}, ${ids.hospitalB}, 'Main B')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name)
      values (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr A')
    `;
    await insertFixturePatient(admin, {
      id: ids.patientA,
      hospitalId: ids.hospitalA,
      phoneE164: '+919000000001',
      name: 'Patient A',
    });
    await admin`
      insert into appointments
        (id, hospital_id, branch_id, doctor_id, patient_id, service_date,
         token_number, source, public_token, public_token_expires_at)
      values
        (${ids.appointmentA}, ${ids.hospitalA}, ${ids.branchA}, ${ids.doctorA},
         ${ids.patientA}, '2026-09-04', 1, 'walk_in', ${'tok-' + ids.appointmentA},
         now() + interval '1 day')
    `;
    await admin`
      insert into queue_events
        (id, hospital_id, appointment_id, doctor_id, action, from_status, to_status)
      values
        (${ids.queueEventA}, ${ids.hospitalA}, ${ids.appointmentA}, ${ids.doctorA},
         'enqueue', 'CONFIRMED', 'WAITING')
    `;
    await admin`
      insert into doctor_slot_overrides
        (hospital_id, doctor_id, service_date, slot_time, is_available)
      values (${ids.hospitalA}, ${ids.doctorA}, '2026-09-04', '10:00:00', false)
    `;
    await admin`
      insert into doctor_interval_blocks
        (hospital_id, doctor_id, service_date, start_time, end_time, reason)
      values
        (${ids.hospitalA}, ${ids.doctorA}, '2026-09-04', '11:00:00', '11:30:00', 'Emergency')
    `;
  });

  afterAll(async () => {
    await admin`delete from hospitals where id in (${ids.hospitalA}, ${ids.hospitalB})`;
    await Promise.all([admin.end(), app.end()]);
  });

  it('shows a tenant only its own rows', async () => {
    const rows = await asTenant(ids.hospitalA, (tx) => tx`select id from branches`);
    expect(rows.map((r) => r.id)).toEqual([ids.branchA]);
  });

  it('hides every row when no tenant context is set, rather than showing all', async () => {
    const rows = await app`select id from branches`;
    expect(rows).toHaveLength(0);
  });

  it('cannot read another tenant even when asked for its id directly', async () => {
    const rows = await asTenant(
      ids.hospitalA,
      (tx) => tx`select id from branches where id = ${ids.branchB}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await expect(
      asTenant(
        ids.hospitalA,
        (tx) => tx`
          insert into branches (hospital_id, name)
          values (${ids.hospitalB}, 'Smuggled')
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  /**
   * These two were unprotected until 0027. The queries that read them filter on
   * doctor_id alone, so this asserts the backstop directly rather than trusting
   * that every caller remembers to add a hospital filter.
   */
  it('scopes doctor availability overrides, which are read by doctor_id alone', async () => {
    const [overrides, blocks] = await asTenant(ids.hospitalB, async (tx) => [
      await tx`select id from doctor_slot_overrides where doctor_id = ${ids.doctorA}`,
      await tx`select id from doctor_interval_blocks where doctor_id = ${ids.doctorA}`,
    ]);
    expect(overrides).toHaveLength(0);
    expect(blocks).toHaveLength(0);

    const own = await asTenant(
      ids.hospitalA,
      (tx) => tx`select id from doctor_slot_overrides where doctor_id = ${ids.doctorA}`,
    );
    expect(own).toHaveLength(1);
  });

  it('scopes patients, appointments and queue events too, not just branches', async () => {
    const [patients, appointments, events] = await asTenant(ids.hospitalB, async (tx) => [
      await tx`select id from patients`,
      await tx`select id from appointments`,
      await tx`select id from queue_events`,
    ]);
    expect(patients).toHaveLength(0);
    expect(appointments).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  /**
   * The named tables above prove the mechanism works. This proves nobody has
   * added a table that quietly sits outside it: any table carrying hospital_id
   * must have row-level security enabled, FORCEd so it applies to the owner
   * too, and a tenant_isolation policy. A new module forgetting one of those
   * leaks every tenant's rows with no visible symptom, so the assertion is
   * "the set of unprotected tables is empty" rather than a list to maintain.
   *
   * `hospitals` is keyed on `id` instead, and is covered by the cases above.
   *
   * `sessions` is the one deliberate exception, for the reason 0001 gives: a
   * login has to be resolvable before any hospital is known, so it cannot be
   * filtered by one. Its hospital_id is the *result* of authenticating, not a
   * key to authorise by, and access to it is confined to lib/services/auth.ts.
   *
   * Partitioned tables (0043 on) are checked on the parent, which holds the
   * policies. Each monthly partition must instead have row-level security
   * FORCEd with no policy at all: that denies every direct read, so its rows
   * are reachable only through the parent and the parent's policies.
   */
  it('leaves no tenant table outside row-level security', async () => {
    const unprotected = await admin`
      select c.relname,
             c.relrowsecurity as enabled,
             c.relforcerowsecurity as forced,
             exists (
               select 1 from pg_policies p
               where p.schemaname = 'public'
                 and p.tablename = c.relname
                 and p.policyname = 'tenant_isolation'
             ) as has_policy
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and c.relname <> 'sessions'
        and c.relname <> all (${PLATFORM_IDENTITY_TABLES})
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'hospital_id' and not a.attisdropped
        )
        and not (
          c.relrowsecurity
          and c.relforcerowsecurity
          and exists (
            select 1 from pg_policies p
            where p.schemaname = 'public'
              and p.tablename = c.relname
              and p.policyname = 'tenant_isolation'
          )
        )
        and not (
          c.relispartition
          and c.relrowsecurity
          and c.relforcerowsecurity
          and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
        )
      order by c.relname
    `;
    expect(unprotected.map((r) => r.relname)).toEqual([]);
  });

  /**
   * The exemption above. Platform identity tables (0039) carry a hospital_id
   * for audit, but they are not tenant tables: the app role holds no privilege
   * on them at all and reaches them only through the identity definer
   * functions, so there is nothing for a tenant policy to scope.
   */
  it('gives the app role no access at all to the platform identity tables', async () => {
    const role = process.env.APP_DB_ROLE ?? 'opd_app';
    const reachable = await admin`
      select t as relname
      from unnest(${PLATFORM_IDENTITY_TABLES}::text[]) t
      where has_table_privilege(${role}, 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
         or not exists (
           select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity
         )
    `;
    expect(reachable.map((r) => r.relname)).toEqual([]);
  });

  it('proves RLS is what is stopping it: the bypassing role sees everything', async () => {
    const rows = await admin`
      select id from branches where id in (${ids.branchA}, ${ids.branchB})
    `;
    expect(rows).toHaveLength(2);
  });

  it('rejects rewriting queue history', async () => {
    await expect(
      admin`update queue_events set action = 'skip' where id = ${ids.queueEventA}`,
    ).rejects.toThrow(/append-only/i);
  });

  it('still allows erasure, because deletion on request is a DPDP obligation', async () => {
    const throwaway = uuid();
    await admin`
      insert into queue_events
        (id, hospital_id, appointment_id, doctor_id, action, from_status, to_status)
      values
        (${throwaway}, ${ids.hospitalA}, ${ids.appointmentA}, ${ids.doctorA},
         'call', 'WAITING', 'CALLED')
    `;
    await admin`delete from queue_events where id = ${throwaway}`;
    const rows = await admin`select id from queue_events where id = ${throwaway}`;
    expect(rows).toHaveLength(0);
  });
});
