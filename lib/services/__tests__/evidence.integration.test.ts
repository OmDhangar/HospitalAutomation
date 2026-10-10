import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { closeAdminDb } from '@/lib/db/admin';
import { withRequestContext } from '@/lib/db/request-context';
import { acctEvents } from '@/lib/db/schema';
import { evidenceSigner, evidenceVerifier } from '@/lib/security/evidence-key';
import { createDirectAdmission } from '@/lib/services/admissions';
import { recordCareEntries } from '@/lib/services/care-entries';
import { DirectoryAnchor } from '@/lib/services/evidence-anchor';
import { getEvidenceStatus, getRecordHistory, listEvidenceEvents, sealHospital, verifyEvidence } from '@/lib/services/evidence';
import { createChargeItem, createWard } from '@/lib/services/ipd-config';
import { recordTprEntries, voidTprEntry } from '@/lib/services/tpr';

/**
 * The evidence log against a real database (IPD sheets plan §7.6, migration
 * 0044): writes are captured by the database whatever code makes them, with
 * who, channel, device and session and numbers only; nobody can change or
 * remove an event; hospitals see only their own; seals chain, sign and anchor;
 * a writer still in flight is never sealed past; and every kind of tampering
 * a database administrator could try is caught by the check.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Evidence Log Test Hospital';

describe.skipIf(!enabled)('evidence log (0044)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 3 }) : (null as never);
  const app = enabled ? postgres(appUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const otherHospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const nurseId = uuid();
  const otherNurseId = uuid();
  const sessionId = uuid();
  let admissionId = '';
  let syringeId = '';
  const anchorDir = mkdtempSync(join(tmpdir(), 'qurio-anchor-'));
  const keys = (() => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      EVIDENCE_SIGNING_KEY: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      EVIDENCE_PUBLIC_KEY: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    };
  })();
  const signer = evidenceSigner(keys)!;
  const verifier = evidenceVerifier(keys)!;
  const anchor = new DirectoryAnchor(anchorDir);

  /** As the nurse on a ward tablet: what a real request carries. */
  const asNurse = <T,>(fn: () => Promise<T>, userId = nurseId) =>
    withRequestContext({ readOnly: false, staffUserId: userId, origin: { sessionId, channel: 'ward_device', deviceId: 'tablet-ward-a' } }, fn);

  const eventsFor = (objectId: string) =>
    admin`select action, actor_user_id, channel, device_id, session_id, payload, branch_id from acct_events
          where object_id = ${objectId} order by seq`;

  const newHospital = async (id: string, slug: string) => {
    await admin`insert into hospitals (id, name, slug) values (${id}, ${HOSPITAL_NAME}, ${slug + id.slice(0, 8)})`;
  };

  beforeAll(async () => {
    await newHospital(hospitalId, 'ev-');
    await newHospital(otherHospitalId, 'ev-o-');
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Pawara', 10)`;
    await admin`insert into users (id, email, password_hash, name) values
      (${nurseId}, ${'n-' + nurseId + '@evidence.test'}, 'x', 'Sister Anita'),
      (${otherNurseId}, ${'n-' + otherNurseId + '@evidence.test'}, 'x', 'Sister Meena')`;
    const { wardId } = await createWard({
      hospitalId, branchId, name: 'Ward A', dailyChargeItemId: null, bedLabels: '1-3', actorUserId: nurseId,
    });
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId,
      patient: { phoneE164: '+919600000777', name: 'Evidence Patient' },
      bedId: bed.id as string, actorUserId: nurseId,
    }));
    ({ id: syringeId } = await createChargeItem({
      hospitalId,
      input: { kind: 'consumable', name: 'Syringe 5 ml', unit: 'syringe', sellingPricePaise: 1500 },
      actorUserId: nurseId,
    }));
  });

  afterAll(async () => {
    rmSync(anchorDir, { recursive: true, force: true });
    if (!enabled) return;
    // Events and digests have no foreign keys and cannot be deleted: they stay, as evidence does.
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@evidence.test'`;
    await Promise.all([admin.end(), app.end(), closeDb(), closeAdminDb()]);
  });

  it('captures a charted reading with who, where from and the numbers — never the note', async () => {
    const [saved] = await asNurse(() =>
      recordTprEntries({
        hospitalId,
        actorUserId: nurseId,
        entries: [{ clientId: uuid(), admissionId, observedAt: new Date().toISOString(), pulse: 82, spo2: 97, note: 'Complains of cough' }],
      }),
    );
    if (!saved.ok) throw new Error(saved.error);
    const [event] = await eventsFor(saved.entryId);
    expect(event).toMatchObject({
      action: 'chart_entry.created',
      actor_user_id: nurseId,
      channel: 'ward_device',
      device_id: 'tablet-ward-a',
      session_id: sessionId,
      branch_id: branchId,
    });
    expect(event.payload).toMatchObject({ pulse: 82, spo2: 97, admission_id: admissionId });
    expect(JSON.stringify(event.payload)).not.toMatch(/cough|note/i);

    await asNurse(() => voidTprEntry({ hospitalId, entryId: saved.entryId, actorUserId: otherNurseId, reason: 'Wrong patient' }), otherNurseId);
    const events = (await eventsFor(saved.entryId)).filter((e) => e.action.startsWith('chart_entry.'));
    expect(events.map((e) => [e.action, e.actor_user_id])).toEqual([
      ['chart_entry.created', nurseId],
      ['chart_entry.voided', otherNurseId],
    ]);
    // The audited void is captured too, without its reason.
    const audited = await admin`select action, payload from acct_events where hospital_id = ${hospitalId} and action = 'ipd.chart_entry_voided'`;
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0].payload)).not.toMatch(/Wrong patient/);
  });

  it('captures a bedside item and the bill line it posts, and the admission and bed it belongs to', async () => {
    const [entry] = await asNurse(() =>
      recordCareEntries({
        hospitalId,
        actorUserId: nurseId,
        entries: [{ clientId: uuid(), admissionId, item: { type: 'charge', id: syringeId }, quantity: 2, occurredAt: new Date().toISOString() }],
      }),
    );
    if (!entry.ok) throw new Error(entry.error);
    expect((await eventsFor(entry.entryId)).map((e) => e.action)).toEqual(['care_entry.created']);
    const [line] = await admin`select id from bill_items where care_entry_id = ${entry.entryId}`;
    const [lineEvent] = await eventsFor(line.id as string);
    expect(lineEvent).toMatchObject({ action: 'bill_item.created' });
    expect(lineEvent.payload).toMatchObject({ quantity: 2, total_paise: 3000, care_entry_id: entry.entryId });

    expect((await eventsFor(admissionId)).map((e) => e.action)).toContain('admission.created');
    const beds = await admin`select action from acct_events where hospital_id = ${hospitalId} and object_type = 'bed_assignment'`;
    expect(beds.map((b) => b.action)).toContain('bed_assignment.created');
  });

  it('lets nobody change or remove an event: not the app, not the administrator', async () => {
    const [{ seq }] = await admin`select seq from acct_events where hospital_id = ${hospitalId} order by seq limit 1`;
    const asApp = (statement: string) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.hospital_id', ${hospitalId}, true), set_config('app.clinical_access', 'true', true)`;
        return tx.unsafe(statement);
      });
    await expect(asApp(`update acct_events set action = 'x.y' where seq = ${seq}`)).rejects.toThrow(/permission denied/);
    await expect(asApp(`delete from acct_events where seq = ${seq}`)).rejects.toThrow(/permission denied/);
    await expect(admin`update acct_events set action = 'x.y' where seq = ${seq}`).rejects.toThrow(/append-only/);
    await expect(admin`delete from acct_events where seq = ${seq}`).rejects.toThrow(/append-only/);
    // Nor can the app forge an event's place or hash: the database gives both.
    const [forged] = await app.begin(async (tx) => {
      await tx`select set_config('app.hospital_id', ${hospitalId}, true), set_config('app.clinical_access', 'true', true)`;
      return tx`insert into acct_events (seq, hospital_id, occurred_at, action, object_type, row_hash)
                values (1, ${hospitalId}, now(), 'forged.event', 'x', ${Buffer.alloc(32)}) returning seq, row_hash`;
    });
    expect(Number(forged.seq)).toBeGreaterThan(1);
    expect(Buffer.from(forged.row_hash as Buffer).equals(Buffer.alloc(32))).toBe(false);
  });

  it('shows a hospital only its own events, and only with the clinical key', async () => {
    const own = await withTenant(hospitalId, (tx) => tx.select({ seq: acctEvents.seq }).from(acctEvents), { clinical: true });
    expect(own.length).toBeGreaterThan(3);
    expect(await withTenant(hospitalId, (tx) => tx.select({ seq: acctEvents.seq }).from(acctEvents))).toEqual([]);
    expect(await withTenant(otherHospitalId, (tx) => tx.select({ seq: acctEvents.seq }).from(acctEvents), { clinical: true })).toEqual([]);
  });

  it('seals events into a signed, anchored chain that checks clean, from the page as from the worker', async () => {
    const first = await sealHospital(hospitalId, { signer, anchor });
    expect(first).toMatchObject({ kind: 'sealed', digestNo: 1, anchored: true, signed: true });
    expect(await sealHospital(hospitalId, { signer, anchor })).toEqual({ kind: 'nothing' });

    await admin`insert into audit_logs (hospital_id, actor_user_id, action, object_type, object_id)
                values (${hospitalId}, ${nurseId}, 'auth.login', 'user', ${nurseId})`;
    const second = await sealHospital(hospitalId, { signer, anchor });
    expect(second).toMatchObject({ kind: 'sealed', digestNo: 2, eventCount: 1 });

    const [d1, d2] = await admin`select digest_hash, prev_hash, seq_from, seq_to from acct_digests where hospital_id = ${hospitalId} order by digest_no`;
    expect(Buffer.from(d2.prev_hash).equals(Buffer.from(d1.digest_hash))).toBe(true);
    expect(d2.seq_from).toBe(d1.seq_to);
    expect(JSON.parse(readFileSync(join(anchorDir, hospitalId, '0000000002.json'), 'utf8'))).toMatchObject({ digestNo: 2 });

    const byWorker = await verifyEvidence({ hospitalId, source: 'sweep', full: true, verifier, anchor });
    expect(byWorker).toMatchObject({ ok: true, digestsChecked: 2, signaturesChecked: true, anchorsChecked: 2, problems: [] });
    const byOwner = await verifyEvidence({ hospitalId, source: 'manual', reader: 'tenant', ranByUserId: nurseId, full: true, verifier, anchor });
    expect(byOwner).toMatchObject({ ok: true, digestsChecked: 2, eventsChecked: byWorker.eventsChecked + 1 });

    const status = await getEvidenceStatus(hospitalId);
    expect(status).toMatchObject({ lastDigest: { digestNo: 2, signed: true, anchored: true }, lastCheck: { ok: true, source: 'manual' } });
    const page = await listEvidenceEvents({ hospitalId, family: 'charting' });
    expect(page.events.map((e) => e.action)).toEqual(['chart_entry.voided', 'chart_entry.created']);
    expect(page.events[0].actorName).toBe('Sister Meena');
  });

  it('tells one record’s story: who made it, who struck it through, how and when, and which seal holds it', async () => {
    const [saved] = await asNurse(() =>
      recordTprEntries({
        hospitalId,
        actorUserId: nurseId,
        entries: [{ clientId: uuid(), admissionId, observedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), pulse: 90 }],
      }),
    );
    if (!saved.ok) throw new Error(saved.error);
    await asNurse(() => voidTprEntry({ hospitalId, entryId: saved.entryId, actorUserId: otherNurseId, reason: 'Typing mistake' }), otherNurseId);
    await sealHospital(hospitalId, { signer, anchor });

    const story = await getRecordHistory({ hospitalId, objectType: 'chart_entry', objectId: saved.entryId });
    expect(story).toMatchObject({ admissionId, record: { voided: true, voidReason: 'Typing mistake' } });
    expect(story.events.map((e) => [e.action, e.actorName, e.channel])).toEqual([
      ['chart_entry.created', 'Sister Anita', 'ward_device'],
      ['chart_entry.voided', 'Sister Meena', 'ward_device'],
      ['ipd.chart_entry_voided', 'Sister Meena', 'ward_device'],
    ]);
    expect(story.events[0]).toMatchObject({ deviceId: 'tablet-ward-a', sessionId, payload: { pulse: 90 } });
    // Taken three hours before it was written: the history can show it as late.
    expect(story.events[0].recordedAt.getTime() - story.events[0].occurredAt.getTime()).toBeGreaterThan(2 * 3_600_000);
    expect(story.events.every((e) => typeof e.sealedIn === 'number')).toBe(true);

    // A bedside item's story includes the bill line it posted.
    const [{ id: entryId }] = await admin`select id from care_entries where admission_id = ${admissionId} limit 1`;
    const item = await getRecordHistory({ hospitalId, objectType: 'care_entry', objectId: entryId as string });
    expect(item.events.map((e) => e.action)).toEqual(['care_entry.created', 'bill_item.created']);
    expect(item.record?.description).toBe('Syringe 5 ml × 2');

    // Another hospital asking for the same id sees nothing.
    expect((await getRecordHistory({ hospitalId: otherHospitalId, objectType: 'chart_entry', objectId: saved.entryId })).events).toEqual([]);
  });

  it('never seals past a writer that has not committed yet', async () => {
    const before = await admin`select coalesce(max(digest_no), 0)::int as n from acct_digests where hospital_id = ${hospitalId}`;
    await app.begin(async (tx) => {
      await tx`select set_config('app.hospital_id', ${hospitalId}, true)`;
      await tx`insert into acct_events (hospital_id, occurred_at, action, object_type) values (${hospitalId}, now(), 'test.in_flight', 'test')`;
      // The row is written but not committed: sealing must wait, not seal around it.
      expect(await sealHospital(hospitalId, { signer, anchor })).toEqual({ kind: 'busy' });
    });
    const sealed = await sealHospital(hospitalId, { signer, anchor });
    expect(sealed).toMatchObject({ kind: 'sealed', digestNo: before[0].n + 1 });
    // The late row is inside the new seal, not left between seals.
    const [covered] = await admin`select 1 from acct_events e join acct_digests d on d.hospital_id = e.hospital_id
      where e.hospital_id = ${hospitalId} and e.action = 'test.in_flight' and d.digest_no = ${before[0].n + 1}
        and e.seq > d.seq_from and e.seq <= d.seq_to`;
    expect(covered).toBeDefined();
  });

  it('checks clean when the event numbers gain a digit inside one seal (99 → 100, 999 → 1000…)', async () => {
    const hospital = uuid();
    await newHospital(hospital, 'ev-d-');
    // Move the shared counter to just below the next power of ten (it only ever goes up).
    const [{ next }] = await admin`select (10::numeric ^ (length((last_value + 10)::text)))::bigint - 3 as next from acct_events_seq`;
    await admin`select setval('acct_events_seq', ${next})`;
    for (let i = 0; i < 6; i += 1) {
      await admin`insert into audit_logs (hospital_id, actor_user_id, action, object_type, object_id)
                  values (${hospital}, ${nurseId}, 'auth.login', 'user', ${String(i)})`;
    }
    expect(await sealHospital(hospital, { signer, anchor })).toMatchObject({ kind: 'sealed', eventCount: 6 });
    expect(await verifyEvidence({ hospitalId: hospital, source: 'cli', full: true, verifier, anchor, record: false })).toMatchObject({
      ok: true,
      eventsChecked: 6,
    });
  });

  describe('tampering by someone with full database access', () => {
    const victim = uuid();
    const tamper = (statements: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      admin.begin(async (tx) => {
        // What a DBA would do: switch the guard triggers off for the session.
        await tx`set local session_replication_role = replica`;
        await statements(tx);
      });
    const check = () => verifyEvidence({ hospitalId: victim, source: 'cli', full: true, verifier, anchor, record: false });
    const codes = async () => (await check()).problems.map((p) => p.code).sort();

    beforeAll(async () => {
      await newHospital(victim, 'ev-v-');
      for (let i = 0; i < 5; i += 1) {
        await admin`insert into audit_logs (hospital_id, actor_user_id, action, object_type, object_id)
                    values (${victim}, ${nurseId}, 'auth.login', 'user', ${String(i)})`;
      }
      await sealHospital(victim, { signer, anchor });
      expect((await check()).ok).toBe(true);
    });

    const seqs = async () => (await admin`select seq from acct_events where hospital_id = ${victim} order by seq`).map((r) => r.seq);

    it('catches an event changed after it was sealed, even with its hash recomputed', async () => {
      const [first] = await seqs();
      const [original] = await admin`select actor_user_id, row_hash from acct_events where seq = ${first}`;
      await tamper((tx) => tx`update acct_events set actor_user_id = ${otherNurseId} where seq = ${first}`);
      expect(await codes()).toEqual(['merkle_root_mismatch', 'row_hash_mismatch']);
      // A careful forger recomputes the row's hash with the database's own function: the seal still disagrees.
      await tamper(
        (tx) => tx`update acct_events set row_hash = sha256('\\x00'::bytea || convert_to(public.acct_event_canonical(
          seq, hospital_id, branch_id, occurred_at, recorded_at, actor_user_id, witness_user_id, channel, device_id, session_id,
          action, object_type, object_id, payload), 'UTF8')) where seq = ${first}`,
      );
      expect(await codes()).toEqual(['merkle_root_mismatch']);
      await tamper(
        (tx) => tx`update acct_events set actor_user_id = ${original.actor_user_id}, row_hash = ${original.row_hash} where seq = ${first}`,
      );
      expect((await check()).ok).toBe(true);
    });

    it('catches an event removed or slipped in', async () => {
      const all = await seqs();
      // Kept as JSON inside Postgres: a JS Date would drop the microseconds the hash covers.
      const [{ row }] = await admin`select to_jsonb(e) as row from acct_events e where seq = ${all[2]}`;
      await tamper((tx) => tx`delete from acct_events where seq = ${all[2]}`);
      expect(await codes()).toEqual(['event_count_mismatch', 'merkle_root_mismatch']);
      await tamper((tx) => tx`insert into acct_events select * from jsonb_populate_record(null::acct_events, ${row}::jsonb)`);
      expect((await check()).ok).toBe(true);
    });

    it('catches a seal rewritten to match, by its signature and its copy outside the database', async () => {
      // Rewrite the seal's root and hash consistently (the forger cannot sign, nor reach the anchor).
      const rows = await admin`select row_hash from acct_events where hospital_id = ${victim} order by seq limit 4`;
      const { merkleRoot, digestHash, GENESIS_HASH } = await import('@/lib/domain/evidence');
      const [d] = await admin`select seq_from::text, seq_to::text from acct_digests where hospital_id = ${victim} and digest_no = 1`;
      const root = merkleRoot(rows.map((r) => Buffer.from(r.row_hash as Buffer)));
      const hash = digestHash({ hospitalId: victim, digestNo: 1, seqFrom: d.seq_from, seqTo: d.seq_to, eventCount: 4, merkleRoot: root, prevHash: GENESIS_HASH });
      await tamper((tx) => tx`update acct_digests set event_count = 4, merkle_root = ${root}, digest_hash = ${hash} where hospital_id = ${victim} and digest_no = 1`);
      expect(await codes()).toEqual(['anchor_mismatch', 'event_count_mismatch', 'merkle_root_mismatch', 'signature_invalid']);

      // And a changed anchor file is noticed on its own.
      const file = join(anchorDir, victim, '0000000001.json');
      const original = readFileSync(file, 'utf8');
      writeFileSync(file, original.replace(/"eventCount":\d+/, '"eventCount":9'));
      await expect(anchor.put({ ...JSON.parse(original) })).rejects.toThrow(/different digest/);
      writeFileSync(file, original);
    });

    it('records a failed check and says so on the page', async () => {
      const result = await verifyEvidence({ hospitalId: victim, source: 'sweep', full: true, verifier, anchor });
      expect(result.ok).toBe(false);
      const [event] = await admin`select action, payload from acct_events where hospital_id = ${victim} and action like 'evidence.%'`;
      expect(event).toMatchObject({ action: 'evidence.verification_failed' });
      expect((await getEvidenceStatus(victim)).lastCheck).toMatchObject({ ok: false, source: 'sweep' });
    });
  });
});
