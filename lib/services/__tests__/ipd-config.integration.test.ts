import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { parseChargeItemCsv } from '@/lib/domain/ipd-config';
import { STARTER_CHARGE_ITEMS } from '@/lib/domain/starter-charge-items';
import {
  IpdConfigError,
  addBeds,
  addStarterChargeItems,
  createWard,
  importChargeItems,
  listChargeItems,
  listWardSetup,
  quickAddChargeItemInTx,
  setChargeItemPrices,
} from '@/lib/services/ipd-config';
import { withTenant } from '@/lib/db';

/**
 * IPD set-up against a real database (task T1.3): the starter list is safe to
 * load twice, "1-12" makes twelve beds, an import re-prices without wiping,
 * and a bulk price save is audited.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'IPD Config Test Hospital';

describe.skipIf(!enabled)('IPD set-up', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const ownerId = uuid();

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'ic-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`
      insert into users (id, email, password_hash, name)
      values (${ownerId}, ${'owner-' + ownerId + '@ipdconfig.test'}, 'x', 'Owner')`;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@ipdconfig.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('loads the starter list once, however often the button is pressed', async () => {
    const first = await addStarterChargeItems({ hospitalId, actorUserId: ownerId });
    const second = await addStarterChargeItems({ hospitalId, actorUserId: ownerId });
    expect(first.added).toBe(STARTER_CHARGE_ITEMS.length);
    expect(second.added).toBe(0);

    const { counts } = await listChargeItems({ hospitalId, filter: 'unpriced' });
    expect(counts.unpriced).toBe(STARTER_CHARGE_ITEMS.length);
  });

  it('makes a ward with twelve beds from "1-12", and skips beds that exist', async () => {
    const { wardId, bedsAdded } = await createWard({
      hospitalId,
      branchId,
      name: 'Ward A',
      dailyChargeItemId: null,
      bedLabels: '1-12',
      actorUserId: ownerId,
    });
    expect(bedsAdded).toBe(12);

    const more = await addBeds({ hospitalId, wardId, labels: '11-14', actorUserId: ownerId });
    expect(more).toEqual({ added: 2, skipped: 2 });

    const [ward] = (await listWardSetup(hospitalId)).filter((w) => w.id === wardId);
    expect(ward.beds.map((b) => b.label)).toEqual(
      Array.from({ length: 14 }, (_, i) => String(i + 1)),
    );
  });

  it('refuses a second ward with the same name', async () => {
    await expect(
      createWard({ hospitalId, branchId, name: 'ward a', dailyChargeItemId: null, actorUserId: ownerId }),
    ).rejects.toBeInstanceOf(IpdConfigError);
  });

  it('imports a price list: adds new names, re-prices old ones, never wipes a price', async () => {
    const preview = parseChargeItemCsv(
      ['Syringe 5 ml,consumable,syringe,15', 'Gloves,consumable,pair,', 'Plaster cast,procedure,each,1200'].join('\n'),
    );
    const result = await importChargeItems({ hospitalId, rows: preview.rows, actorUserId: ownerId });
    expect(result).toMatchObject({ added: 1, repriced: 1, unchanged: 1 });

    const { rows } = await listChargeItems({ hospitalId, query: 'syringe 5' });
    expect(rows[0].sellingPricePaise).toBe(1500);

    // A second import with a blank price leaves ₹15 alone.
    const again = await importChargeItems({
      hospitalId,
      rows: parseChargeItemCsv('Syringe 5 ml,consumable,syringe,').rows,
      actorUserId: ownerId,
    });
    expect(again.unchanged).toBe(1);
    const { rows: after } = await listChargeItems({ hospitalId, query: 'syringe 5' });
    expect(after[0].sellingPricePaise).toBe(1500);
  });

  it('saves many prices at once and audits each with both amounts', async () => {
    const { rows } = await listChargeItems({ hospitalId, query: 'nebulisation' });
    const item = rows.find((row) => row.kind === 'procedure')!;
    const result = await setChargeItemPrices({
      hospitalId,
      edits: [{ id: item.id, sellingPricePaise: 15_000 }],
      actorUserId: ownerId,
    });
    expect(result.changed).toBe(1);

    const [audit] = await admin`
      select metadata from audit_logs
      where hospital_id = ${hospitalId} and object_id = ${item.id} and action = 'billing.price_changed'`;
    expect(audit.metadata).toMatchObject({ fromPaise: null, toPaise: 15_000 });
  });

  it('quick-adds a missing item unpriced, and finds it again by name in any case', async () => {
    const added = await withTenant(hospitalId, (tx) =>
      quickAddChargeItemInTx(tx, { hospitalId, kind: 'consumable', name: 'Crepe bandage', actorUserId: ownerId }),
    );
    const again = await withTenant(hospitalId, (tx) =>
      quickAddChargeItemInTx(tx, { hospitalId, kind: 'consumable', name: 'crepe  BANDAGE', actorUserId: ownerId }),
    );
    expect(again.id).toBe(added.id);
    const { rows } = await listChargeItems({ hospitalId, query: 'crepe' });
    expect(rows[0].sellingPricePaise).toBeNull();
  });
});
