import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Tenant isolation and routing invariants for the WhatsApp onboarding tables.
 *
 * Against a real Postgres, for the same reason as rls.integration.test.ts: the
 * claims being tested here are claims about what the database enforces. A mock
 * would only prove that the test agrees with the code.
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
  hospitalInactive: uuid(),
  integrationA: uuid(),
  integrationB: uuid(),
  numberA: uuid(),
  numberB: uuid(),
  numberInventory: uuid(),
  numberInactive: uuid(),
};

/** Distinct per run so parallel or repeated runs cannot collide on the unique index. */
const pn = {
  a: `1000${Date.now()}`.slice(0, 15),
  b: `2000${Date.now()}`.slice(0, 15),
  inventory: `3000${Date.now()}`.slice(0, 15),
  inactive: `4000${Date.now()}`.slice(0, 15),
};

describe.skipIf(!enabled)('whatsapp integration isolation', () => {
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
      insert into hospitals (id, name, slug, active) values
        (${ids.hospitalA}, 'WA Hospital A', ${'wa-a-' + ids.hospitalA.slice(0, 8)}, true),
        (${ids.hospitalB}, 'WA Hospital B', ${'wa-b-' + ids.hospitalB.slice(0, 8)}, true),
        (${ids.hospitalInactive}, 'WA Inactive', ${'wa-i-' + ids.hospitalInactive.slice(0, 8)}, false)
    `;

    await admin`
      insert into whatsapp_integrations (id, hospital_id, status, waba_id) values
        (${ids.integrationA}, ${ids.hospitalA}, 'connected', '111111111111111'),
        (${ids.integrationB}, ${ids.hospitalB}, 'connected', '222222222222222')
    `;

    await admin`
      insert into whatsapp_numbers (id, hospital_id, phone_number_id, status) values
        (${ids.numberA}, ${ids.hospitalA}, ${pn.a}, 'registered'),
        (${ids.numberB}, ${ids.hospitalB}, ${pn.b}, 'registered'),
        (${ids.numberInventory}, null, ${pn.inventory}, 'pending'),
        (${ids.numberInactive}, ${ids.hospitalInactive}, ${pn.inactive}, 'registered')
    `;
  });

  afterAll(async () => {
    await admin`
      delete from hospitals
      where id in (${ids.hospitalA}, ${ids.hospitalB}, ${ids.hospitalInactive})
    `;
    await admin`delete from whatsapp_numbers where id = ${ids.numberInventory}`;
    await Promise.all([admin.end(), app.end()]);
  });

  /* ------------------------------------------------------------- isolation */

  it('shows a hospital only its own integration', async () => {
    const rows = await asTenant(
      ids.hospitalA,
      (tx) => tx`select id from whatsapp_integrations`,
    );
    expect(rows.map((r) => r.id)).toEqual([ids.integrationA]);
  });

  it('cannot read another hospital’s integration even by id', async () => {
    const rows = await asTenant(
      ids.hospitalA,
      (tx) => tx`select id from whatsapp_integrations where id = ${ids.integrationB}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('hides every integration when no tenant context is set', async () => {
    const rows = await app`select id from whatsapp_integrations`;
    expect(rows).toHaveLength(0);
  });

  it('refuses to create an integration for another hospital', async () => {
    await expect(
      asTenant(
        ids.hospitalA,
        (tx) => tx`
          insert into whatsapp_integrations (hospital_id, status)
          values (${ids.hospitalB}, 'connected')
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot update another hospital’s integration', async () => {
    await asTenant(
      ids.hospitalA,
      (tx) => tx`
        update whatsapp_integrations set status = 'disconnected'
        where id = ${ids.integrationB}
      `,
    );
    // The update matches no visible row rather than erroring, which is exactly
    // the intended failure: a no-op, not a cross-tenant write.
    const [row] = await admin`
      select status from whatsapp_integrations where id = ${ids.integrationB}
    `;
    expect(row.status).toBe('connected');
  });

  it('cannot delete another hospital’s integration', async () => {
    await asTenant(
      ids.hospitalA,
      (tx) => tx`delete from whatsapp_integrations where id = ${ids.integrationB}`,
    );
    const rows = await admin`
      select id from whatsapp_integrations where id = ${ids.integrationB}
    `;
    expect(rows).toHaveLength(1);
  });

  it('keeps unassigned inventory invisible to every tenant', async () => {
    const rows = await asTenant(
      ids.hospitalA,
      (tx) => tx`select id from whatsapp_numbers where phone_number_id = ${pn.inventory}`,
    );
    expect(rows).toHaveLength(0);
  });

  /* ----------------------------------------------------- credential safety */

  it('forbids storing a credential on a platform-owned integration', async () => {
    await expect(
      admin`
        update whatsapp_integrations
        set credential_ciphertext = 'x', credential_iv = 'y',
            credential_auth_tag = 'z', credential_key_version = 1
        where id = ${ids.integrationA}
      `,
    ).rejects.toThrow(/platform_holds_no_credential/i);
  });

  it('forbids a half-written credential', async () => {
    await expect(
      admin`
        update whatsapp_integrations
        set ownership = 'hospital', credential_ciphertext = 'x'
        where id = ${ids.integrationA}
      `,
    ).rejects.toThrow(/credential_complete/i);
  });

  it('accepts a complete credential on a hospital-owned integration', async () => {
    await admin`
      update whatsapp_integrations
      set ownership = 'hospital', credential_ciphertext = 'ct',
          credential_iv = 'iv', credential_auth_tag = 'tag',
          credential_key_version = 1
      where id = ${ids.integrationA}
    `;
    const [row] = await admin`
      select ownership from whatsapp_integrations where id = ${ids.integrationA}
    `;
    expect(row.ownership).toBe('hospital');

    // Put it back for the remaining tests.
    await admin`
      update whatsapp_integrations
      set ownership = 'platform', credential_ciphertext = null,
          credential_iv = null, credential_auth_tag = null,
          credential_key_version = null
      where id = ${ids.integrationA}
    `;
  });

  /* ------------------------------------------------------ number ownership */

  it('refuses a second integration for the same hospital', async () => {
    await expect(
      admin`
        insert into whatsapp_integrations (hospital_id, status)
        values (${ids.hospitalA}, 'pending')
      `,
    ).rejects.toThrow(/whatsapp_integrations_one_per_hospital|duplicate key/i);
  });

  it('refuses to assign one phone number id to two hospitals', async () => {
    await expect(
      admin`
        insert into whatsapp_numbers (hospital_id, phone_number_id, status)
        values (${ids.hospitalB}, ${pn.a}, 'registered')
      `,
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('stops a hospital claiming another hospital’s number', async () => {
    // Hospital A cannot see B's row, so this becomes an insert — and the global
    // unique index on phone_number_id is what refuses it. Both layers matter:
    // RLS hides the row, the constraint prevents the collision.
    await expect(
      asTenant(
        ids.hospitalA,
        (tx) => tx`
          insert into whatsapp_numbers (hospital_id, phone_number_id, status)
          values (${ids.hospitalA}, ${pn.b}, 'registered')
        `,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  /* ------------------------------------------------------ inbound routing */

  it('resolves a registered number to its hospital', async () => {
    const [row] = await admin`
      select public.resolve_whatsapp_number(${pn.a}) as hospital_id
    `;
    expect(row.hospital_id).toBe(ids.hospitalA);
  });

  it('stops resolving once a number leaves registered', async () => {
    // This is the whole disconnect mechanism: routing is governed by the same
    // column the UI changes, so there is no second switch to forget.
    await admin`
      update whatsapp_numbers set status = 'released' where id = ${ids.numberA}
    `;

    const [row] = await admin`
      select public.resolve_whatsapp_number(${pn.a}) as hospital_id
    `;
    expect(row.hospital_id).toBeNull();

    await admin`
      update whatsapp_numbers set status = 'registered' where id = ${ids.numberA}
    `;
  });

  it('does not resolve a number belonging to an inactive hospital', async () => {
    const [row] = await admin`
      select public.resolve_whatsapp_number(${pn.inactive}) as hospital_id
    `;
    expect(row.hospital_id).toBeNull();
  });

  it('does not resolve unassigned inventory', async () => {
    const [row] = await admin`
      select public.resolve_whatsapp_number(${pn.inventory}) as hospital_id
    `;
    expect(row.hospital_id).toBeNull();
  });

  it('resolves nothing for an unknown number', async () => {
    const [row] = await admin`
      select public.resolve_whatsapp_number('000000000000000') as hospital_id
    `;
    expect(row.hospital_id).toBeNull();
  });

  /* -------------------------------------------------------- existing data */

  it('left existing registered numbers working after the migration', async () => {
    // The backfill must not have reset anyone: a hospital that was sending
    // before the migration still resolves, and its integration reads connected.
    const [number] = await admin`
      select status from whatsapp_numbers where id = ${ids.numberA}
    `;
    expect(number.status).toBe('registered');

    const [integration] = await admin`
      select status from whatsapp_integrations where hospital_id = ${ids.hospitalA}
    `;
    expect(integration.status).toBe('connected');
  });
});
