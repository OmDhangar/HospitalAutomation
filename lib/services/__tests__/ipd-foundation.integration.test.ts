import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { hospitalFeatures } from '@/lib/db/schema';
import { assignBed, createDirectAdmission } from '@/lib/services/admissions';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { createWard } from '@/lib/services/ipd-config';
import { getIpdNumberState, setNextIpdNumber } from '@/lib/services/ipd-number';
import { getLetterhead, updateDoctorLetterhead, updateHospitalLetterhead } from '@/lib/services/letterhead';
import { ModuleConfigError, getModuleStates, setModuleState } from '@/lib/services/modules';
import { logRecordAccess } from '@/lib/services/record-access';

/**
 * Phase A4-min against a real database (IPD sheets plan §11.1, migration 0041):
 * IPD numbers are given once, in order, never reused, and continue from the
 * paper register; the letterhead prints what the owner set; module rows are
 * tenant-isolated and core modules cannot be switched off; reads of a file are
 * logged once per ten minutes.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'IPD Foundation Test Hospital';

describe.skipIf(!enabled)('IPD foundation (0041)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const otherHospitalId = uuid();
  const branchId = uuid();
  const otherBranchId = uuid();
  const doctorId = uuid();
  const deskUserId = uuid();
  let bedIds: string[] = [];
  let phone = 10;

  const admitDirect = async (bedId: string | null) => {
    phone += 1;
    return createDirectAdmission({
      hospitalId,
      branchId,
      doctorId,
      patient: { phoneE164: `+9196000000${String(phone).padStart(2, '0')}`, name: `Patient ${phone}` },
      bedId,
      actorUserId: deskUserId,
    });
  };

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values
      (${hospitalId}, ${HOSPITAL_NAME}, ${'fnd-' + hospitalId.slice(0, 12)}),
      (${otherHospitalId}, ${HOSPITAL_NAME}, ${'fnd-' + otherHospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name, address) values
      (${branchId}, ${hospitalId}, 'Main', 'Ram Complex, Shirpur'), (${otherBranchId}, ${otherHospitalId}, 'Other', null)`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr. Vinod Pawara', 10)`;
    await admin`insert into users (id, email, password_hash, name) values
      (${deskUserId}, ${'desk-' + deskUserId + '@foundation.test'}, 'x', 'Desk')`;
    const { wardId } = await createWard({
      hospitalId,
      branchId,
      name: 'General ward',
      dailyChargeItemId: null,
      bedLabels: '1-8',
      actorUserId: deskUserId,
    });
    bedIds = (await admin`select id from beds where ward_id = ${wardId} order by sort_order`).map((row) => row.id as string);
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@foundation.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  const ipdNumberOf = async (admissionId: string) =>
    (await getAdmissionSummary(hospitalId, admissionId))!.ipdNumber;

  it('gives no number until a bed, then the next one', async () => {
    const waiting = await admitDirect(null);
    expect(await ipdNumberOf(waiting.admissionId)).toBeNull();
    await assignBed({ hospitalId, admissionId: waiting.admissionId, bedId: bedIds[0], actorUserId: deskUserId });
    expect(await ipdNumberOf(waiting.admissionId)).toBe(1);

    const direct = await admitDirect(bedIds[1]);
    expect(await ipdNumberOf(direct.admissionId)).toBe(2);
  });

  it('continues from the paper register, numbering patients already in a bed first, and never goes back', async () => {
    // A patient admitted before numbering existed: in a bed, no number.
    const legacy = await admitDirect(bedIds[2]);
    await admin`update admissions set ipd_number = null where id = ${legacy.admissionId}`;

    const result = await setNextIpdNumber({ hospitalId, next: '6159', actorUserId: deskUserId });
    expect(result).toEqual({ next: 6159, numbered: 1 });
    expect(await ipdNumberOf(legacy.admissionId)).toBe(6159);

    const after = await admitDirect(bedIds[3]);
    expect(await ipdNumberOf(after.admissionId)).toBe(6160);

    await expect(setNextIpdNumber({ hospitalId, next: '6100', actorUserId: deskUserId })).rejects.toThrow(/6161 or more/);
    expect(await getIpdNumberState(hospitalId)).toEqual({ lastNumber: 6160, highestGiven: 6160, unnumbered: 0 });
  });

  it('gives different numbers to admissions confirmed at the same moment', async () => {
    const [a, b, c] = await Promise.all([admitDirect(bedIds[4]), admitDirect(bedIds[5]), admitDirect(bedIds[6])]);
    const numbers = await Promise.all([a, b, c].map((x) => ipdNumberOf(x.admissionId)));
    expect(new Set(numbers).size).toBe(3);
    expect(numbers.every((n) => n !== null && n > 6160)).toBe(true);
  });

  it('refuses a second admission with the same IPD number in one hospital (database)', async () => {
    const rows = await admin`select id, ipd_number from admissions where hospital_id = ${hospitalId} and ipd_number is not null limit 2`;
    await expect(
      admin`update admissions set ipd_number = ${rows[0].ipd_number} where id = ${rows[1].id}`,
    ).rejects.toThrow(/admissions_ipd_number_key/);
  });

  it('prints the letterhead the owner set', async () => {
    await updateHospitalLetterhead({ hospitalId, registrationNo: ' GHD/BNH/136/2022 ', phones: '02563-299446', actorUserId: deskUserId });
    await updateDoctorLetterhead({
      hospitalId,
      doctorId,
      qualification: 'MBBS, MD (Medicine)',
      registrationNo: '2015074070',
      onLetterhead: true,
      actorUserId: deskUserId,
    });
    expect(await getLetterhead(hospitalId, branchId)).toEqual({
      hospitalName: HOSPITAL_NAME,
      branchName: null,
      address: 'Ram Complex, Shirpur',
      phones: '02563-299446',
      registrationNo: 'GHD/BNH/136/2022',
      doctors: [{ name: 'Dr. Vinod Pawara', qualification: 'MBBS, MD (Medicine)', registrationNo: '2015074070' }],
    });
    await expect(
      updateDoctorLetterhead({ hospitalId: otherHospitalId, doctorId, qualification: 'X', actorUserId: deskUserId }),
    ).rejects.toThrow();
  });

  it('keeps core modules on and refuses to switch them off', async () => {
    await expect(
      setModuleState({ hospitalId, moduleId: 'core_ipd', state: 'off', actorUserId: deskUserId }),
    ).rejects.toThrow(ModuleConfigError);
    await expect(
      setModuleState({ hospitalId, moduleId: 'no_such_module', state: 'off', actorUserId: deskUserId }),
    ).rejects.toThrow(ModuleConfigError);
    // A stored row for a core module (e.g. written by hand) changes nothing.
    await admin`insert into hospital_features (hospital_id, module_id, state) values (${hospitalId}, 'patient_file', 'off')`;
    expect((await getModuleStates(hospitalId)).get('patient_file')?.state).toBe('on');
  });

  it('keeps one hospital’s module rows from another (RLS)', async () => {
    const seen = await withTenant(otherHospitalId, (tx) => tx.select().from(hospitalFeatures));
    expect(seen).toEqual([]);
    await expect(
      withTenant(otherHospitalId, (tx) =>
        tx.insert(hospitalFeatures).values({ hospitalId, moduleId: 'letterhead', state: 'off' }),
      ),
    ).rejects.toThrow();
  });

  it('refuses invalid module rows (database checks)', async () => {
    await expect(admin`insert into hospital_features (hospital_id, module_id, state) values (${hospitalId}, 'x', 'on')`).rejects.toThrow();
    await expect(admin`insert into hospital_features (hospital_id, module_id, state) values (${hospitalId}, 'tpr', 'maybe')`).rejects.toThrow();
  });

  it('logs a file view once per ten minutes, and every print', async () => {
    const stay = await admitDirect(bedIds[7]);
    const summary = (await getAdmissionSummary(hospitalId, stay.admissionId))!;
    const args = {
      hospitalId,
      actorUserId: deskUserId,
      patientId: summary.patientId,
      encounterId: summary.encounterId,
    };
    expect(await logRecordAccess({ ...args, action: 'view_admission', dedupeMinutes: 10 })).toBe(true);
    expect(await logRecordAccess({ ...args, action: 'view_admission', dedupeMinutes: 10 })).toBe(false);
    expect(await logRecordAccess({ ...args, action: 'print_ipd_file' })).toBe(true);
    expect(await logRecordAccess({ ...args, action: 'print_ipd_file' })).toBe(true);
    const [{ views, prints }] = await admin<{ views: number; prints: number }[]>`
      select count(*) filter (where action = 'view_admission')::int as views,
             count(*) filter (where action = 'print_ipd_file')::int as prints
      from record_access_logs where patient_id = ${summary.patientId}`;
    expect({ views, prints }).toEqual({ views: 1, prints: 2 });
  });

  it('refuses an unknown access-log action even though the check is NOT VALID', async () => {
    const [row] = await admin`select patient_id from admissions where hospital_id = ${hospitalId} limit 1`;
    await expect(
      admin`insert into record_access_logs (hospital_id, patient_id, action) values (${hospitalId}, ${row.patient_id}, 'peek')`,
    ).rejects.toThrow(/record_access_logs_action_check/);
  });

  it('keeps a policy acknowledgement as it was written', async () => {
    const [ack] = await admin`insert into policy_acknowledgements (hospital_id, user_id, policy_key, policy_version, locale)
      values (${hospitalId}, ${deskUserId}, 'monitoring_notice', '2026-10', 'mr') returning id`;
    await expect(admin`update policy_acknowledgements set locale = 'en' where id = ${ack.id}`).rejects.toThrow(/append-only/);
  });
});
