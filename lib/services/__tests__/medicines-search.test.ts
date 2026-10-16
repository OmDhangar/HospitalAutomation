import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { medicines } from '@/lib/db/schema';
import { searchMedicines } from '@/lib/services/medicines';
import { resolveMedicineIdInTx } from '@/lib/services/ipd-medication-orders';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);

const uuid = () => crypto.randomUUID();

const ids = {
  hospitalA: uuid(),
  userA: uuid(),
  localPricedMed: uuid(),
  localUnpricedMed: uuid(),
};

describe.skipIf(!enabled)('unified medicines search and auto-provisioning', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'Medicine Search Hospital', ${'med-' + ids.hospitalA.slice(0, 8)})
    `;
    await admin`
      insert into users (id, email, password_hash, name) values
        (${ids.userA}, ${'user-' + ids.userA.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Dr Search')
    `;

    // Seed one priced medicine and one unpriced medicine in this hospital
    await admin`
      insert into medicines (id, hospital_id, name, strength, form, unit, selling_price_paise, active) values
        (${ids.localPricedMed}, ${ids.hospitalA}, 'Paracetamol', '500 mg', 'Tablet', 'strip', 2500, true),
        (${ids.localUnpricedMed}, ${ids.hospitalA}, 'Amoxicillin', '500 mg', 'Capsule', 'capsule', null, true)
    `;
  });

  afterAll(async () => {
    if (admin) {
      await admin`delete from medicines where hospital_id = ${ids.hospitalA}`;
      await admin`delete from users where id = ${ids.userA}`;
      await admin`delete from hospitals where id = ${ids.hospitalA}`;
      await admin.end();
    }
  });

  it('returns hospital medicines with appropriate isGlobal and isPriced flags', async () => {
    const results = await searchMedicines({
      hospitalId: ids.hospitalA,
      query: 'Paracetamol',
    });

    expect(results.length).toBeGreaterThan(0);
    const paracetamol = results.find((r) => r.name.toLowerCase() === 'paracetamol');
    expect(paracetamol).toBeDefined();
    expect(paracetamol?.id).toBe(ids.localPricedMed);
    expect(paracetamol?.isGlobal).toBe(false);
    expect(paracetamol?.isPriced).toBe(true);
  });

  it('returns unpriced hospital medicines with isPriced: false', async () => {
    const results = await searchMedicines({
      hospitalId: ids.hospitalA,
      query: 'Amoxicillin',
    });

    expect(results.length).toBeGreaterThan(0);
    const amox = results.find((r) => r.name.toLowerCase() === 'amoxicillin');
    expect(amox).toBeDefined();
    expect(amox?.id).toBe(ids.localUnpricedMed);
    expect(amox?.isGlobal).toBe(false);
    expect(amox?.isPriced).toBe(false);
  });

  it('finds global medicines when not present in hospital formulary', async () => {
    // Meropenem is in global catalogue but not in hospitalA
    const results = await searchMedicines({
      hospitalId: ids.hospitalA,
      query: 'Meropenem',
    });

    expect(results.length).toBeGreaterThan(0);
    const meropenem = results.find((r) => r.name.toLowerCase().includes('meropenem'));
    expect(meropenem).toBeDefined();
    expect(meropenem?.isGlobal).toBe(true);
    expect(meropenem?.isPriced).toBe(false);
    expect(meropenem?.category).toBeDefined();
  });

  it('deduplicates local and global medicines so local tenant entry takes precedence', async () => {
    // Paracetamol is in both local and global catalogue
    const results = await searchMedicines({
      hospitalId: ids.hospitalA,
      query: 'Paracetamol',
    });

    const paracetamols = results.filter(
      (r) => r.name.toLowerCase() === 'paracetamol' && r.strength === '500 mg',
    );
    // Should only have 1 entry (the local one), not duplicated
    expect(paracetamols.length).toBe(1);
    expect(paracetamols[0].id).toBe(ids.localPricedMed);
    expect(paracetamols[0].isGlobal).toBe(false);
  });

  it('auto-provisions global/unlisted medicine into hospital formulary on prescribe', async () => {
    const resolvedId = await withTenant(ids.hospitalA, async (tx) => {
      return resolveMedicineIdInTx(tx, {
        hospitalId: ids.hospitalA,
        medicineName: 'Meropenem',
        strength: '1 g',
        form: 'Injection',
        unit: 'vial',
        actorUserId: ids.userA,
      });
    });

    expect(resolvedId).toBeDefined();

    // Verify it was created in medicines table for hospitalA as unpriced
    const check = await withTenant(ids.hospitalA, async (tx) => {
      const [row] = await tx
        .select()
        .from(medicines)
        .where(eq(medicines.id, resolvedId));
      return row;
    });

    expect(check).toBeDefined();
    expect(check?.name).toBe('Meropenem');
    expect(check?.sellingPricePaise).toBeNull();
    expect(check?.active).toBe(true);
  });
});
