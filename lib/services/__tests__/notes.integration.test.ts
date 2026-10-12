import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { parseNote } from '@/lib/domain/notes';
import { hashPassword } from '@/lib/security/password';
import { createDirectAdmission } from '@/lib/services/admissions';
import { createWard } from '@/lib/services/ipd-config';
import { countersignNote, getNoteContext, listNotes, listNotesAwaitingCountersign, strikeOutNote, writeNote } from '@/lib/services/notes';
import { recordTprEntries } from '@/lib/services/tpr';

/**
 * The doctor's notes against a real database (IPD sheets plan C3, migration
 * 0052): the case sheet once per stay, progress notes; signed when written by
 * the doctor named, else countersigned by that doctor only; the O/E vitals
 * confirming a recent chart reading or writing one; strike-out takes a
 * written reading with it; the guards.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Notes Test Hospital';

describe.skipIf(!enabled)('doctor’s notes (0052)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const [doctorA, doctorB] = [uuid(), uuid()];
  const [ownerUser, doctorUserA, doctorUserB, nurseUser] = [uuid(), uuid(), uuid(), uuid()];
  let admissionId = '';

  const write = (input: Parameters<typeof parseNote>[0], extra: Partial<Parameters<typeof writeNote>[0]> = {}) =>
    writeNote({
      hospitalId,
      admissionId,
      input: parseNote(input),
      seenByDoctorId: doctorA,
      actorUserId: doctorUserA,
      mayTranscribe: false,
      chart: true,
      clientId: uuid(),
      ...extra,
    });

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'nt-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    const hash = await hashPassword('correct horse battery');
    await admin`insert into users (id, email, password_hash, name, last_login_at) values
      (${ownerUser}, ${'o-' + ownerUser + '@nt.test'}, ${hash}, 'Owner', now()),
      (${doctorUserA}, ${'a-' + doctorUserA + '@nt.test'}, ${hash}, 'Dr Kulkarni', now()),
      (${doctorUserB}, ${'b-' + doctorUserB + '@nt.test'}, ${hash}, 'Dr Shaikh', now()),
      (${nurseUser}, ${'n-' + nurseUser + '@nt.test'}, ${hash}, 'Sister Lata', now())`;
    await admin`insert into staff_memberships (user_id, hospital_id, role) values
      (${ownerUser}, ${hospitalId}, 'owner'), (${doctorUserA}, ${hospitalId}, 'doctor'), (${doctorUserB}, ${hospitalId}, 'doctor'), (${nurseUser}, ${hospitalId}, 'nurse')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, user_id, default_consult_minutes) values
      (${doctorA}, ${hospitalId}, ${branchId}, 'Dr Kulkarni', ${doctorUserA}, 10),
      (${doctorB}, ${hospitalId}, ${branchId}, 'Dr Shaikh', ${doctorUserB}, 10)`;
    const { wardId } = await createWard({ hospitalId, branchId, name: 'Ward N', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: ownerUser });
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId: doctorA,
      patient: { phoneE164: '+919300000066', name: 'Kiran Wagh' },
      bedId: bed.id as string,
      actorUserId: ownerUser,
    }));
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ['ipd_notes', 'chart_entries']) {
        await tx.unsafe(`delete from ${table} where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      }
    });
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@nt.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('writes the case sheet once, and puts vitals with no recent reading on the chart', async () => {
    const seenAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const first = await write({
      kind: 'admission',
      seenAt,
      caseOf: 'Dengue fever with thrombocytopenia',
      complaints: [{ text: 'Fever', duration: '4 days' }, { text: 'Body ache', duration: '3 days' }],
      vitals: { pulse: '110', bp: '96/60', temp: '101.4' },
      systemicExam: { cns: 'NAD', rs: 'NAD', pa: 'Soft, mild tenderness', cvs: 'NAD' },
      advice: 'Platelet count 12-hourly; IV fluids',
    });
    expect(first).toMatchObject({ transcribed: false, chart: 'written', repeat: false });
    const [reading] = await admin`select pulse, bp_systolic, temp_f_tenths, source from chart_entries where admission_id = ${admissionId}`;
    expect(reading).toEqual({ pulse: 110, bp_systolic: 96, temp_f_tenths: 1014, source: 'doctor_note' });
    await expect(write({ kind: 'admission', caseOf: 'Again' })).rejects.toThrow(/already written/);
    expect((await getNoteContext(hospitalId, admissionId)).hasAdmissionNote).toBe(true);
  });

  it('confirms a recent reading the doctor kept, and writes a new one when changed', async () => {
    await recordTprEntries({
      hospitalId,
      actorUserId: nurseUser,
      entries: [{ clientId: uuid(), admissionId, observedAt: new Date(Date.now() - 30 * 60_000).toISOString(), pulse: 96, spo2: 97 }],
    });
    const context = await getNoteContext(hospitalId, admissionId);
    expect(context.recent?.vitals).toEqual({ pulse: 96, spo2: 97 });
    const kept = await write({ kind: 'progress', progress: 'Afebrile overnight', vitals: { pulse: '96', spo2: '97' } });
    expect(kept.chart).toBe('confirmed');
    const changed = await write({ kind: 'progress', progress: 'Rash appeared', vitals: { pulse: '102', spo2: '97' } });
    expect(changed.chart).toBe('written');
    const off = await write({ kind: 'progress', advice: 'Repeat CBC', vitals: { pulse: '90' } }, { chart: false });
    expect(off.chart).toBe('off');
    const [{ n }] = await admin`select count(*)::int as n from chart_entries where admission_id = ${admissionId} and source = 'doctor_note'`;
    expect(n).toBe(2);
  });

  it('holds a transcribed note for the named doctor’s countersign, and no one else’s', async () => {
    await expect(write({ kind: 'progress', progress: 'Seen on round' }, { actorUserId: nurseUser })).rejects.toThrow(/Only the doctor named/);
    const phoned = await write({ kind: 'progress', progress: 'Telephone advice: start paracetamol SOS' }, { actorUserId: nurseUser, mayTranscribe: true });
    expect(phoned.transcribed).toBe(true);
    expect((await listNotesAwaitingCountersign({ hospitalId, userId: doctorUserA })).map((n) => n.id)).toEqual([phoned.noteId]);
    await expect(countersignNote({ hospitalId, noteId: phoned.noteId, actorUserId: doctorUserB })).rejects.toThrow(/Only the doctor named/);
    await countersignNote({ hospitalId, noteId: phoned.noteId, actorUserId: doctorUserA });
    await countersignNote({ hospitalId, noteId: phoned.noteId, actorUserId: doctorUserA });
    expect(await listNotesAwaitingCountersign({ hospitalId, userId: doctorUserA })).toEqual([]);
    const signed = (await listNotes(hospitalId, admissionId)).find((n) => n.id === phoned.noteId)!;
    expect(signed).toMatchObject({ transcribed: true, countersignedBy: 'Dr Kulkarni', writtenBy: 'Sister Lata' });
  });

  it('strikes out a note with the reading it wrote; lists the case sheet first', async () => {
    const notes = await listNotes(hospitalId, admissionId);
    expect(notes[0].kind).toBe('admission');
    const rash = notes.find((n) => n.progress === 'Rash appeared')!;
    await expect(strikeOutNote({ hospitalId, noteId: rash.id, reason: 'Wrong patient', actorUserId: doctorUserB, isOwner: false })).rejects.toThrow(/Only whoever wrote/);
    await strikeOutNote({ hospitalId, noteId: rash.id, reason: 'Wrong patient', actorUserId: doctorUserA, isOwner: false });
    const live = await admin`select pulse from chart_entries where admission_id = ${admissionId} and voided_at is null order by observed_at`;
    expect(live.map((r) => r.pulse)).toEqual([110, 96]);
    // The confirmed reading stays when its note goes.
    const kept = notes.find((n) => n.progress === 'Afebrile overnight')!;
    await strikeOutNote({ hospitalId, noteId: kept.id, reason: 'Duplicate', actorUserId: ownerUser, isOwner: true });
    expect((await admin`select count(*)::int as n from chart_entries where admission_id = ${admissionId} and voided_at is null`)[0].n).toBe(2);
  });

  it('holds notes in the database', async () => {
    const [note] = await admin`select id from ipd_notes where hospital_id = ${hospitalId} and voided_at is null limit 1`;
    await expect(admin`update ipd_notes set advice = 'changed' where id = ${note.id}`).rejects.toThrow(/cannot be edited/);
    await expect(admin`delete from ipd_notes where id = ${note.id}`).rejects.toThrow(/never deleted/);
    const [evidence] = await admin`select count(*)::int as n from acct_events where hospital_id = ${hospitalId} and object_type = 'ipd_note'`;
    expect(evidence.n).toBeGreaterThan(5);
  });
});
