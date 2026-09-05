import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    await admin`
      insert into patients (id, hospital_id, phone_e164, name)
      values (${ids.patientA}, ${ids.hospitalA}, '+919000000001', 'Patient A')
    `;
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
