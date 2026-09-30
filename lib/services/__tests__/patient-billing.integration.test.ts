import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { billItems, bills, patientPayments, patients } from '@/lib/db/schema';
import {
  ConsultationFeeMissingError,
  getPaymentStatusesInTx,
  setConsultationPaid,
  setDoctorConsultationFee,
} from '@/lib/services/patient-billing';
import { createWalkIn } from '@/lib/services/queue';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const TZ = 'Asia/Kolkata';
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Billing Test Hospital';

/**
 * Drizzle wraps a failed query in its own error and keeps the Postgres one as
 * the cause, so the trigger or constraint name is never in `message`. Asserting
 * on the whole chain is what makes these tests prove *which* guard fired,
 * rather than merely that the write failed for some reason.
 */
const rejectsWith = async (work: Promise<unknown>, pattern: RegExp) => {
  const chain: string[] = [];
  try {
    await work;
  } catch (err) {
    for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
      if (e.message) chain.push(e.message);
    }
    expect(chain.join(' | ')).toMatch(pattern);
    return;
  }
  throw new Error(`expected a rejection matching ${pattern}, but it succeeded`);
};

describe.skipIf(!enabled)('patient billing', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 4 }) : (null as never);
  let hospitalId: string;
  let branchId: string;
  let doctorId: string;
  let ownerId: string;

  const seedHospital = async () => {
    const h = uuid();
    const b = uuid();
    const d = uuid();
    await admin`insert into hospitals (id, name, slug) values (${h}, ${HOSPITAL_NAME}, ${'bt-' + h.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${b}, ${h}, 'Main')`;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${d}, ${h}, ${b}, 'Dr Sharma', 10)
    `;
    return { hospitalId: h, branchId: b, doctorId: d };
  };

  const walkIn = (n: number, extra: { address?: string | null } = {}) =>
    createWalkIn({
      hospitalId,
      branchId,
      doctorId,
      timezone: TZ,
      patient: {
        phoneE164: `+9198000000${String(n).padStart(2, '0')}`,
        name: `Patient ${n}`,
        ...extra,
      },
      whatsappOptIn: false,
    });

  const itemsFor = (appointmentId: string) =>
    withTenant(hospitalId, (tx) =>
      tx.select().from(billItems).where(eq(billItems.appointmentId, appointmentId)),
    );

  beforeEach(async () => {
    ({ hospitalId, branchId, doctorId } = await seedHospital());
    ownerId = uuid();
    await admin`
      insert into users (id, email, password_hash, name)
      values (${ownerId}, ${'owner-' + ownerId + '@billing.test'}, 'x', 'Owner')
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@billing.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('refuses to mark paid before the doctor has a fee', async () => {
    const { appointment } = await walkIn(1);
    await expect(
      setConsultationPaid({ hospitalId, appointmentId: appointment.id, paid: true, actorUserId: ownerId }),
    ).rejects.toBeInstanceOf(ConsultationFeeMissingError);
  });

  it('charges the consultation once and records one payment, however often Paid is tapped', async () => {
    await setDoctorConsultationFee({ hospitalId, doctorId, pricePaise: 30_000, actorUserId: ownerId });
    const { appointment } = await walkIn(1);

    const [first, second] = await Promise.all([
      setConsultationPaid({ hospitalId, appointmentId: appointment.id, paid: true, actorUserId: ownerId }),
      setConsultationPaid({ hospitalId, appointmentId: appointment.id, paid: true, actorUserId: ownerId }),
    ]);
    expect(first.status).toBe('paid');
    expect(second.status).toBe('paid');

    const items = await itemsFor(appointment.id);
    expect(items).toHaveLength(1);
    expect(items[0].unitPricePaise).toBe(30_000);
    expect(items[0].configuredUnitPricePaise).toBe(30_000);

    const payments = await withTenant(hospitalId, (tx) => tx.select().from(patientPayments));
    expect(payments).toHaveLength(1);
    expect(payments[0].amountPaise).toBe(30_000);
  });

  it('marks unpaid by voiding the payment, keeping both the charge and the record', async () => {
    await setDoctorConsultationFee({ hospitalId, doctorId, pricePaise: 30_000, actorUserId: ownerId });
    const { appointment } = await walkIn(1);
    await setConsultationPaid({ hospitalId, appointmentId: appointment.id, paid: true, actorUserId: ownerId });

    const after = await setConsultationPaid({
      hospitalId,
      appointmentId: appointment.id,
      paid: false,
      actorUserId: ownerId,
    });
    expect(after.status).toBe('unpaid');

    const payments = await withTenant(hospitalId, (tx) => tx.select().from(patientPayments));
    expect(payments).toHaveLength(1);
    expect(payments[0].voidedAt).not.toBeNull();
    expect(await itemsFor(appointment.id)).toHaveLength(1);
  });

  it('keeps the old price on old bills after the fee changes', async () => {
    await setDoctorConsultationFee({ hospitalId, doctorId, pricePaise: 20_000, actorUserId: ownerId });
    const { appointment: before } = await walkIn(1);
    await setConsultationPaid({ hospitalId, appointmentId: before.id, paid: true, actorUserId: ownerId });

    await setDoctorConsultationFee({ hospitalId, doctorId, pricePaise: 25_000, actorUserId: ownerId });
    const { appointment: after } = await walkIn(2);
    await setConsultationPaid({ hospitalId, appointmentId: after.id, paid: true, actorUserId: ownerId });

    expect((await itemsFor(before.id))[0].totalPaise).toBe(20_000);
    expect((await itemsFor(after.id))[0].totalPaise).toBe(25_000);
  });

  it('reports a status for every appointment on screen in one query', async () => {
    await setDoctorConsultationFee({ hospitalId, doctorId, pricePaise: 30_000, actorUserId: ownerId });
    const { appointment: paid } = await walkIn(1);
    const { appointment: untouched } = await walkIn(2);
    await setConsultationPaid({ hospitalId, appointmentId: paid.id, paid: true, actorUserId: ownerId });

    const statuses = await withTenant(hospitalId, (tx) =>
      getPaymentStatusesInTx(tx, [paid.id, untouched.id]),
    );
    expect(statuses[paid.id]).toBe('paid');
    // No encounter yet: absent, which the dashboard reads as unpaid.
    expect(statuses[untouched.id]).toBeUndefined();
  });

  it('refuses to edit a bill item, and refuses new items on a final bill', async () => {
    await setDoctorConsultationFee({ hospitalId, doctorId, pricePaise: 30_000, actorUserId: ownerId });
    const { appointment } = await walkIn(1);
    await setConsultationPaid({ hospitalId, appointmentId: appointment.id, paid: true, actorUserId: ownerId });
    const [item] = await itemsFor(appointment.id);

    await rejectsWith(
      withTenant(hospitalId, (tx) =>
        tx
          .update(billItems)
          .set({ unitPricePaise: 1, subtotalPaise: 1, totalPaise: 1 })
          .where(eq(billItems.id, item.id)),
      ),
      /only be voided/,
    );

    await withTenant(hospitalId, (tx) =>
      tx
        .update(bills)
        .set({
          status: 'final',
          billNumber: 'TEST-1',
          fiscalYear: '2026-27',
          subtotalPaise: 30_000,
          discountPaise: 0,
          taxPaise: 0,
          totalPaise: 30_000,
          finalizedAt: new Date(),
        })
        .where(eq(bills.id, item.billId)),
    );

    await rejectsWith(
      withTenant(hospitalId, (tx) =>
        tx.insert(billItems).values({
          hospitalId,
          billId: item.billId,
          itemType: 'other',
          description: 'Dressing',
          quantity: 1,
          unitPricePaise: 5_000,
          subtotalPaise: 5_000,
          totalPaise: 5_000,
        }),
      ),
      /can no longer change/,
    );

    // A final bill can be cancelled, but not edited.
    await rejectsWith(
      withTenant(hospitalId, (tx) =>
        tx.update(bills).set({ totalPaise: 1 }).where(eq(bills.id, item.billId)),
      ),
      /cannot be changed/,
    );
  });

  it('refuses arithmetic that does not add up, whoever writes it', async () => {
    await setDoctorConsultationFee({ hospitalId, doctorId, pricePaise: 30_000, actorUserId: ownerId });
    const { appointment } = await walkIn(1);
    await setConsultationPaid({ hospitalId, appointmentId: appointment.id, paid: true, actorUserId: ownerId });
    const [item] = await itemsFor(appointment.id);

    await rejectsWith(
      withTenant(hospitalId, (tx) =>
        tx.insert(billItems).values({
          hospitalId,
          billId: item.billId,
          itemType: 'other',
          description: 'Wrong maths',
          quantity: 2,
          unitPricePaise: 5_000,
          subtotalPaise: 5_000,
          totalPaise: 5_000,
        }),
      ),
      /bill_items_math/,
    );
  });

  it('keeps one hospital out of another hospital\'s bills', async () => {
    await setDoctorConsultationFee({ hospitalId, doctorId, pricePaise: 30_000, actorUserId: ownerId });
    const { appointment } = await walkIn(1);
    await setConsultationPaid({ hospitalId, appointmentId: appointment.id, paid: true, actorUserId: ownerId });
    const [item] = await itemsFor(appointment.id);

    const other = await seedHospital();

    // Row-level security: invisible.
    const seen = await withTenant(other.hospitalId, (tx) => tx.select().from(bills));
    expect(seen).toHaveLength(0);

    /**
     * Cannot attach a line to it either, though the id is known. Two guards
     * stand in the way and the innermost wins: the bill is invisible under
     * row-level security, so the item trigger cannot find it at all. The
     * composite foreign key would have refused it a moment later.
     */
    await rejectsWith(
      withTenant(other.hospitalId, (tx) =>
        tx.insert(billItems).values({
          hospitalId: other.hospitalId,
          billId: item.billId,
          itemType: 'other',
          description: 'Smuggled line',
          quantity: 1,
          unitPricePaise: 100,
          subtotalPaise: 100,
          totalPaise: 100,
        }),
      ),
      /is missing; its items can no longer change/,
    );

    // And cannot charge the other hospital's appointment.
    await expect(
      setConsultationPaid({
        hospitalId: other.hospitalId,
        appointmentId: appointment.id,
        paid: true,
        actorUserId: ownerId,
      }),
    ).rejects.toThrow('Appointment not found');
  });

  it('saves the walk-in address, and a blank one never erases it', async () => {
    const { patient } = await walkIn(1, { address: 'Near Hanuman temple, Wadgaon' });
    expect(patient.address).toBe('Near Hanuman temple, Wadgaon');

    // Same phone and name, the next day, address left blank.
    const again = await createWalkIn({
      hospitalId,
      branchId,
      doctorId,
      timezone: TZ,
      patient: { phoneE164: '+919800000001', name: 'Patient 1', address: null },
      whatsappOptIn: false,
      now: new Date(Date.now() + 86_400_000),
    });
    expect(again.patient.id).toBe(patient.id);

    const [row] = await withTenant(hospitalId, (tx) =>
      tx
        .select({ address: patients.address })
        .from(patients)
        .where(and(eq(patients.id, patient.id), eq(patients.hospitalId, hospitalId))),
    );
    expect(row.address).toBe('Near Hanuman temple, Wadgaon');
  });
});
