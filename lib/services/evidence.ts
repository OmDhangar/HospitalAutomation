import { and, asc, desc, eq, gte, inArray, like, lt, or, sql, type SQL } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import { requestOrigin } from '@/lib/db/request-context';
import { acctDigests, acctEvents, bedAssignments, billItems, careEntries, chartEntries, staffMemberships, users } from '@/lib/db/schema';
import {
  EVENT_FAMILIES,
  GENESIS_HASH,
  digestHash,
  eventHash,
  merkleRoot,
  type EventFamily,
  type EvidenceProblem,
} from '@/lib/domain/evidence';
import { evidenceSigner, evidenceVerifier, type EvidenceSigner, type EvidenceVerifier } from '@/lib/security/evidence-key';
import { configuredAnchor, type AnchorRecord, type DigestAnchor } from './evidence-anchor';

/**
 * The evidence log (IPD sheets plan §7.6, phase A6-min, migration 0044).
 *
 * Rows arrive by themselves: capture triggers on the source tables write one
 * per insert, void or change. This file seals them (hourly, from the worker),
 * checks them (the worker incrementally, the owner on demand, the CLI in full)
 * and lists them for the Accountability page.
 */

const LOCK_CLASS = 4242;
const SEAL_EVERY_MS = 55 * 60_000;
/** Rows read per query while checking: bounded memory however long the stay. */
const VERIFY_BATCH_ROWS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Reader = <T>(query: SQL) => Promise<T[]>;
const adminReader: Reader = async <T,>(query: SQL) => (await getAdminDb().execute(query)) as unknown as T[];
const tenantReader =
  (hospitalId: string): Reader =>
  async <T,>(query: SQL) =>
    (await withTenant(hospitalId, (tx) => tx.execute(query), { clinical: true })) as unknown as T[];

/* ------------------------------------------------------------------ seal */

export type SealOutcome =
  | { kind: 'sealed'; digestNo: number; eventCount: number; anchored: boolean; signed: boolean }
  | { kind: 'nothing' }
  /** Writers were busy for the whole short wait; the next run seals. */
  | { kind: 'busy' }
  /** Another worker sealed the same range first. */
  | { kind: 'raced' };

type DigestRow = {
  digest_no: string;
  seq_from: string;
  seq_to: string;
  event_count: number;
  merkle_root: Buffer;
  prev_hash: Buffer;
  digest_hash: Buffer;
  signature: Buffer | null;
  key_id: string | null;
  sealed_at: Date;
  anchored_at: Date | null;
};

/**
 * Seals every event of one hospital not yet sealed into the next digest.
 *
 * The boundary is read under the hospital's advisory lock taken exclusively
 * for an instant: every insert holds it shared until commit (0044), so no
 * row at or below the boundary can still be in flight. `try` only — never
 * queue in front of writers; if they are busy for ~half a second, give up.
 */
export async function sealHospital(
  hospitalId: string,
  options: { signer?: EvidenceSigner | null; anchor?: DigestAnchor | null } = {},
): Promise<SealOutcome> {
  const db = getAdminDb();
  const signer = options.signer === undefined ? evidenceSigner() : options.signer;
  const anchor = options.anchor === undefined ? configuredAnchor() : options.anchor;

  const [last] = (await db.execute(sql`
    select digest_no::text, seq_to::text, digest_hash from acct_digests
    where hospital_id = ${hospitalId} order by digest_no desc limit 1`)) as unknown as Pick<DigestRow, 'digest_no' | 'seq_to' | 'digest_hash'>[];
  const seqFrom = last?.seq_to ?? '0';

  const boundary = await db.transaction(async (tx) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [{ locked }] = (await tx.execute(
        sql`select pg_try_advisory_xact_lock(${LOCK_CLASS}, hashtext(${hospitalId}::uuid::text)) as locked`,
      )) as unknown as { locked: boolean }[];
      if (locked) {
        const [{ max }] = (await tx.execute(sql`
          select max(seq)::text as max from acct_events
          where hospital_id = ${hospitalId} and seq > ${seqFrom}::bigint`)) as unknown as { max: string | null }[];
        return { max };
      }
      await sleep(30 * (attempt + 1));
    }
    return 'busy' as const;
  });
  if (boundary === 'busy') return { kind: 'busy' };
  if (boundary.max === null) return { kind: 'nothing' };
  const seqTo = boundary.max;

  const rows = (await db.execute(sql`
    select row_hash, (extract(epoch from recorded_at) * 1000)::float8 as recorded_ms from acct_events
    where hospital_id = ${hospitalId} and seq > ${seqFrom}::bigint and seq <= ${seqTo}::bigint
    order by seq`)) as unknown as { row_hash: Buffer; recorded_ms: number }[];
  if (rows.length === 0) return { kind: 'nothing' };

  const digestNo = Number(last?.digest_no ?? 0) + 1;
  const fields = {
    hospitalId,
    digestNo,
    seqFrom,
    seqTo,
    eventCount: rows.length,
    merkleRoot: merkleRoot(rows.map((r) => r.row_hash)),
    prevHash: last?.digest_hash ?? GENESIS_HASH,
  };
  const hash = digestHash(fields);
  const signature = signer ? signer.sign(hash) : null;
  // Raw queries return times as text; the arithmetic is done as numbers.
  const times = rows.map((r) => Number(r.recorded_ms));

  const inserted = (await db.execute(sql`
    insert into acct_digests (hospital_id, digest_no, seq_from, seq_to, event_count, first_recorded_at, last_recorded_at,
                              merkle_root, prev_hash, digest_hash, signature, key_id)
    values (${hospitalId}, ${digestNo}, ${seqFrom}::bigint, ${seqTo}::bigint, ${rows.length},
            ${new Date(Math.min(...times)).toISOString()}::timestamptz, ${new Date(Math.max(...times)).toISOString()}::timestamptz,
            ${fields.merkleRoot}, ${fields.prevHash}, ${hash}, ${signature}, ${signer?.keyId ?? null})
    on conflict (hospital_id, digest_no) do nothing
    returning sealed_at`)) as unknown as { sealed_at: Date }[];
  if (inserted.length === 0) return { kind: 'raced' };

  let anchored = false;
  if (anchor) {
    try {
      const ref = await anchor.put(anchorRecord(fields, hash, signature, signer?.keyId ?? null, new Date(inserted[0].sealed_at)));
      await db.execute(sql`
        update acct_digests set anchored_at = now(), anchor_ref = ${ref}
        where hospital_id = ${hospitalId} and digest_no = ${digestNo} and anchored_at is null`);
      anchored = true;
    } catch (error) {
      // The digest stands; the page shows it unanchored, and an operator is told.
      console.error('[evidence] anchoring failed', { hospitalId, digestNo, error: (error as Error).message });
    }
  }
  return { kind: 'sealed', digestNo, eventCount: rows.length, anchored, signed: signature !== null };
}

function anchorRecord(
  fields: { hospitalId: string; digestNo: number; seqFrom: string; seqTo: string; eventCount: number; merkleRoot: Buffer; prevHash: Buffer },
  hash: Buffer,
  signature: Buffer | null,
  keyId: string | null,
  sealedAt: Date,
): AnchorRecord {
  return {
    hospitalId: fields.hospitalId,
    digestNo: fields.digestNo,
    seqFrom: fields.seqFrom,
    seqTo: fields.seqTo,
    eventCount: fields.eventCount,
    merkleRoot: fields.merkleRoot.toString('hex'),
    prevHash: fields.prevHash.toString('hex'),
    digestHash: hash.toString('hex'),
    signature: signature?.toString('hex') ?? null,
    keyId,
    sealedAt: sealedAt.toISOString(),
  };
}

/** The worker's hourly step: every hospital whose last seal is over 55 minutes old and has new events. */
export async function sealDueHospitals(now: Date = new Date()): Promise<{ sealed: number; busy: number }> {
  const cutoff = new Date(now.getTime() - SEAL_EVERY_MS);
  const due = (await getAdminDb().execute(sql`
    select h.id from hospitals h
    left join lateral (
      select sealed_at, seq_to from acct_digests d where d.hospital_id = h.id order by digest_no desc limit 1
    ) d on true
    where (d.sealed_at is null or d.sealed_at < ${cutoff.toISOString()}::timestamptz)
      and exists (select 1 from acct_events e where e.hospital_id = h.id and e.seq > coalesce(d.seq_to, 0))`)) as unknown as { id: string }[];

  const signer = evidenceSigner();
  const anchor = configuredAnchor();
  let sealed = 0;
  let busy = 0;
  for (const { id } of due) {
    try {
      const outcome = await sealHospital(id, { signer, anchor });
      if (outcome.kind === 'sealed') sealed += 1;
      if (outcome.kind === 'busy') busy += 1;
    } catch (error) {
      console.error('[evidence] sealing failed', { hospitalId: id, error: (error as Error).message });
    }
  }
  return { sealed, busy };
}

/* ---------------------------------------------------------------- verify */

export type VerificationResult = {
  ok: boolean;
  fromDigest: number | null;
  toDigest: number | null;
  digestsChecked: number;
  eventsChecked: number;
  /** Rows written since the last seal: their own hashes are checked. */
  unsealedChecked: number;
  signaturesChecked: boolean;
  anchorsChecked: number;
  problems: EvidenceProblem[];
};

type EventRow = {
  seq: string;
  hospital_id: string;
  branch_id: string | null;
  occurred_us: string;
  recorded_us: string;
  actor_user_id: string | null;
  witness_user_id: string | null;
  channel: string | null;
  device_id: string | null;
  session_id: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  payload_text: string;
  row_hash: Buffer;
};

const eventRows = (hospitalId: string, fromExclusive: string, toInclusive: string | null) => sql`
  select seq::text as seq, hospital_id::text as hospital_id, branch_id::text as branch_id,
         ((extract(epoch from occurred_at) * 1000000)::bigint)::text as occurred_us,
         ((extract(epoch from recorded_at) * 1000000)::bigint)::text as recorded_us,
         actor_user_id::text as actor_user_id, witness_user_id::text as witness_user_id,
         channel, device_id, session_id::text as session_id, action, object_type, object_id,
         payload::text as payload_text, row_hash
  from acct_events
  where hospital_id = ${hospitalId} and seq > ${fromExclusive}::bigint
    ${toInclusive === null ? sql`` : sql`and seq <= ${toInclusive}::bigint`}
  -- The column, not the text alias above: as text, "100" sorts before "95".
  order by acct_events.seq
  ${toInclusive === null ? sql`limit ${VERIFY_BATCH_ROWS}` : sql``}`;

/** The row's hash as its columns say now, rebuilt here rather than trusted from the database. */
const recompute = (r: EventRow): Buffer =>
  eventHash({
    seq: r.seq,
    hospitalId: r.hospital_id,
    branchId: r.branch_id,
    occurredAtMicros: r.occurred_us,
    recordedAtMicros: r.recorded_us,
    actorUserId: r.actor_user_id,
    witnessUserId: r.witness_user_id,
    channel: r.channel,
    deviceId: r.device_id,
    sessionId: r.session_id,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id,
    payloadText: r.payload_text,
  });

/**
 * Checks one hospital's evidence: each digest follows the one before, its
 * hash and signature hold, its anchor copy agrees, and the rows in its range
 * — rebuilt from their columns — have the sealed count and root. Then the
 * rows written since the last seal are checked against their own hashes.
 *
 * Incremental by default: from the digest after the last clean check. `full`
 * starts from the first digest. The result is recorded and logged as an
 * event; a failure is also reported loudly to the operators.
 */
export async function verifyEvidence(args: {
  hospitalId: string;
  source: 'sweep' | 'manual' | 'cli';
  ranByUserId?: string | null;
  full?: boolean;
  /** 'tenant' for the owner's page (RLS, clinical key); 'admin' for the worker and CLI. */
  reader?: 'admin' | 'tenant';
  verifier?: EvidenceVerifier | null;
  anchor?: DigestAnchor | null;
  record?: boolean;
}): Promise<VerificationResult> {
  const read = args.reader === 'tenant' ? tenantReader(args.hospitalId) : adminReader;
  const verifier = args.verifier === undefined ? evidenceVerifier() : args.verifier;
  const anchor = args.anchor === undefined ? configuredAnchor() : args.anchor;
  const problems: EvidenceProblem[] = [];
  const add = (code: EvidenceProblem['code'], digestNo: number | null, count?: number) =>
    problems.push(count === undefined ? { code, digestNo } : { code, digestNo, count });

  let start = 1;
  if (!args.full) {
    const [lastOk] = await read<{ to_digest: string | null }>(sql`
      select to_digest::text from acct_verifications
      where hospital_id = ${args.hospitalId} and ok and to_digest is not null
      order by ran_at desc limit 1`);
    if (lastOk?.to_digest) start = Number(lastOk.to_digest) + 1;
  }

  const digests = await read<DigestRow>(sql`
    select digest_no::text, seq_from::text, seq_to::text, event_count, merkle_root, prev_hash, digest_hash,
           signature, key_id, sealed_at, anchored_at
    from acct_digests where hospital_id = ${args.hospitalId} and digest_no >= ${Math.max(start - 1, 1)}
    order by digest_no`);
  const previous = start > 1 ? digests.find((d) => Number(d.digest_no) === start - 1) : undefined;
  const toCheck = digests.filter((d) => Number(d.digest_no) >= start);

  let eventsChecked = 0;
  let anchorsChecked = 0;
  let prev: DigestRow | undefined = previous;
  let expectedNo = start;

  // Rows are read in batches spanning several digests, then split by range.
  for (let i = 0; i < toCheck.length; ) {
    let j = i;
    let rowsInBatch = 0;
    while (j < toCheck.length && (j === i || rowsInBatch + toCheck[j].event_count <= VERIFY_BATCH_ROWS)) {
      rowsInBatch += toCheck[j].event_count;
      j += 1;
    }
    const batch = toCheck.slice(i, j);
    const rows = await read<EventRow>(eventRows(args.hospitalId, batch[0].seq_from, batch[batch.length - 1].seq_to));
    let cursor = 0;

    for (const d of batch) {
      const no = Number(d.digest_no);
      if (no !== expectedNo) add('range_gap', no);
      expectedNo = no + 1;
      const expectedPrev = prev?.digest_hash ?? GENESIS_HASH;
      if (!d.prev_hash.equals(expectedPrev)) add('chain_broken', no);
      if (prev && d.seq_from !== prev.seq_to) add('range_gap', no);
      if (!prev && no === 1 && d.seq_from !== '0') add('range_gap', no);

      const hash = digestHash({
        hospitalId: args.hospitalId,
        digestNo: no,
        seqFrom: d.seq_from,
        seqTo: d.seq_to,
        eventCount: d.event_count,
        merkleRoot: d.merkle_root,
        prevHash: d.prev_hash,
      });
      if (!hash.equals(d.digest_hash)) add('digest_hash_mismatch', no);
      if (d.signature && verifier) {
        if (d.key_id !== verifier.keyId || !verifier.verify(d.digest_hash, d.signature)) add('signature_invalid', no);
      }
      if (anchor && d.anchored_at) {
        const copy = await anchor.get(args.hospitalId, no);
        anchorsChecked += 1;
        if (!copy || copy.digestHash !== d.digest_hash.toString('hex') || copy.prevHash !== d.prev_hash.toString('hex')) {
          add('anchor_mismatch', no);
        }
      }

      const upper = BigInt(d.seq_to);
      const mine: EventRow[] = [];
      while (cursor < rows.length && BigInt(rows[cursor].seq) <= upper) mine.push(rows[cursor++]);
      eventsChecked += mine.length;
      if (mine.length !== d.event_count) add('event_count_mismatch', no, mine.length - d.event_count);
      let changed = 0;
      const leaves = mine.map((r) => {
        const leaf = recompute(r);
        if (!leaf.equals(r.row_hash)) changed += 1;
        return leaf;
      });
      if (changed > 0) add('row_hash_mismatch', no, changed);
      if (!merkleRoot(leaves).equals(d.merkle_root)) add('merkle_root_mismatch', no);
      prev = d;
    }
    i = j;
  }

  // Since the last seal: each row against its own hash.
  const lastSealed = digests.at(-1)?.seq_to ?? '0';
  let unsealedChecked = 0;
  let after = lastSealed;
  for (;;) {
    const tail = await read<EventRow>(eventRows(args.hospitalId, after, null));
    if (tail.length === 0) break;
    const changed = tail.filter((r) => !recompute(r).equals(r.row_hash)).length;
    if (changed > 0) add('row_hash_mismatch', null, changed);
    unsealedChecked += tail.length;
    after = tail[tail.length - 1].seq;
    if (tail.length < VERIFY_BATCH_ROWS) break;
  }

  const result: VerificationResult = {
    ok: problems.length === 0,
    fromDigest: toCheck.length > 0 ? Number(toCheck[0].digest_no) : null,
    toDigest: toCheck.length > 0 ? Number(toCheck[toCheck.length - 1].digest_no) : null,
    digestsChecked: toCheck.length,
    eventsChecked: eventsChecked + unsealedChecked,
    unsealedChecked,
    signaturesChecked: verifier !== null,
    anchorsChecked,
    problems,
  };

  if (args.record !== false) await recordVerification(args, result, read);
  if (!result.ok) {
    // Ids and codes only. This line is what the operators' alert watches for.
    console.error('[evidence] CRITICAL: verification failed', { hospitalId: args.hospitalId, problems: result.problems });
  }
  return result;
}

async function recordVerification(
  args: { hospitalId: string; source: 'sweep' | 'manual' | 'cli'; ranByUserId?: string | null },
  result: VerificationResult,
  read: Reader,
) {
  const origin = await requestOrigin();
  await read(sql`
    with v as (
      insert into acct_verifications (hospital_id, ran_by_user_id, source, ok, from_digest, to_digest,
                                      digests_checked, events_checked, problems)
      values (${args.hospitalId}, ${args.ranByUserId ?? null}, ${args.source}, ${result.ok}, ${result.fromDigest},
              ${result.toDigest}, ${result.digestsChecked}, ${result.eventsChecked}, ${JSON.stringify(result.problems)}::jsonb)
      returning id
    )
    insert into acct_events (hospital_id, occurred_at, actor_user_id, channel, device_id, session_id,
                             action, object_type, object_id, payload)
    select ${args.hospitalId}::uuid, now(), ${args.ranByUserId ?? null}::uuid, ${origin?.channel ?? null}::text,
           ${origin?.deviceId ?? null}::text, ${origin?.sessionId ?? null}::uuid,
           ${result.ok ? 'evidence.verified' : 'evidence.verification_failed'}::text,
           'evidence_check', v.id::text,
           jsonb_build_object('source', ${args.source}::text, 'digests', ${result.digestsChecked}::int,
                              'events', ${result.eventsChecked}::int, 'problems', ${result.problems.length}::int)
    from v
    returning seq`);
}

/** The worker's step: an incremental check of every hospital with a digest sealed since its last check. */
export async function verifyDueHospitals(): Promise<{ checked: number; failed: number }> {
  const due = (await getAdminDb().execute(sql`
    select distinct d.hospital_id::text as id from acct_digests d
    where d.sealed_at > coalesce(
      (select max(v.ran_at) from acct_verifications v where v.hospital_id = d.hospital_id and v.source = 'sweep'),
      '-infinity'::timestamptz)`)) as unknown as { id: string }[];
  let failed = 0;
  for (const { id } of due) {
    try {
      const result = await verifyEvidence({ hospitalId: id, source: 'sweep' });
      if (!result.ok) failed += 1;
    } catch (error) {
      failed += 1;
      console.error('[evidence] CRITICAL: verification could not run', { hospitalId: id, error: (error as Error).message });
    }
  }
  return { checked: due.length, failed };
}

/* ------------------------------------------------------- the owner's page */

export type EvidenceStatus = {
  lastDigest: { digestNo: number; sealedAt: Date; eventCount: number; signed: boolean; anchored: boolean } | null;
  sealedEvents: number;
  unsealedEvents: number;
  lastCheck: {
    ranAt: Date;
    ok: boolean;
    source: 'sweep' | 'manual' | 'cli';
    digestsChecked: number;
    eventsChecked: number;
    problems: EvidenceProblem[];
  } | null;
};

export async function getEvidenceStatus(hospitalId: string): Promise<EvidenceStatus> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const [digest] = (await tx.execute(sql`
        select digest_no, sealed_at, event_count, seq_to::text, signature is not null as signed, anchored_at is not null as anchored,
               (select coalesce(sum(event_count), 0)::bigint::text from acct_digests where hospital_id = ${hospitalId}) as sealed_total
        from acct_digests where hospital_id = ${hospitalId} order by digest_no desc limit 1`)) as unknown as {
        digest_no: string;
        sealed_at: Date;
        event_count: number;
        seq_to: string;
        signed: boolean;
        anchored: boolean;
        sealed_total: string;
      }[];
      // Index range on (hospital_id, seq): cheap however large the log.
      const [{ unsealed }] = (await tx.execute(sql`
        select count(*)::int as unsealed from acct_events
        where hospital_id = ${hospitalId} and seq > ${digest?.seq_to ?? '0'}::bigint`)) as unknown as { unsealed: number }[];
      const [check] = (await tx.execute(sql`
        select ran_at, ok, source, digests_checked, events_checked, problems from acct_verifications
        where hospital_id = ${hospitalId} order by ran_at desc limit 1`)) as unknown as {
        ran_at: Date;
        ok: boolean;
        source: 'sweep' | 'manual' | 'cli';
        digests_checked: number;
        events_checked: number;
        problems: EvidenceProblem[];
      }[];
      return {
        lastDigest: digest
          ? {
              digestNo: Number(digest.digest_no),
              sealedAt: new Date(digest.sealed_at),
              eventCount: digest.event_count,
              signed: digest.signed,
              anchored: digest.anchored,
            }
          : null,
        sealedEvents: Number(digest?.sealed_total ?? 0),
        unsealedEvents: unsealed,
        lastCheck: check
          ? {
              ranAt: new Date(check.ran_at),
              ok: check.ok,
              source: check.source,
              digestsChecked: check.digests_checked,
              eventsChecked: check.events_checked,
              problems: check.problems,
            }
          : null,
      };
    },
    { clinical: true },
  );
}

export type EvidenceEvent = {
  seq: number;
  occurredAt: Date;
  recordedAt: Date;
  actorUserId: string | null;
  actorName: string | null;
  channel: string | null;
  deviceId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
};

/** The newest events first, 50 at a time, optionally one kind of activity or one person. */
export async function listEvidenceEvents(args: {
  hospitalId: string;
  beforeSeq?: number | null;
  family?: EventFamily | null;
  actorUserId?: string | null;
  limit?: number;
}): Promise<{ events: EvidenceEvent[]; nextBefore: number | null }> {
  const limit = Math.min(args.limit ?? 50, 200);
  const filters = [eq(acctEvents.hospitalId, args.hospitalId)];
  if (args.beforeSeq) filters.push(lt(acctEvents.seq, args.beforeSeq));
  if (args.actorUserId) filters.push(eq(acctEvents.actorUserId, args.actorUserId));
  if (args.family) {
    filters.push(or(...EVENT_FAMILIES[args.family].prefixes.map((prefix) => like(acctEvents.action, `${prefix}%`)))!);
  }
  const rows = await withTenant(
    args.hospitalId,
    (tx) =>
      tx
        .select({
          seq: acctEvents.seq,
          occurredAt: acctEvents.occurredAt,
          recordedAt: acctEvents.recordedAt,
          actorUserId: acctEvents.actorUserId,
          actorName: users.name,
          channel: acctEvents.channel,
          deviceId: acctEvents.deviceId,
          action: acctEvents.action,
          objectType: acctEvents.objectType,
          objectId: acctEvents.objectId,
        })
        .from(acctEvents)
        .leftJoin(users, eq(users.id, acctEvents.actorUserId))
        .where(and(...filters))
        .orderBy(desc(acctEvents.seq))
        .limit(limit + 1),
    { clinical: true },
  );
  return {
    events: rows.slice(0, limit),
    nextBefore: rows.length > limit ? rows[limit - 1].seq : null,
  };
}

/** Opening the Accountability page is itself logged (plan §7.6: every observability read). */
export async function recordEvidenceView(args: { hospitalId: string; actorUserId: string; filters: Record<string, string> }) {
  const origin = await requestOrigin();
  await withTenant(args.hospitalId, (tx) =>
    tx.execute(sql`
      insert into acct_events (hospital_id, occurred_at, actor_user_id, channel, device_id, session_id,
                               action, object_type, payload)
      values (${args.hospitalId}, now(), ${args.actorUserId}, ${origin?.channel ?? null}, ${origin?.deviceId ?? null},
              ${origin?.sessionId ?? null}, 'evidence.viewed', 'evidence_page', ${JSON.stringify(args.filters)}::jsonb)`),
  );
}

/* ------------------------------------------------------------ record history */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HistoryEvent = {
  seq: number;
  occurredAt: Date;
  recordedAt: Date;
  action: string;
  objectType: string;
  objectId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  channel: string | null;
  deviceId: string | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
  /** The seal that holds it, or null while it waits for the next hourly seal. */
  sealedIn: number | null;
};

export type RecordHistory = {
  objectType: string;
  objectId: string;
  /** The stay the record belongs to, for the patient's name and a link back. */
  admissionId: string | null;
  /** What the record says now: its own words, and whether it was struck through and why. */
  record: { description: string | null; voided: boolean; voidReason: string | null } | null;
  events: HistoryEvent[];
};

/**
 * "Who made this record, how and when" (plan Rev 5.1): every event of one
 * record, oldest first, with the related rows that belong to its story — a
 * bedside item's bill line, an admission's bed moves — and the seal each
 * event is in. Clinical (the payloads carry vitals); owner only by the page.
 */
export async function getRecordHistory(args: { hospitalId: string; objectType: string; objectId: string }): Promise<RecordHistory> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const ids = [args.objectId];
      let admissionId: string | null = null;
      let record: RecordHistory['record'] = null;

      if (UUID.test(args.objectId)) {
        if (args.objectType === 'chart_entry') {
          const [row] = await tx
            .select({ admissionId: chartEntries.admissionId, voidedAt: chartEntries.voidedAt, voidReason: chartEntries.voidReason })
            .from(chartEntries)
            .where(eq(chartEntries.id, args.objectId));
          if (row) {
            admissionId = row.admissionId;
            // No words of its own: the heading is the patient, the label says "T.P.R. reading".
            record = { description: null, voided: row.voidedAt !== null, voidReason: row.voidReason };
          }
        } else if (args.objectType === 'care_entry') {
          const [row] = await tx
            .select({
              admissionId: careEntries.admissionId,
              description: careEntries.description,
              quantity: careEntries.quantity,
              voidedAt: careEntries.voidedAt,
              voidReason: careEntries.voidReason,
            })
            .from(careEntries)
            .where(eq(careEntries.id, args.objectId));
          if (row) {
            admissionId = row.admissionId;
            record = { description: `${row.description} × ${row.quantity}`, voided: row.voidedAt !== null, voidReason: row.voidReason };
            const lines = await tx.select({ id: billItems.id }).from(billItems).where(eq(billItems.careEntryId, args.objectId));
            ids.push(...lines.map((line) => line.id));
          }
        } else if (args.objectType === 'bill_item') {
          const [row] = await tx
            .select({
              description: billItems.description,
              careEntryId: billItems.careEntryId,
              voidedAt: billItems.voidedAt,
              voidReason: billItems.voidReason,
            })
            .from(billItems)
            .where(eq(billItems.id, args.objectId));
          if (row) {
            record = { description: row.description, voided: row.voidedAt !== null, voidReason: row.voidReason };
            if (row.careEntryId) {
              ids.push(row.careEntryId);
              const [entry] = await tx
                .select({ admissionId: careEntries.admissionId })
                .from(careEntries)
                .where(eq(careEntries.id, row.careEntryId));
              admissionId = entry?.admissionId ?? null;
            }
          }
        } else if (args.objectType === 'admission') {
          admissionId = args.objectId;
          const moves = await tx
            .select({ id: bedAssignments.id })
            .from(bedAssignments)
            .where(eq(bedAssignments.admissionId, args.objectId));
          ids.push(...moves.map((move) => move.id));
        } else if (args.objectType === 'bed_assignment') {
          const [row] = await tx
            .select({ admissionId: bedAssignments.admissionId })
            .from(bedAssignments)
            .where(eq(bedAssignments.id, args.objectId));
          admissionId = row?.admissionId ?? null;
        }
      }

      const rows = await tx
        .select({
          seq: acctEvents.seq,
          occurredAt: acctEvents.occurredAt,
          recordedAt: acctEvents.recordedAt,
          action: acctEvents.action,
          objectType: acctEvents.objectType,
          objectId: acctEvents.objectId,
          actorUserId: acctEvents.actorUserId,
          actorName: users.name,
          actorRole: staffMemberships.role,
          channel: acctEvents.channel,
          deviceId: acctEvents.deviceId,
          sessionId: acctEvents.sessionId,
          payload: acctEvents.payload,
        })
        .from(acctEvents)
        .leftJoin(users, eq(users.id, acctEvents.actorUserId))
        .leftJoin(
          staffMemberships,
          and(eq(staffMemberships.userId, acctEvents.actorUserId), eq(staffMemberships.hospitalId, acctEvents.hospitalId)),
        )
        .where(and(eq(acctEvents.hospitalId, args.hospitalId), inArray(acctEvents.objectId, ids)))
        .orderBy(asc(acctEvents.seq))
        .limit(500);

      const first = rows[0]?.seq;
      const seals =
        first === undefined
          ? []
          : await tx
              .select({ digestNo: acctDigests.digestNo, seqFrom: acctDigests.seqFrom, seqTo: acctDigests.seqTo })
              .from(acctDigests)
              .where(and(eq(acctDigests.hospitalId, args.hospitalId), gte(acctDigests.seqTo, first)))
              .orderBy(asc(acctDigests.digestNo));

      return {
        objectType: args.objectType,
        objectId: args.objectId,
        admissionId,
        record,
        events: rows.map((row) => ({
          ...row,
          sealedIn: seals.find((seal) => row.seq > seal.seqFrom && row.seq <= seal.seqTo)?.digestNo ?? null,
        })),
      };
    },
    { clinical: true },
  );
}

/** Opening a record's history is itself recorded, on that record (plan §7.6: every observability read). */
export async function recordHistoryView(args: { hospitalId: string; actorUserId: string; objectType: string; objectId: string }) {
  const origin = await requestOrigin();
  await withTenant(args.hospitalId, (tx) =>
    tx.execute(sql`
      insert into acct_events (hospital_id, occurred_at, actor_user_id, channel, device_id, session_id,
                               action, object_type, object_id)
      values (${args.hospitalId}, now(), ${args.actorUserId}, ${origin?.channel ?? null}, ${origin?.deviceId ?? null},
              ${origin?.sessionId ?? null}, 'evidence.record_viewed', ${args.objectType}, ${args.objectId})`),
  );
}
