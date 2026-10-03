import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { createDirectAdmission, setDischargeReady } from '@/lib/services/admissions';
import { DoctorIpdError, getTestChips, listMyAdmittedPatients, orderTests } from '@/lib/services/doctor-ipd';
import { addStarterChargeItems, createWard, listChargeItems } from '@/lib/services/ipd-config';

/**
 * The doctor's phone view (T3.1) against a real database: a doctor sees
 * their own admitted patients, gets the starter tests as chips on day one,
 * orders tests once however often the form is sent, and cannot order
 * consumables or for another doctor's patient.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Doctor IPD Test Hospital';

describe.skipIf(!enabled)('doctor phone view', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const otherDoctorId = uuid();
  const doctorUserId = uuid();
  const otherUserId = uuid();
  let admissionId = '';

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'di-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into users (id, email, password_hash, name) values
      (${doctorUserId}, ${'doc-' + doctorUserId + '@doctoripd.test'}, 'x', 'Dr Patil'),
      (${otherUserId}, ${'doc-' + otherUserId + '@doctoripd.test'}, 'x', 'Dr Other')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, user_id, default_consult_minutes) values
      (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Patil', ${doctorUserId}, 10),
      (${otherDoctorId}, ${hospitalId}, ${branchId}, 'Dr Other', ${otherUserId}, 10)`;
    await addStarterChargeItems({ hospitalId, actorUserId: doctorUserId });
    const { wardId } = await createWard({ hospitalId, branchId, name: 'Ward A', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: doctorUserId });
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId,
      patient: { phoneE164: '+919300000001', name: 'Asha Kulkarni' },
      bedId: bed.id as string,
      actorUserId: doctorUserId,
    }));
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@doctoripd.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('shows a doctor their own admitted patients only', async () => {
    const mine = await listMyAdmittedPatients({ hospitalId, userId: doctorUserId, seeAll: false });
    expect(mine.patients.map((p) => p.patientName)).toEqual(['Asha Kulkarni']);
    const theirs = await listMyAdmittedPatients({ hospitalId, userId: otherUserId, seeAll: false });
    expect(theirs.patients).toEqual([]);
  });

  it('offers the starter tests as chips before there is any history', async () => {
    const chips = await getTestChips(hospitalId);
    expect(chips).toHaveLength(10);
    expect(chips[0].name).toBe('CBC');
  });

  it('orders tests once per form, refuses non-tests and other doctors’ patients', async () => {
    const chips = await getTestChips(hospitalId);
    const formKey = uuid();
    const ids = [chips[0].id, chips[1].id];
    await orderTests({ hospitalId, admissionId, chargeItemIds: ids, formKey, actorUserId: doctorUserId, seeAll: false });
    await orderTests({ hospitalId, admissionId, chargeItemIds: ids, formKey, actorUserId: doctorUserId, seeAll: false });
    const [{ n }] = await admin`select count(*)::int as n from care_entries where admission_id = ${admissionId}`;
    expect(n).toBe(2);

    const { rows } = await listChargeItems({ hospitalId, query: 'syringe 5' });
    await expect(
      orderTests({ hospitalId, admissionId, chargeItemIds: [rows[0].id], formKey: uuid(), actorUserId: doctorUserId, seeAll: false }),
    ).rejects.toBeInstanceOf(DoctorIpdError);
    await expect(
      orderTests({ hospitalId, admissionId, chargeItemIds: [chips[2].id], formKey: uuid(), actorUserId: otherUserId, seeAll: false }),
    ).rejects.toBeInstanceOf(DoctorIpdError);
  });

  it('marks discharge ready in one step, and the list says so', async () => {
    await setDischargeReady({ hospitalId, admissionId, ready: true, actorUserId: doctorUserId });
    const mine = await listMyAdmittedPatients({ hospitalId, userId: doctorUserId, seeAll: false });
    expect(mine.patients[0].status).toBe('discharge_ready');
  });
});
