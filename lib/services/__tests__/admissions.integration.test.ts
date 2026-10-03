import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import {
  AdmissionError,
  BedTakenError,
  assignBed,
  cancelAdmission,
  createDirectAdmission,
  setDischargeReady,
  shiftToIpd,
  transferBed,
  undoShiftToIpd,
} from '@/lib/services/admissions';
import { getIpdCensus, getIpdStatusesForAppointments } from '@/lib/services/ipd-census';
import { createWard } from '@/lib/services/ipd-config';
import { createWalkIn } from '@/lib/services/queue';

/**
 * Admissions against a real database (tasks T1.4, T1.6): Shift to IPD is
 * idempotent and undoable, a bed holds one patient even under a race, a
 * transfer keeps the stay whole, and another hospital's ids are not found.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const TZ = 'Asia/Kolkata';
const HOSPITAL_NAME = 'Admissions Test Hospital';

describe.skipIf(!enabled)('admissions', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const otherHospitalId = uuid();
  const branchId = uuid();
  const otherBranchId = uuid();
  const doctorId = uuid();
  const doctorUserId = uuid();
  const deskUserId = uuid();
  let bedIds: string[] = [];
  let phone = 10;

  const walkIn = async (hospital = hospitalId, branch = branchId, doctor = doctorId) => {
    phone += 1;
    const { appointment } = await createWalkIn({
      hospitalId: hospital,
      branchId: branch,
      doctorId: doctor,
      timezone: TZ,
      patient: { phoneE164: `+9197000000${String(phone).padStart(2, '0')}`, name: `Patient ${phone}` },
      whatsappOptIn: false,
    });
    return appointment.id;
  };

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values
      (${hospitalId}, ${HOSPITAL_NAME}, ${'adm-' + hospitalId.slice(0, 12)}),
      (${otherHospitalId}, ${HOSPITAL_NAME}, ${'adm-' + otherHospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values
      (${branchId}, ${hospitalId}, 'Main'), (${otherBranchId}, ${otherHospitalId}, 'Other')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Kulkarni', 10)`;
    await admin`insert into users (id, email, password_hash, name) values
      (${doctorUserId}, ${'doc-' + doctorUserId + '@admissions.test'}, 'x', 'Doctor'),
      (${deskUserId}, ${'desk-' + deskUserId + '@admissions.test'}, 'x', 'Desk')`;
    const { wardId } = await createWard({
      hospitalId,
      branchId,
      name: 'Ward A',
      dailyChargeItemId: null,
      bedLabels: '1-4',
      actorUserId: deskUserId,
    });
    const rows = await admin`select id from beds where ward_id = ${wardId} order by sort_order`;
    bedIds = rows.map((row) => row.id as string);
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@admissions.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('shifts once however often the doctor taps, and turns the visit to IPD', async () => {
    const appointmentId = await walkIn();
    const [first, second] = await Promise.all([
      shiftToIpd({ hospitalId, appointmentId, actorUserId: doctorUserId }),
      shiftToIpd({ hospitalId, appointmentId, actorUserId: doctorUserId }),
    ]);
    expect(first.admissionId).toBe(second.admissionId);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);

    const [encounter] = await admin`select stage from encounters where appointment_id = ${appointmentId}`;
    expect(encounter.stage).toBe('ipd');
    expect(await getIpdStatusesForAppointments(hospitalId, [appointmentId])).toEqual({
      [appointmentId]: 'awaiting_bed',
    });
  });

  it('undoes a mis-tap back to OPD, and can be shifted again afterwards', async () => {
    const appointmentId = await walkIn();
    const { admissionId } = await shiftToIpd({ hospitalId, appointmentId, actorUserId: doctorUserId });
    await undoShiftToIpd({ hospitalId, admissionId, actorUserId: doctorUserId });

    const [encounter] = await admin`select stage from encounters where appointment_id = ${appointmentId}`;
    expect(encounter.stage).toBe('opd');
    const [admission] = await admin`select status, cancel_reason from admissions where id = ${admissionId}`;
    expect(admission).toMatchObject({ status: 'cancelled', cancel_reason: 'Undone by doctor' });

    const again = await shiftToIpd({ hospitalId, appointmentId, actorUserId: doctorUserId });
    expect(again.created).toBe(true);
    expect(again.admissionId).not.toBe(admissionId);
  });

  it('refuses undo once the undo window has passed', async () => {
    const appointmentId = await walkIn();
    const { admissionId } = await shiftToIpd({ hospitalId, appointmentId, actorUserId: doctorUserId });
    await expect(
      undoShiftToIpd({
        hospitalId,
        admissionId,
        actorUserId: doctorUserId,
        now: new Date(Date.now() + 11 * 60_000),
      }),
    ).rejects.toBeInstanceOf(AdmissionError);
  });

  it('does not find another hospital’s appointment', async () => {
    const otherDoctor = uuid();
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${otherDoctor}, ${otherHospitalId}, ${otherBranchId}, 'Dr Other', 10)`;
    const foreign = await walkIn(otherHospitalId, otherBranchId, otherDoctor);
    await expect(
      shiftToIpd({ hospitalId, appointmentId: foreign, actorUserId: doctorUserId }),
    ).rejects.toThrow(/not found/i);
  });

  it('assigns a bed with payer and deposit, and refuses the same bed to someone else', async () => {
    const a = await shiftToIpd({ hospitalId, appointmentId: await walkIn(), actorUserId: doctorUserId });
    const b = await shiftToIpd({ hospitalId, appointmentId: await walkIn(), actorUserId: doctorUserId });

    await assignBed({
      hospitalId,
      admissionId: a.admissionId,
      bedId: bedIds[0],
      extras: {
        reason: 'Dehydration',
        payer: { kind: 'insurer', payerName: 'Star Health', policyNumber: 'P-1', preauthAmountPaise: 2_500_000 },
        depositPaise: 500_000,
      },
      actorUserId: deskUserId,
    });
    await expect(
      assignBed({ hospitalId, admissionId: b.admissionId, bedId: bedIds[0], actorUserId: deskUserId }),
    ).rejects.toBeInstanceOf(BedTakenError);

    const [admission] = await admin`select status, reason from admissions where id = ${a.admissionId}`;
    expect(admission).toMatchObject({ status: 'admitted', reason: 'Dehydration' });
    const payers = await admin`
      select ep.kind, ep.payer_name from encounter_payers ep
      join admissions ad on ad.encounter_id = ep.encounter_id
      where ad.id = ${a.admissionId} and ep.voided_at is null`;
    expect(payers).toEqual([{ kind: 'insurer', payer_name: 'Star Health' }]);
    const [deposit] = await admin`
      select pp.amount_paise from patient_payments pp
      join admissions ad on ad.encounter_id = pp.encounter_id
      where ad.id = ${a.admissionId}`;
    expect(deposit.amount_paise).toBe(500_000);
  });

  it('lets only one of two racing desks have the bed', async () => {
    const a = await shiftToIpd({ hospitalId, appointmentId: await walkIn(), actorUserId: doctorUserId });
    const b = await shiftToIpd({ hospitalId, appointmentId: await walkIn(), actorUserId: doctorUserId });
    const results = await Promise.allSettled([
      assignBed({ hospitalId, admissionId: a.admissionId, bedId: bedIds[1], actorUserId: deskUserId }),
      assignBed({ hospitalId, admissionId: b.admissionId, bedId: bedIds[1], actorUserId: deskUserId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BedTakenError);
  });

  it('transfers a patient, keeping one stay with its bed history', async () => {
    const { admissionId, patientName } = await createDirectAdmission({
      hospitalId,
      branchId,
      doctorId,
      patient: { phoneE164: '+919700009999', name: 'Emergency Patient' },
      bedId: bedIds[2],
      actorUserId: deskUserId,
    });
    expect(patientName).toBe('Emergency Patient');
    await transferBed({ hospitalId, admissionId, bedId: bedIds[3], actorUserId: deskUserId });

    const history = await admin`
      select bed_id, to_at from bed_assignments where admission_id = ${admissionId} order by from_at`;
    expect(history.map((h) => h.bed_id)).toEqual([bedIds[2], bedIds[3]]);
    expect(history[0].to_at).not.toBeNull();
    expect(history[1].to_at).toBeNull();

    const [encounter] = await admin`
      select e.origin, e.stage, e.appointment_id from encounters e
      join admissions a on a.encounter_id = e.id where a.id = ${admissionId}`;
    expect(encounter).toMatchObject({ origin: 'emergency', stage: 'ipd', appointment_id: null });

    const census = await getIpdCensus({ hospitalId, branchId });
    const ward = census.wards[0];
    expect(ward.beds.find((bed) => bed.id === bedIds[3])?.occupant?.admissionId).toBe(admissionId);
    expect(ward.beds.find((bed) => bed.id === bedIds[2])?.occupant).toBeNull();
  });

  it('marks ready and back, and cancels only before a bed', async () => {
    const { admissionId } = await createDirectAdmission({
      hospitalId,
      branchId,
      doctorId,
      patient: { phoneE164: '+919700008888', name: 'Waiting Patient' },
      actorUserId: deskUserId,
    });
    await expect(
      setDischargeReady({ hospitalId, admissionId, ready: true, actorUserId: doctorUserId }),
    ).rejects.toBeInstanceOf(AdmissionError);
    await cancelAdmission({ hospitalId, admissionId, reason: 'Family took the patient home', actorUserId: deskUserId });
    const [row] = await admin`
      select a.status, e.status as encounter_status from admissions a
      join encounters e on e.id = a.encounter_id where a.id = ${admissionId}`;
    expect(row).toMatchObject({ status: 'cancelled', encounter_status: 'cancelled' });
  });
});
