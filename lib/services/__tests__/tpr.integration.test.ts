import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { chartEntries } from '@/lib/db/schema';
import { createDirectAdmission } from '@/lib/services/admissions';
import { recordCareEntries } from '@/lib/services/care-entries';
import { createWard } from '@/lib/services/ipd-config';
import { getLatestVitals, getTprDay, getTprDays, recordTprEntries, undoTprEntry, voidTprEntry } from '@/lib/services/tpr';
import { chartDayOf } from '@/lib/domain/tpr';

/**
 * The T.P.R. chart against a real database (IPD sheets plan B1, migration
 * 0043): a retried reading is charted once; a discharged stay, a future time
 * and a ward outside the rollout are refused, one reading at a time; readings
 * are never edited, only undone (own, two minutes) or struck through with a
 * reason; the day runs 8 am to 8 am with intake/output per shift; rows are
 * clinical and tenant-isolated, and the monthly partitions cannot be read
 * around the parent's policies.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'TPR Chart Test Hospital';
const TZ = 'Asia/Kolkata';

describe.skipIf(!enabled)('T.P.R. chart (0043)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const otherHospitalId = uuid();
  const branchId = uuid();
  const otherBranchId = uuid();
  const doctorId = uuid();
  const nurseId = uuid();
  const otherNurseId = uuid();
  let wardId = '';
  let bedIds: string[] = [];
  let admissionId = '';
  let phone = 10;

  const admit = async (bedId: string | null) => {
    phone += 1;
    return (
      await createDirectAdmission({
        hospitalId,
        branchId,
        doctorId,
        patient: { phoneE164: `+9196100000${String(phone).padStart(2, '0')}`, name: `TPR Patient ${phone}` },
        bedId,
        actorUserId: nurseId,
      })
    ).admissionId;
  };

  const reading = (extra: Record<string, unknown> = {}) => ({
    clientId: uuid(),
    admissionId,
    observedAt: new Date().toISOString(),
    pulse: 82,
    bpSystolic: 110,
    bpDiastolic: 70,
    ...extra,
  });

  const record = (entries: Record<string, unknown>[], actorUserId = nurseId, wardAllowed?: (w: string | null) => boolean) =>
    recordTprEntries({ hospitalId, entries: entries as never, actorUserId, wardAllowed });

  /** Charts one reading and returns its id. */
  const savedId = async (entry: Record<string, unknown>) => {
    const [outcome] = await record([entry]);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.entryId;
  };

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values
      (${hospitalId}, ${HOSPITAL_NAME}, ${'tpr-' + hospitalId.slice(0, 12)}),
      (${otherHospitalId}, ${HOSPITAL_NAME}, ${'tpr-' + otherHospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values
      (${branchId}, ${hospitalId}, 'Main'), (${otherBranchId}, ${otherHospitalId}, 'Other')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Pawara', 10)`;
    await admin`insert into users (id, email, password_hash, name) values
      (${nurseId}, ${'nurse-' + nurseId + '@tpr.test'}, 'x', 'Sister Anita'),
      (${otherNurseId}, ${'nurse-' + otherNurseId + '@tpr.test'}, 'x', 'Sister Meena')`;
    ({ wardId } = await createWard({
      hospitalId, branchId, name: 'General ward', dailyChargeItemId: null, bedLabels: '1-6', actorUserId: nurseId,
    }));
    bedIds = (await admin`select id from beds where ward_id = ${wardId} order by sort_order`).map((row) => row.id as string);
    admissionId = await admit(bedIds[0]);
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@tpr.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  const rowsFor = (clientId: string) => admin`select id, pulse, branch_id, recorded_by_user_id from chart_entries where client_id = ${clientId}`;

  it('charts a reading with the branch and recorder from the server', async () => {
    const entry = reading({ spo2: 97, tempFTenths: 986 });
    const [result] = await record([entry]);
    expect(result).toMatchObject({ ok: true, repeat: false });
    expect(await rowsFor(entry.clientId)).toEqual([
      expect.objectContaining({ pulse: 82, branch_id: branchId, recorded_by_user_id: nurseId }),
    ]);
  });

  it('turns a retried client id into one reading, even when the retries race', async () => {
    const entry = reading();
    const [first] = await record([entry]);
    const again = await Promise.all([record([entry]), record([entry]), record([entry])]);
    for (const [outcome] of again) expect(outcome).toMatchObject({ ok: true, repeat: true, entryId: (first as { entryId: string }).entryId });
    expect(await rowsFor(entry.clientId)).toHaveLength(1);
  });

  it('refuses a future time, a stay without a bed, a discharged stay and a ward outside the rollout — one reading at a time', async () => {
    const waiting = await admit(null);
    const discharged = await admit(bedIds[1]);
    await admin`update admissions set status = 'discharged', discharged_at = now() where id = ${discharged}`;

    const good = reading();
    const results = await record([
      reading({ observedAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
      reading({ admissionId: waiting }),
      reading({ admissionId: discharged }),
      good,
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : r.error))).toEqual([
      'The time given is in the future',
      'This patient does not have a bed yet',
      'This patient has been discharged',
      'ok',
    ]);
    expect(await rowsFor(good.clientId)).toHaveLength(1);

    const [outside] = await record([reading()], nurseId, (w) => w !== wardId);
    expect(outside).toMatchObject({ ok: false, error: 'The T.P.R. chart is not switched on for this ward yet' });
  });

  it('cannot chart another hospital’s patient', async () => {
    const [result] = await recordTprEntries({ hospitalId: otherHospitalId, entries: [reading()] as never, actorUserId: nurseId });
    expect(result).toMatchObject({ ok: false, error: 'Patient not found' });
  });

  it('lets the nurse undo her own reading for two minutes, not another’s, and never twice', async () => {
    const mine = await savedId(reading());
    await expect(undoTprEntry({ hospitalId, entryId: mine, actorUserId: otherNurseId })).rejects.toThrow(/own reading/);
    await undoTprEntry({ hospitalId, entryId: mine, actorUserId: nurseId });
    await expect(undoTprEntry({ hospitalId, entryId: mine, actorUserId: nurseId })).rejects.toThrow(/already been removed/);

    const old = await savedId(reading());
    await expect(
      undoTprEntry({ hospitalId, entryId: old, actorUserId: nurseId, now: new Date(Date.now() + 3 * 60_000) }),
    ).rejects.toThrow(/within two minutes/);
  });

  it('strikes a wrong reading through with a reason, keeps it on the sheet, and leaves it out of the totals', async () => {
    const wrong = await savedId(reading({ urineMl: 900 }));
    await expect(voidTprEntry({ hospitalId, entryId: wrong, actorUserId: otherNurseId, reason: ' ' })).rejects.toThrow(/Say why/);
    await voidTprEntry({ hospitalId, entryId: wrong, actorUserId: otherNurseId, reason: 'Wrong patient' });
    await expect(voidTprEntry({ hospitalId, entryId: wrong, actorUserId: otherNurseId, reason: 'Again' })).rejects.toThrow(/already/);

    const day = await getTprDay({ hospitalId, admissionId, day: chartDayOf(new Date(), TZ), timezone: TZ });
    expect(day.readings.some((r) => r.id === wrong)).toBe(false);
    expect(day.voided.find((r) => r.id === wrong)).toMatchObject({ voidReason: 'Wrong patient', urineMl: 900 });
    expect(day.totals.day.outputMl).not.toBeGreaterThanOrEqual(900);

    const [audit] = await admin`select action, metadata from audit_logs where object_id = ${wrong}`;
    expect(audit).toMatchObject({ action: 'ipd.chart_entry_voided', metadata: { reason: 'Wrong patient' } });
  });

  it('refuses any change to a reading’s values in the database', async () => {
    const entry = reading();
    await record([entry]);
    await expect(admin`update chart_entries set pulse = 90 where client_id = ${entry.clientId}`).rejects.toThrow();
  });

  it('builds the chart day: 8 am to 8 am, intake/output by shift, what was given, late entries marked', async () => {
    const fresh = await admit(bedIds[2]);
    const at = (iso: string) => ({ ...reading({ admissionId: fresh, observedAt: iso }) });
    // Readings over the last 30 hours, relative to now, so they are never in the future.
    const now = Date.now();
    const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    await record([
      { ...at(iso(0.2)), urineMl: 300 },
      { ...at(iso(3)), oralMl: 200, pulse: 120 },
    ]);
    await recordCareEntries({
      hospitalId,
      entries: [{ clientId: uuid(), admissionId: fresh, item: { type: 'new', kind: 'medicine', name: 'Inj Pan 40' }, quantity: 1, occurredAt: iso(0.1) }],
      actorUserId: nurseId,
    });

    const day = chartDayOf(new Date(now - 0.2 * 3_600_000), TZ);
    const sheet = await getTprDay({ hospitalId, admissionId: fresh, day, timezone: TZ });
    const sameDay = (hoursAgo: number) => chartDayOf(new Date(now - hoursAgo * 3_600_000), TZ) === day;
    const expected = [0.2, 3].filter(sameDay);
    expect(sheet.readings).toHaveLength(expected.length);
    expect(sheet.treatment.map((g) => g.description)).toEqual(['Inj Pan 40']);
    expect(sheet.totals.day.outputMl).toBe(300);
    expect(sheet.readings.every((r) => r.recordedByName === 'Sister Anita')).toBe(true);

    // A reading written three hours after it was taken is a late entry.
    const late = (await getTprDays({ hospitalId, admissionId: fresh, fromDay: chartDayOf(new Date(now - 3 * 3_600_000), TZ), toDay: day, timezone: TZ }))
      .flatMap((d) => d.readings)
      .find((r) => r.pulse === 120);
    expect(late?.late).toBe(true);

    expect(await getLatestVitals(hospitalId, fresh)).toMatchObject({ urineMl: 300 });
  });

  it('shows nothing without the clinical key, and nothing to another hospital', async () => {
    const withoutKey = await withTenant(hospitalId, (tx) => tx.select({ id: chartEntries.id }).from(chartEntries));
    expect(withoutKey).toEqual([]);
    const other = await withTenant(otherHospitalId, (tx) => tx.select({ id: chartEntries.id }).from(chartEntries), { clinical: true });
    expect(other).toEqual([]);
    const own = await withTenant(hospitalId, (tx) => tx.select({ id: chartEntries.id }).from(chartEntries), { clinical: true });
    expect(own.length).toBeGreaterThan(0);
  });

  it('keeps the monthly partitions out of reach except through the chart', async () => {
    const app = postgres(appUrl!, { max: 1 });
    try {
      const [{ partition }] = await admin`
        select c.relname as partition from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'chart_entries'::regclass and c.relname = ${'chart_entries_' + new Date().toISOString().slice(0, 7).replace('-', '')}`;
      const rows = await app.begin(async (tx) => {
        await tx`select set_config('app.hospital_id', ${hospitalId}, true), set_config('app.clinical_access', 'true', true)`;
        return tx.unsafe(`select id from ${partition}`);
      });
      expect(rows).toEqual([]);
    } finally {
      await app.end();
    }
  });

  it('makes the months ahead once, and is a no-op after', async () => {
    await admin`select public.ensure_monthly_partitions('chart_entries', 0, 12)`;
    const [{ created }] = await admin`select public.ensure_monthly_partitions('chart_entries', 0, 12) as created`;
    expect(created).toBe(0);
  });
});
