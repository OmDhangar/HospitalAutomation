import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  auditLogs,
  billItems,
  bills,
  doctors,
  encounters,
  patientPayments,
  services,
} from '@/lib/db/schema';
import { openEncounterForAppointmentInTx, type EncounterRow } from '@/lib/services/encounters';
import {
  calculateBillItem,
  paymentStatus,
  type PaymentStatus,
} from '@/lib/domain/patient-billing';

/**
 * The patient side of money: consultation fees, bills and payments.
 *
 * Authorisation happens in the calling action (`can(role, 'billing.collect')`
 * and friends). This module's job is correctness: every price is read here,
 * inside the transaction that uses it, never taken from the browser; and
 * every id the caller passes is re-read under row-level security, so an id
 * from another hospital simply is not found.
 */

export class PatientBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatientBillingError';
  }
}

/** Raised when Paid is tapped for a doctor whose fee nobody has set yet. */
export class ConsultationFeeMissingError extends PatientBillingError {
  constructor(readonly doctorName: string) {
    super(`No consultation fee is set for ${doctorName}`);
    this.name = 'ConsultationFeeMissingError';
  }
}

/* ------------------------------------------------------ consultation fees */

/** Active consultation fee per doctor, in paise. Doctors with no fee are absent. */
export async function getConsultationFeesInTx(
  tx: Tx,
  doctorIds: readonly string[],
): Promise<Map<string, number>> {
  if (doctorIds.length === 0) return new Map();
  const rows = await tx
    .select({ doctorId: services.doctorId, pricePaise: services.sellingPricePaise })
    .from(services)
    .where(
      and(
        eq(services.kind, 'consultation'),
        eq(services.active, true),
        inArray(services.doctorId, [...doctorIds]),
      ),
    );
  return new Map(rows.map((row) => [row.doctorId!, row.pricePaise]));
}

export async function getConsultationFees(hospitalId: string, doctorIds: readonly string[]) {
  return withTenant(hospitalId, (tx) => getConsultationFeesInTx(tx, doctorIds));
}

/**
 * Sets a doctor's consultation fee. Old bills are unaffected — they carry the
 * price they were charged at — and the change is written to the audit log
 * with both amounts, which is the price history.
 */
export async function setDoctorConsultationFee(args: {
  hospitalId: string;
  doctorId: string;
  pricePaise: number;
  actorUserId: string;
}): Promise<void> {
  await withTenant(args.hospitalId, (tx) => setDoctorConsultationFeeInTx(tx, args));
}

export async function setDoctorConsultationFeeInTx(
  tx: Tx,
  args: { hospitalId: string; doctorId: string; pricePaise: number; actorUserId: string },
): Promise<void> {
  if (!Number.isSafeInteger(args.pricePaise) || args.pricePaise < 0) {
    throw new PatientBillingError('Enter a fee of ₹0 or more');
  }

  const [doctor] = await tx
    .select({ id: doctors.id })
    .from(doctors)
    .where(eq(doctors.id, args.doctorId));
  if (!doctor) throw new PatientBillingError('Doctor not found');

  const [existing] = await tx
    .select({ id: services.id, pricePaise: services.sellingPricePaise, active: services.active })
    .from(services)
    .where(and(eq(services.kind, 'consultation'), eq(services.doctorId, doctor.id)))
    .for('update');

  if (existing && existing.active && existing.pricePaise === args.pricePaise) return;

  let serviceId: string;
  if (existing) {
    await tx
      .update(services)
      .set({ sellingPricePaise: args.pricePaise, active: true, updatedAt: new Date() })
      .where(eq(services.id, existing.id));
    serviceId = existing.id;
  } else {
    const [created] = await tx
      .insert(services)
      .values({
        hospitalId: args.hospitalId,
        kind: 'consultation',
        name: 'Consultation',
        doctorId: doctor.id,
        sellingPricePaise: args.pricePaise,
      })
      .returning({ id: services.id });
    serviceId = created.id;
  }

  await tx.insert(auditLogs).values({
    hospitalId: args.hospitalId,
    actorUserId: args.actorUserId,
    action: 'billing.price_changed',
    objectType: 'service',
    objectId: serviceId,
    metadata: {
      kind: 'consultation',
      doctorId: doctor.id,
      fromPaise: existing?.active ? existing.pricePaise : null,
      toPaise: args.pricePaise,
    },
  });
}

/* ------------------------------------------------------------------ bills */

type BillRow = typeof bills.$inferSelect;

/** The encounter's running bill, created if there is none. Locked. */
export async function getOrCreateDraftBillInTx(
  tx: Tx,
  args: { encounter: EncounterRow; actorUserId: string | null },
): Promise<BillRow> {
  await tx
    .insert(bills)
    .values({
      hospitalId: args.encounter.hospitalId,
      encounterId: args.encounter.id,
      patientId: args.encounter.patientId,
      createdByUserId: args.actorUserId,
    })
    .onConflictDoNothing({ target: bills.encounterId, where: sql`status = 'draft'` });

  const [bill] = await tx
    .select()
    .from(bills)
    .where(and(eq(bills.encounterId, args.encounter.id), eq(bills.status, 'draft')))
    .for('update');
  return bill;
}

/**
 * Charges the consultation for a queue appointment at the doctor's current
 * fee, copied onto the line. At most once per appointment: the partial unique
 * index turns a second tap into an insert that does nothing.
 */
async function addConsultationItemInTx(
  tx: Tx,
  args: { bill: BillRow; encounter: EncounterRow; actorUserId: string | null },
): Promise<void> {
  const appointmentId = args.encounter.appointmentId;
  if (!appointmentId) throw new PatientBillingError('This visit has no queue appointment');

  const [fee] = await tx
    .select({
      id: services.id,
      name: services.name,
      pricePaise: services.sellingPricePaise,
      taxRateBp: services.taxRateBp,
      doctorName: doctors.name,
    })
    .from(doctors)
    .leftJoin(
      services,
      and(
        eq(services.doctorId, doctors.id),
        eq(services.kind, 'consultation'),
        eq(services.active, true),
      ),
    )
    .where(eq(doctors.id, args.encounter.attendingDoctorId));

  if (!fee) throw new PatientBillingError('Doctor not found');
  if (fee.id === null || fee.pricePaise === null) {
    throw new ConsultationFeeMissingError(fee.doctorName);
  }

  const amounts = calculateBillItem({
    quantity: 1,
    unitPricePaise: fee.pricePaise,
    taxRateBp: fee.taxRateBp ?? 0,
  });

  await tx
    .insert(billItems)
    .values({
      hospitalId: args.bill.hospitalId,
      billId: args.bill.id,
      itemType: 'consultation',
      serviceId: fee.id,
      appointmentId,
      description: `${fee.name} – ${fee.doctorName}`,
      quantity: 1,
      configuredUnitPricePaise: fee.pricePaise,
      unitPricePaise: fee.pricePaise,
      taxRateBp: fee.taxRateBp ?? 0,
      ...amounts,
      createdByUserId: args.actorUserId,
    })
    .onConflictDoNothing({
      target: billItems.appointmentId,
      where: sql`appointment_id is not null and voided_at is null`,
    });
}

/* ------------------------------------------------------------ settlement */

export type Settlement = {
  status: PaymentStatus;
  totalPaise: number;
  paidPaise: number;
};

/** Charged vs received for one encounter, across every bill that is not cancelled. */
async function settlementInTx(tx: Tx, encounterId: string): Promise<Settlement> {
  const [[charged], [received]] = await Promise.all([
    tx
      .select({
        count: sql<number>`count(*)::int`,
        totalPaise: sql<number>`coalesce(sum(${billItems.totalPaise}), 0)::int`,
      })
      .from(billItems)
      .innerJoin(bills, eq(bills.id, billItems.billId))
      .where(
        and(
          eq(bills.encounterId, encounterId),
          ne(bills.status, 'cancelled'),
          isNull(billItems.voidedAt),
        ),
      ),
    tx
      .select({
        paidPaise: sql<number>`coalesce(sum(case when ${patientPayments.kind} = 'refund'
          then -${patientPayments.amountPaise} else ${patientPayments.amountPaise} end), 0)::int`,
      })
      .from(patientPayments)
      .where(and(eq(patientPayments.encounterId, encounterId), isNull(patientPayments.voidedAt))),
  ]);

  return {
    status: paymentStatus({
      hasCharges: charged.count > 0,
      totalPaise: charged.totalPaise,
      paidPaise: received.paidPaise,
    }),
    totalPaise: charged.totalPaise,
    paidPaise: received.paidPaise,
  };
}

/**
 * The desk toggle.
 *
 * Paid: open the encounter, make sure the consultation is charged, and record
 * a payment for whatever is outstanding. Unpaid: void the payments taken at
 * the desk for this visit. Nothing is deleted either way — flipping back and
 * forth leaves a trail of payments and voids, which is what an end-of-day
 * cash count needs.
 *
 * Only for OPD visits. An admitted patient's money moves through the IPD bill,
 * where one tap cannot sensibly mean "settle everything".
 */
export async function setConsultationPaid(args: {
  hospitalId: string;
  appointmentId: string;
  paid: boolean;
  method?: (typeof patientPayments.$inferInsert)['method'];
  /**
   * Sets the attending doctor's fee first, in the same transaction. For the
   * first Paid tap on a doctor nobody has priced yet; the caller must have
   * checked the actor may set prices.
   */
  setFeePaise?: number;
  reason?: string;
  waiveCharges?: boolean;
  actorUserId: string;
}): Promise<Settlement> {
  return withTenant(args.hospitalId, async (tx) => {
    const encounter = await openEncounterForAppointmentInTx(tx, {
      appointmentId: args.appointmentId,
      actorUserId: args.actorUserId,
    });
    if (encounter.stage !== 'opd') {
      throw new PatientBillingError('This patient is admitted. Take payment on the IPD bill.');
    }

    if (args.setFeePaise !== undefined) {
      await setDoctorConsultationFeeInTx(tx, {
        hospitalId: args.hospitalId,
        doctorId: encounter.attendingDoctorId,
        pricePaise: args.setFeePaise,
        actorUserId: args.actorUserId,
      });
    }

    if (args.paid) {
      const bill = await getOrCreateDraftBillInTx(tx, { encounter, actorUserId: args.actorUserId });
      await addConsultationItemInTx(tx, { bill, encounter, actorUserId: args.actorUserId });

      const before = await settlementInTx(tx, encounter.id);
      const outstanding = before.totalPaise - before.paidPaise;
      if (outstanding <= 0) return before;

      const [payment] = await tx
        .insert(patientPayments)
        .values({
          hospitalId: args.hospitalId,
          encounterId: encounter.id,
          patientId: encounter.patientId,
          amountPaise: outstanding,
          method: args.method ?? 'cash',
          receivedByUserId: args.actorUserId,
        })
        .returning({ id: patientPayments.id });

      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'billing.payment_recorded',
        objectType: 'patient_payment',
        objectId: payment.id,
        metadata: { encounterId: encounter.id, amountPaise: outstanding, method: args.method ?? 'cash' },
      });
    } else {
      const voidReason = args.reason || 'Marked unpaid at the desk';

      const voided = await tx
        .update(patientPayments)
        .set({
          voidedAt: new Date(),
          voidedByUserId: args.actorUserId,
          voidReason,
        })
        .where(and(eq(patientPayments.encounterId, encounter.id), isNull(patientPayments.voidedAt)))
        .returning({ id: patientPayments.id, amountPaise: patientPayments.amountPaise });

      if (args.waiveCharges) {
        await tx
          .update(billItems)
          .set({
            voidedAt: new Date(),
            voidedByUserId: args.actorUserId,
            voidReason,
          })
          .where(
            and(
              eq(billItems.appointmentId, args.appointmentId),
              isNull(billItems.voidedAt),
            ),
          );
      }

      if (voided.length > 0) {
        await tx.insert(auditLogs).values({
          hospitalId: args.hospitalId,
          actorUserId: args.actorUserId,
          action: 'billing.payment_voided',
          objectType: 'encounter',
          objectId: encounter.id,
          metadata: {
            paymentIds: voided.map((p) => p.id),
            reason: voidReason,
            waiveCharges: args.waiveCharges ?? false,
          },
        });
      }
    }

    return settlementInTx(tx, encounter.id);
  });
}

/**
 * Payment status for a set of queue appointments, for the dashboard pills.
 * One round trip; appointments with no encounter yet are simply absent,
 * which the caller reads as unpaid.
 */
export async function getPaymentStatusesInTx(
  tx: Tx,
  appointmentIds: readonly string[],
): Promise<Record<string, PaymentStatus>> {
  if (appointmentIds.length === 0) return {};

  const rows = await tx.execute<{
    appointment_id: string;
    charge_count: number;
    total_paise: number;
    paid_paise: number;
  }>(sql`
    select
      encounters.appointment_id,
      coalesce(charged.charge_count, 0)::int as charge_count,
      coalesce(charged.total_paise, 0)::int as total_paise,
      coalesce(received.paid_paise, 0)::int as paid_paise
    from encounters
    left join lateral (
      select count(*) as charge_count, sum(bi.total_paise) as total_paise
      from bills b
      join bill_items bi on bi.bill_id = b.id
      where b.encounter_id = encounters.id and b.status <> 'cancelled' and bi.voided_at is null
    ) charged on true
    left join lateral (
      select sum(case when pp.kind = 'refund' then -pp.amount_paise else pp.amount_paise end) as paid_paise
      from patient_payments pp
      where pp.encounter_id = encounters.id and pp.voided_at is null
    ) received on true
    where ${inArray(encounters.appointmentId, [...appointmentIds])}
  `);

  const statuses: Record<string, PaymentStatus> = {};
  for (const row of rows) {
    statuses[row.appointment_id] = paymentStatus({
      hasCharges: Number(row.charge_count) > 0,
      totalPaise: Number(row.total_paise),
      paidPaise: Number(row.paid_paise),
    });
  }
  return statuses;
}
