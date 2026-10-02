import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { createDirectAdmission } from '@/lib/services/admissions';
import {
  CareEntryError,
  getQuickPicks,
  recordCareEntries,
  undoCareEntry,
  voidCareEntry,
} from '@/lib/services/care-entries';
import { addStarterChargeItems, createChargeItem, createWard, setChargeItemPrices } from '@/lib/services/ipd-config';

/**
 * Bedside entries against a real database (task T1.7): a retried client id
 * is one entry and one bill line; an unpriced item is recorded, then billed
 * when priced; undo and void take the line with them; a discharged stay
 * refuses new entries.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Care Entries Test Hospital';

describe.skipIf(!enabled)('care entries', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const nurseId = uuid();
  const otherNurseId = uuid();
  let admissionId = '';
  let syringeId = '';
  let gauzeId = '';

  const entry = (item: { type: 'charge' | 'medicine'; id: string }, extra: Record<string, unknown> = {}) => ({
    clientId: uuid(),
    admissionId,
    item,
    quantity: 2,
    occurredAt: new Date().toISOString(),
    ...extra,
  });

  const linesFor = (entryId: string) =>
    admin`select total_paise, voided_at from bill_items where care_entry_id = ${entryId}`;

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'ce-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Joshi', 10)`;
    await admin`insert into users (id, email, password_hash, name) values
      (${nurseId}, ${'nurse-' + nurseId + '@careentries.test'}, 'x', 'Sister Anita'),
      (${otherNurseId}, ${'nurse-' + otherNurseId + '@careentries.test'}, 'x', 'Sister Meena')`;

    const { wardId } = await createWard({
      hospitalId, branchId, name: 'Ward A', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: nurseId,
    });
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId,
      branchId,
      doctorId,
      patient: { phoneE164: '+919600000001', name: 'Rahul Patil' },
      bedId: bed.id as string,
      actorUserId: nurseId,
    }));
    ({ id: syringeId } = await createChargeItem({
      hospitalId,
      input: { kind: 'consumable', name: 'Syringe 5 ml', unit: 'syringe', sellingPricePaise: 1500 },
      actorUserId: nurseId,
    }));
    ({ id: gauzeId } = await createChargeItem({
      hospitalId,
      input: { kind: 'consumable', name: 'Gauze', unit: 'pack' },
      actorUserId: nurseId,
    }));
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@careentries.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('records a priced item and bills it at the server’s price', async () => {
    const [result] = await recordCareEntries({
      hospitalId,
      entries: [entry({ type: 'charge', id: syringeId })],
      actorUserId: nurseId,
    });
    expect(result).toMatchObject({ ok: true, billed: true, description: 'Syringe 5 ml' });
    const lines = await linesFor((result as { entryId: string }).entryId);
    expect(lines).toEqual([{ total_paise: 3000, voided_at: null }]);
  });

  it('turns a retried client id into one entry and one bill line', async () => {
    const same = entry({ type: 'charge', id: syringeId });
    const [first] = await recordCareEntries({ hospitalId, entries: [same], actorUserId: nurseId });
    const [again] = await Promise.all([
      recordCareEntries({ hospitalId, entries: [same], actorUserId: nurseId }),
      recordCareEntries({ hospitalId, entries: [same], actorUserId: nurseId }),
    ]);
    expect(again[0]).toMatchObject({ ok: true, repeat: true });
    const entryId = (first as { entryId: string }).entryId;
    const rows = await admin`select id from care_entries where client_id = ${same.clientId}`;
    expect(rows).toHaveLength(1);
    expect(await linesFor(entryId)).toHaveLength(1);
  });

  it('records an unpriced item without a line, then bills it when the owner prices it', async () => {
    const [result] = await recordCareEntries({
      hospitalId,
      entries: [entry({ type: 'charge', id: gauzeId }, { quantity: 3 })],
      actorUserId: nurseId,
    });
    expect(result).toMatchObject({ ok: true, billed: false });
    const entryId = (result as { entryId: string }).entryId;
    expect(await linesFor(entryId)).toHaveLength(0);

    const priced = await setChargeItemPrices({
      hospitalId,
      edits: [{ id: gauzeId, sellingPricePaise: 4000 }],
      actorUserId: nurseId,
    });
    expect(priced.billed).toBe(1);
    expect(await linesFor(entryId)).toEqual([{ total_paise: 12_000, voided_at: null }]);
  });

  it('adds an item that is not in the list, unpriced, and records it', async () => {
    const [result] = await recordCareEntries({
      hospitalId,
      entries: [
        { clientId: uuid(), admissionId, item: { type: 'new', kind: 'consumable', name: 'Crepe bandage' }, quantity: 1, occurredAt: new Date().toISOString() },
      ],
      actorUserId: nurseId,
    });
    expect(result).toMatchObject({ ok: true, billed: false, description: 'Crepe bandage' });
  });

  it('lets a nurse undo her own entry, not another’s, and voids the line', async () => {
    const [mine] = await recordCareEntries({
      hospitalId,
      entries: [entry({ type: 'charge', id: syringeId })],
      actorUserId: nurseId,
    });
    const entryId = (mine as { entryId: string }).entryId;
    await expect(undoCareEntry({ hospitalId, entryId, actorUserId: otherNurseId })).rejects.toBeInstanceOf(
      CareEntryError,
    );
    await undoCareEntry({ hospitalId, entryId, actorUserId: nurseId });
    const [line] = await linesFor(entryId);
    expect(line.voided_at).not.toBeNull();
  });

  it('refuses undo after two minutes; the desk voids with a reason instead', async () => {
    const [old] = await recordCareEntries({
      hospitalId,
      entries: [entry({ type: 'charge', id: syringeId })],
      actorUserId: nurseId,
    });
    const entryId = (old as { entryId: string }).entryId;
    await expect(
      undoCareEntry({ hospitalId, entryId, actorUserId: nurseId, now: new Date(Date.now() + 3 * 60_000) }),
    ).rejects.toBeInstanceOf(CareEntryError);
    await voidCareEntry({ hospitalId, entryId, reason: 'Given to the wrong patient', actorUserId: otherNurseId });
    const [row] = await admin`select void_reason from care_entries where id = ${entryId}`;
    expect(row.void_reason).toBe('Given to the wrong patient');
  });

  it('refuses a future time and a discharged stay', async () => {
    const [future] = await recordCareEntries({
      hospitalId,
      entries: [entry({ type: 'charge', id: syringeId }, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() })],
      actorUserId: nurseId,
    });
    expect(future.ok).toBe(false);

    await admin`update admissions set status = 'discharged', discharged_at = now() where id = ${admissionId}`;
    const [late] = await recordCareEntries({
      hospitalId,
      entries: [entry({ type: 'charge', id: syringeId })],
      actorUserId: nurseId,
    });
    expect(late).toMatchObject({ ok: false, error: 'This patient has been discharged' });
    await admin`update admissions set status = 'admitted', discharged_at = null where id = ${admissionId}`;
  });

  it('offers this patient’s recent items, and a common list even for a new ward', async () => {
    await addStarterChargeItems({ hospitalId, actorUserId: nurseId });
    const picks = await getQuickPicks({ hospitalId, admissionId });
    expect(picks.recent.map((p) => p.label)).toContain('Syringe 5 ml');
    expect(picks.common.length).toBeGreaterThanOrEqual(10);
    expect(picks.common.some((p) => picks.recent.some((r) => r.ref.id === p.ref.id))).toBe(false);
  });
});
