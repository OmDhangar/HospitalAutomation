import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { isRequestReadOnly } from '@/lib/db/request-context';
import {
  admissions,
  auditLogs,
  bedAssignments,
  beds,
  billItems,
  bills,
  branches,
  careEntries,
  chargeItems,
  doctors,
  documentSequences,
  encounterPayers,
  encounters,
  hospitals,
  medicines,
  patientPayments,
  patients,
  recordAccessLogs,
  wards,
} from '@/lib/db/schema';
import {
  BILL_LINK_AFTER_DISCHARGE_MS,
  buildBillLinkToken,
  dischargeFlags,
  fiscalYearOf,
  formatBillNumber,
  isBillLinkLive,
  parseBillLinkToken,
  payerSplit,
  type DischargeFlags,
  type PayerSplit,
} from '@/lib/domain/discharge-bill';
import { calculateBillItem, sumBillItems } from '@/lib/domain/patient-billing';
import { generatePublicToken, hashToken } from '@/lib/security/tokens';
import { postBedDaysForAdmissionInTx } from '@/lib/services/bed-days';
import { getActivePayerInTx, setPayerInTx } from '@/lib/services/encounter-payers';
import { getEncounterInTx } from '@/lib/services/encounters';
import { resolveRow } from '@/lib/services/patients';

/**
 * Discharge billing (IPD plan §T2.1–T2.4): by the time the doctor says the
 * patient may go, the bill already exists, built line by line at the
 * bedside. The desk's job here is to review the flags, correct with a
 * reason, apply the payer and the deposits, finalise, print and share.
 *
 * Corrections are voids and re-posts, never edits (bill_items_guard), and a
 * final bill is frozen by trigger. Authorisation is the caller's
 * (`ipd.discharge`, `ipd.correct`, `billing.collect`).
 */

export class DischargeBillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DischargeBillError';
  }
}

const BILL_KIND = 'ipd_bill';
const BILL_PREFIX = 'IPD';

export type BillLine = {
  id: string;
  itemType: string;
  description: string;
  quantity: number;
  unitPricePaise: number;
  subtotalPaise: number;
  discountPaise: number;
  discountReason: string | null;
  taxPaise: number;
  totalPaise: number;
  /** The day the line belongs to: when given, or the bed-day's date. */
  day: string;
  /** When it was given, for bedside lines; null for room and OPD lines. */
  at: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  careEntryId: string | null;
};

export type PaymentRow = {
  id: string;
  kind: 'payment' | 'refund';
  amountPaise: number;
  method: string;
  receivedAt: Date;
  voidedAt: Date | null;
};

export type DischargeBillView = {
  admission: {
    id: string;
    status: string;
    encounterId: string;
    patientName: string;
    age: number | null;
    gender: string | null;
    phoneE164: string;
    address: string | null;
    doctorName: string;
    admittedAt: Date | null;
    dischargedAt: Date | null;
    bed: { label: string; wardName: string } | null;
    billLinkActive: boolean;
  };
  bill: { id: string; status: 'draft' | 'final' | 'cancelled'; billNumber: string | null; finalizedAt: Date | null } | null;
  lines: BillLine[];
  payments: PaymentRow[];
  payer: Awaited<ReturnType<typeof getActivePayerInTx>>;
  totals: ReturnType<typeof sumBillItems>;
  split: PayerSplit;
  flags: DischargeFlags;
};

const dayIn = (timezone: string, at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

async function linesInTx(tx: Tx, billIds: readonly string[], timezone: string): Promise<BillLine[]> {
  if (billIds.length === 0) return [];
  const rows = await tx
    .select({
      id: billItems.id,
      itemType: billItems.itemType,
      description: billItems.description,
      quantity: billItems.quantity,
      unitPricePaise: billItems.unitPricePaise,
      subtotalPaise: billItems.subtotalPaise,
      discountPaise: billItems.discountPaise,
      discountReason: billItems.discountReason,
      taxPaise: billItems.taxPaise,
      totalPaise: billItems.totalPaise,
      serviceDate: billItems.serviceDate,
      createdAt: billItems.createdAt,
      voidedAt: billItems.voidedAt,
      voidReason: billItems.voidReason,
      careEntryId: billItems.careEntryId,
      occurredAt: careEntries.occurredAt,
    })
    .from(billItems)
    .leftJoin(careEntries, eq(careEntries.id, billItems.careEntryId))
    .where(inArray(billItems.billId, [...billIds]))
    .orderBy(asc(sql`coalesce(${careEntries.occurredAt}, ${billItems.createdAt})`));
  return rows.map((row) => ({
    id: row.id,
    itemType: row.itemType,
    description: row.description,
    quantity: row.quantity,
    unitPricePaise: row.unitPricePaise,
    subtotalPaise: row.subtotalPaise,
    discountPaise: row.discountPaise,
    discountReason: row.discountReason,
    taxPaise: row.taxPaise,
    totalPaise: row.totalPaise,
    day: row.serviceDate ?? dayIn(timezone, row.occurredAt ?? row.createdAt),
    at: row.occurredAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    careEntryId: row.careEntryId,
  }));
}

async function admissionHeaderInTx(tx: Tx, admissionId: string) {
  const [row] = await tx
    .select({
      id: admissions.id,
      status: admissions.status,
      encounterId: admissions.encounterId,
      patientName: patients.name,
      age: patients.age,
      gender: patients.gender,
      phoneE164: patients.phoneE164,
      address: patients.address,
      doctorName: doctors.name,
      admittedAt: admissions.admittedAt,
      dischargedAt: admissions.dischargedAt,
      billLinkTokenHash: admissions.billLinkTokenHash,
      billLinkExpiresAt: admissions.billLinkExpiresAt,
      billLinkRevokedAt: admissions.billLinkRevokedAt,
      timezone: hospitals.timezone,
    })
    .from(admissions)
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .innerJoin(doctors, eq(doctors.id, admissions.admittingDoctorId))
    .innerJoin(hospitals, eq(hospitals.id, admissions.hospitalId))
    .where(eq(admissions.id, admissionId));
  if (!row) return null;
  const [bed] = await tx
    .select({ label: beds.label, wardName: wards.name })
    .from(bedAssignments)
    .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
    .innerJoin(wards, eq(wards.id, beds.wardId))
    .where(eq(bedAssignments.admissionId, admissionId))
    .orderBy(desc(bedAssignments.fromAt))
    .limit(1);
  return { ...row, bed: bed ?? null };
}

/** Everything the discharge billing screen shows. Null if not found. */
export async function getDischargeBillView(args: {
  hospitalId: string;
  admissionId: string;
}): Promise<DischargeBillView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(args.admissionId)) return null;
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const header = await admissionHeaderInTx(tx, args.admissionId);
      if (!header) return null;

      // Bring the room charges up to today before showing a total — unless
      // this is a read-only support session, which writes nothing.
      if ((header.status === 'admitted' || header.status === 'discharge_ready') && !isRequestReadOnly()) {
        await postBedDaysForAdmissionInTx(tx, { admissionId: header.id, timezone: header.timezone, now: new Date() });
      }

      const billRows = await tx
        .select({ id: bills.id, status: bills.status, billNumber: bills.billNumber, finalizedAt: bills.finalizedAt })
        .from(bills)
        .where(and(eq(bills.encounterId, header.encounterId), ne(bills.status, 'cancelled')))
        .orderBy(desc(bills.createdAt));
      const bill = billRows.find((b) => b.status === 'final') ?? billRows[0] ?? null;

      const [lines, payments, payer, entries] = await Promise.all([
        linesInTx(tx, billRows.map((b) => b.id), header.timezone),
        tx
          .select({
            id: patientPayments.id,
            kind: patientPayments.kind,
            amountPaise: patientPayments.amountPaise,
            method: patientPayments.method,
            receivedAt: patientPayments.receivedAt,
            voidedAt: patientPayments.voidedAt,
          })
          .from(patientPayments)
          .where(eq(patientPayments.encounterId, header.encounterId))
          .orderBy(asc(patientPayments.receivedAt)),
        getActivePayerInTx(tx, header.encounterId),
        tx
          .select({
            id: careEntries.id,
            description: careEntries.description,
            occurredAt: careEntries.occurredAt,
            recordedAt: careEntries.recordedAt,
            medicineId: careEntries.medicineId,
            chargeItemId: careEntries.chargeItemId,
            medicinePrice: medicines.sellingPricePaise,
            chargePrice: chargeItems.sellingPricePaise,
          })
          .from(careEntries)
          .leftJoin(medicines, eq(medicines.id, careEntries.medicineId))
          .leftJoin(chargeItems, eq(chargeItems.id, careEntries.chargeItemId))
          .where(and(eq(careEntries.admissionId, header.id), isNull(careEntries.voidedAt))),
      ]);

      const billedEntries = new Set(lines.filter((l) => !l.voidedAt && l.careEntryId).map((l) => l.careEntryId));
      const flags = dischargeFlags(
        entries.map((entry) => ({
          id: entry.id,
          itemKey: entry.medicineId ? `medicine:${entry.medicineId}` : `charge:${entry.chargeItemId}`,
          description: entry.description,
          occurredAt: entry.occurredAt,
          recordedAt: entry.recordedAt,
          unpriced:
            !billedEntries.has(entry.id) && (entry.medicineId ? entry.medicinePrice : entry.chargePrice) === null,
        })),
      );

      const live = lines.filter((line) => !line.voidedAt);
      const totals = sumBillItems(live);
      const paidPaise = payments
        .filter((p) => !p.voidedAt)
        .reduce((sum, p) => sum + (p.kind === 'refund' ? -p.amountPaise : p.amountPaise), 0);

      return {
        admission: {
          id: header.id,
          status: header.status,
          encounterId: header.encounterId,
          patientName: header.patientName,
          age: header.age,
          gender: header.gender,
          phoneE164: header.phoneE164,
          address: header.address,
          doctorName: header.doctorName,
          admittedAt: header.admittedAt,
          dischargedAt: header.dischargedAt,
          bed: header.bed,
          billLinkActive:
            header.billLinkTokenHash !== null &&
            isBillLinkLive({ expiresAt: header.billLinkExpiresAt, revokedAt: header.billLinkRevokedAt, now: new Date() }),
        },
        bill: bill ? { ...bill, status: bill.status } : null,
        lines,
        payments,
        payer,
        totals,
        split: payerSplit({ totalPaise: totals.totalPaise, paidPaise, approvedAmountPaise: payer?.approvedAmountPaise ?? null }),
        flags,
      };
    },
    { clinical: true },
  );
}

async function lockDraftLineInTx(tx: Tx, lineId: string) {
  const [line] = await tx.select().from(billItems).where(eq(billItems.id, lineId)).for('update');
  if (!line) throw new DischargeBillError('Line not found');
  if (line.voidedAt) throw new DischargeBillError('This line was already removed');
  const [bill] = await tx.select({ status: bills.status }).from(bills).where(eq(bills.id, line.billId));
  if (bill?.status !== 'draft') throw new DischargeBillError('The bill is final. It can no longer change.');
  return line;
}

/**
 * Removes a line with a reason. A bedside line takes its care entry with it:
 * the entry was wrong, and a live entry without a line would be billed again
 * the next time its item's price is set.
 */
export async function voidBillLine(args: {
  hospitalId: string;
  lineId: string;
  reason: string;
  actorUserId: string;
}): Promise<void> {
  const reason = args.reason.trim().slice(0, 200);
  if (!reason) throw new DischargeBillError('Say why this line is removed');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const line = await lockDraftLineInTx(tx, args.lineId);
      const now = new Date();
      await tx
        .update(billItems)
        .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: reason })
        .where(eq(billItems.id, line.id));
      if (line.careEntryId) {
        await tx
          .update(careEntries)
          .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: reason })
          .where(and(eq(careEntries.id, line.careEntryId), isNull(careEntries.voidedAt)));
      }
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'billing.line_voided',
        objectType: 'bill_item',
        objectId: line.id,
        metadata: { reason, totalPaise: line.totalPaise },
      });
    },
    { clinical: true },
  );
}

/**
 * A discount on one line, with a reason: the line is voided and posted
 * again, discounted, from the same source. Tax is recomputed on the
 * discounted amount, as everywhere else.
 */
export async function discountBillLine(args: {
  hospitalId: string;
  lineId: string;
  discountPaise: number;
  reason: string;
  actorUserId: string;
}): Promise<{ lineId: string }> {
  const reason = args.reason.trim().slice(0, 200);
  if (!reason) throw new DischargeBillError('Say why the discount is given');
  return withTenant(args.hospitalId, async (tx) => {
    const line = await lockDraftLineInTx(tx, args.lineId);
    if (args.discountPaise < 0 || args.discountPaise > line.subtotalPaise) {
      throw new DischargeBillError('The discount cannot be more than the line');
    }
    const amounts = calculateBillItem({
      quantity: line.quantity,
      unitPricePaise: line.unitPricePaise,
      taxRateBp: line.taxRateBp,
      discountPaise: args.discountPaise,
    });
    const now = new Date();
    await tx
      .update(billItems)
      .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: `Replaced by a discounted line: ${reason}` })
      .where(eq(billItems.id, line.id));
    // The same line from the same source, discounted. Everything that says
    // what it is for is copied; only the money and its reason change.
    const [replacement] = await tx.insert(billItems).values({
      hospitalId: line.hospitalId,
      billId: line.billId,
      itemType: line.itemType,
      serviceId: line.serviceId,
      appointmentId: line.appointmentId,
      medicineId: line.medicineId,
      chargeItemId: line.chargeItemId,
      careEntryId: line.careEntryId,
      bedAssignmentId: line.bedAssignmentId,
      serviceDate: line.serviceDate,
      description: line.description,
      quantity: line.quantity,
      configuredUnitPricePaise: line.configuredUnitPricePaise,
      unitPricePaise: line.unitPricePaise,
      priceOverrideReason: line.priceOverrideReason,
      taxRateBp: line.taxRateBp,
      ...amounts,
      discountReason: args.discountPaise > 0 ? reason : null,
      createdByUserId: args.actorUserId,
    }).returning({ id: billItems.id });
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'billing.line_discounted',
      objectType: 'bill_item',
      objectId: line.id,
      metadata: { reason, discountPaise: args.discountPaise, replacementId: replacement.id },
    });
    return { lineId: replacement.id };
  });
}

/** Money in (a payment) or out (a refund) at the desk, during the stay or at discharge. */
export async function recordIpdPayment(args: {
  hospitalId: string;
  admissionId: string;
  kind: 'payment' | 'refund';
  amountPaise: number;
  method: 'cash' | 'upi' | 'card' | 'bank' | 'other';
  reference?: string | null;
  actorUserId: string;
}): Promise<{ paymentId: string }> {
  if (!Number.isSafeInteger(args.amountPaise) || args.amountPaise <= 0) {
    throw new DischargeBillError('Enter an amount of more than ₹0');
  }
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [admission] = await tx
        .select({ encounterId: admissions.encounterId, patientId: admissions.patientId })
        .from(admissions)
        .where(eq(admissions.id, args.admissionId));
      if (!admission) throw new DischargeBillError('Admission not found');
      const [finalBill] = await tx
        .select({ id: bills.id })
        .from(bills)
        .where(and(eq(bills.encounterId, admission.encounterId), eq(bills.status, 'final')));
      const [payment] = await tx
        .insert(patientPayments)
        .values({
          hospitalId: args.hospitalId,
          encounterId: admission.encounterId,
          patientId: admission.patientId,
          billId: finalBill?.id ?? null,
          kind: args.kind,
          amountPaise: args.amountPaise,
          method: args.method,
          reference: args.reference?.trim() || null,
          receivedByUserId: args.actorUserId,
        })
        .returning({ id: patientPayments.id });
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: args.kind === 'refund' ? 'billing.refund_recorded' : 'billing.payment_recorded',
        objectType: 'patient_payment',
        objectId: payment.id,
        metadata: { encounterId: admission.encounterId, amountPaise: args.amountPaise, method: args.method },
      });
      return { paymentId: payment.id };
    },
    { clinical: true },
  );
}

/** The insurer's approved amount, recorded on the payer (void + new row). */
export async function setApprovedAmount(args: {
  hospitalId: string;
  admissionId: string;
  approvedAmountPaise: number | null;
  actorUserId: string;
}): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [admission] = await tx
        .select({ encounterId: admissions.encounterId })
        .from(admissions)
        .where(eq(admissions.id, args.admissionId));
      if (!admission) throw new DischargeBillError('Admission not found');
      const encounter = await getEncounterInTx(tx, admission.encounterId, { lock: true });
      const payer = await getActivePayerInTx(tx, encounter.id);
      if (!payer || payer.kind === 'self') throw new DischargeBillError('Record the insurer or TPA first');
      await setPayerInTx(tx, {
        encounter,
        payer: {
          kind: payer.kind,
          payerName: payer.payerName,
          policyNumber: payer.policyNumber,
          preauthAmountPaise: payer.preauthAmountPaise,
        },
        approvedAmountPaise: args.approvedAmountPaise,
        actorUserId: args.actorUserId,
        reason: 'Approved amount recorded',
      });
    },
    { clinical: true },
  );
}

/** The next gap-free number: incremented under a row lock in this transaction. */
async function nextNumberInTx(tx: Tx, hospitalId: string, fiscalYear: string): Promise<number> {
  const [row] = await tx
    .insert(documentSequences)
    .values({ hospitalId, kind: BILL_KIND, fiscalYear, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.hospitalId, documentSequences.kind, documentSequences.fiscalYear],
      set: { lastNumber: sql`${documentSequences.lastNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ lastNumber: documentSequences.lastNumber });
  return row.lastNumber;
}

/**
 * Finalise: the stay ends and the bill is frozen, in one transaction.
 *
 * Refused while any entry is unpriced (it would be missing from the bill).
 * Posts the last bed-days first, numbers the bill gap-free, snapshots the
 * patient onto it, discharges the admission, frees the bed, closes the
 * encounter, and starts the family link's seven-day countdown.
 */
export async function finalizeDischarge(args: {
  hospitalId: string;
  admissionId: string;
  actorUserId: string;
  now?: Date;
}): Promise<{ billId: string; billNumber: string }> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [admission] = await tx.select().from(admissions).where(eq(admissions.id, args.admissionId)).for('update');
      if (!admission) throw new DischargeBillError('Admission not found');
      if (admission.status !== 'admitted' && admission.status !== 'discharge_ready') {
        throw new DischargeBillError(
          admission.status === 'discharged' ? 'This patient is already discharged' : 'Only an admitted patient can be discharged',
        );
      }
      const [hospital] = await tx
        .select({ timezone: hospitals.timezone })
        .from(hospitals)
        .where(eq(hospitals.id, args.hospitalId));
      const encounter = await getEncounterInTx(tx, admission.encounterId, { lock: true });

      // Unpriced entries would be missing from the bill: refuse, and say how many.
      const [{ unpriced }] = await tx
        .select({ unpriced: sql<number>`count(*)::int` })
        .from(careEntries)
        .leftJoin(medicines, eq(medicines.id, careEntries.medicineId))
        .leftJoin(chargeItems, eq(chargeItems.id, careEntries.chargeItemId))
        .where(
          and(
            eq(careEntries.admissionId, admission.id),
            isNull(careEntries.voidedAt),
            sql`coalesce(${medicines.sellingPricePaise}, ${chargeItems.sellingPricePaise}) is null`,
            sql`not exists (select 1 from ${billItems} bi where bi.care_entry_id = ${careEntries.id} and bi.voided_at is null)`,
          ),
        );
      if (unpriced > 0) {
        throw new DischargeBillError(
          `${unpriced} item${unpriced === 1 ? ' has' : 's have'} no price. Price ${unpriced === 1 ? 'it' : 'them'} or remove ${unpriced === 1 ? 'it' : 'them'} first.`,
        );
      }

      await postBedDaysForAdmissionInTx(tx, {
        admissionId: admission.id,
        timezone: hospital.timezone,
        now,
        endedAt: now,
        actorUserId: args.actorUserId,
      });

      // The running bill — created if this stay had no charge at all.
      await tx
        .insert(bills)
        .values({
          hospitalId: args.hospitalId,
          encounterId: encounter.id,
          patientId: encounter.patientId,
          createdByUserId: args.actorUserId,
        })
        .onConflictDoNothing({ target: bills.encounterId, where: sql`status = 'draft'` });
      const [bill] = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.encounterId, encounter.id), eq(bills.status, 'draft')))
        .for('update');

      const live = await tx
        .select({
          subtotalPaise: billItems.subtotalPaise,
          discountPaise: billItems.discountPaise,
          taxPaise: billItems.taxPaise,
          totalPaise: billItems.totalPaise,
        })
        .from(billItems)
        .where(and(eq(billItems.billId, bill.id), isNull(billItems.voidedAt)));
      const totals = sumBillItems(live);
      const fiscalYear = fiscalYearOf(now, hospital.timezone);
      const billNumber = formatBillNumber(BILL_PREFIX, fiscalYear, await nextNumberInTx(tx, args.hospitalId, fiscalYear));
      const [patient] = await tx
        .select({ name: patients.name, phone: patients.phoneE164, address: patients.address })
        .from(patients)
        .where(eq(patients.id, encounter.patientId));
      // The identity the bill is issued under, frozen: a later merge must not change a printed bill.
      const [identity] = await tx
        .select({ qid: patients.qid, mrn: patients.mrn })
        .from(patients)
        .where(eq(patients.id, await resolveRow(tx, encounter.patientId)));

      await tx
        .update(bills)
        .set({
          status: 'final',
          billNumber,
          fiscalYear,
          ...totals,
          patientName: patient.name,
          patientPhone: patient.phone,
          patientAddress: patient.address,
          patientQid: identity?.qid ?? null,
          patientMrn: identity?.mrn ?? null,
          finalizedAt: now,
          finalizedByUserId: args.actorUserId,
          updatedAt: now,
        })
        .where(eq(bills.id, bill.id));
      // Deposits stay as they are: money hangs off the encounter, not a bill
      // (0026), and a recorded payment is never edited, only voided.

      await tx
        .update(admissions)
        .set({
          status: 'discharged',
          dischargedAt: now,
          dischargedByUserId: args.actorUserId,
          dischargeReadyAt: admission.dischargeReadyAt ?? now,
          billLinkExpiresAt: admission.billLinkTokenHash ? new Date(now.getTime() + BILL_LINK_AFTER_DISCHARGE_MS) : null,
          updatedAt: now,
        })
        .where(eq(admissions.id, admission.id));
      await tx
        .update(bedAssignments)
        .set({ toAt: now })
        .where(and(eq(bedAssignments.admissionId, admission.id), isNull(bedAssignments.toAt)));
      await tx
        .update(encounters)
        .set({ status: 'closed', closedAt: now, updatedAt: now })
        .where(eq(encounters.id, encounter.id));

      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'billing.bill_finalized',
        objectType: 'bill',
        objectId: bill.id,
        metadata: { billNumber, totalPaise: totals.totalPaise, admissionId: admission.id },
      });
      return { billId: bill.id, billNumber };
    },
    { clinical: true },
  );
}

/* ------------------------------------------------- the family's running bill */

/**
 * Creates (or replaces) the family's running-bill link. The token is shown
 * once, to be sent; only its hash is kept. Replacing a link ends the old one.
 */
export async function shareBillLink(args: {
  hospitalId: string;
  admissionId: string;
  actorUserId: string;
}): Promise<{ token: string; phoneE164: string; patientName: string }> {
  const random = generatePublicToken();
  const token = buildBillLinkToken(args.hospitalId, random);
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [admission] = await tx
        .select({ id: admissions.id, status: admissions.status, dischargedAt: admissions.dischargedAt, phone: patients.phoneE164, name: patients.name })
        .from(admissions)
        .innerJoin(patients, eq(patients.id, admissions.patientId))
        .where(eq(admissions.id, args.admissionId))
        .for('update', { of: admissions });
      if (!admission) throw new DischargeBillError('Admission not found');
      if (admission.status === 'cancelled' || admission.status === 'awaiting_bed') {
        throw new DischargeBillError('There is no bill to share yet');
      }
      await tx
        .update(admissions)
        .set({
          billLinkTokenHash: hashToken(random),
          billLinkCreatedAt: new Date(),
          billLinkRevokedAt: null,
          billLinkExpiresAt: admission.dischargedAt
            ? new Date(admission.dischargedAt.getTime() + BILL_LINK_AFTER_DISCHARGE_MS)
            : null,
        })
        .where(eq(admissions.id, admission.id));
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'billing.bill_link_shared',
        objectType: 'admission',
        objectId: admission.id,
      });
      return { token, phoneE164: admission.phone, patientName: admission.name };
    },
    { clinical: true },
  );
}

export async function revokeBillLink(args: { hospitalId: string; admissionId: string; actorUserId: string }) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      await tx.update(admissions).set({ billLinkRevokedAt: new Date() }).where(eq(admissions.id, args.admissionId));
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'billing.bill_link_revoked',
        objectType: 'admission',
        objectId: args.admissionId,
      });
    },
    { clinical: true },
  );
}

export type PublicBill =
  | { state: 'missing' }
  | { state: 'expired'; hospitalName: string }
  | {
      state: 'live';
      hospitalName: string;
      patientName: string;
      status: string;
      admittedAt: Date | null;
      dischargedAt: Date | null;
      billNumber: string | null;
      timezone: string;
      lines: Pick<BillLine, 'description' | 'quantity' | 'unitPricePaise' | 'totalPaise' | 'discountPaise' | 'day' | 'at'>[];
      totals: ReturnType<typeof sumBillItems>;
      split: PayerSplit;
      payerName: string | null;
    };

/**
 * The family's view: the same day-wise list, without who recorded anything,
 * without voided lines, without any clinical note. The link is the only
 * credential; the hospital in it scopes every read.
 */
export async function getPublicBill(token: string, now: Date = new Date()): Promise<PublicBill> {
  const parsed = parseBillLinkToken(token);
  if (!parsed) return { state: 'missing' };
  return withTenant(
    parsed.hospitalId,
    async (tx) => {
      const [row] = await tx
        .select({
          id: admissions.id,
          status: admissions.status,
          encounterId: admissions.encounterId,
          admittedAt: admissions.admittedAt,
          dischargedAt: admissions.dischargedAt,
          expiresAt: admissions.billLinkExpiresAt,
          revokedAt: admissions.billLinkRevokedAt,
          patientName: patients.name,
          hospitalName: hospitals.name,
          timezone: hospitals.timezone,
        })
        .from(admissions)
        .innerJoin(patients, eq(patients.id, admissions.patientId))
        .innerJoin(hospitals, eq(hospitals.id, admissions.hospitalId))
        .where(eq(admissions.billLinkTokenHash, hashToken(parsed.random)));
      if (!row) return { state: 'missing' as const };
      if (!isBillLinkLive({ expiresAt: row.expiresAt, revokedAt: row.revokedAt, now })) {
        return { state: 'expired' as const, hospitalName: row.hospitalName };
      }
      const billRows = await tx
        .select({ id: bills.id, status: bills.status, billNumber: bills.billNumber })
        .from(bills)
        .where(and(eq(bills.encounterId, row.encounterId), ne(bills.status, 'cancelled')));
      const lines = (await linesInTx(tx, billRows.map((b) => b.id), row.timezone)).filter((line) => !line.voidedAt);
      const payments = await tx
        .select({ kind: patientPayments.kind, amountPaise: patientPayments.amountPaise })
        .from(patientPayments)
        .where(and(eq(patientPayments.encounterId, row.encounterId), isNull(patientPayments.voidedAt)));
      const payer = await getActivePayerInTx(tx, row.encounterId);
      const totals = sumBillItems(lines);
      const paidPaise = payments.reduce((sum, p) => sum + (p.kind === 'refund' ? -p.amountPaise : p.amountPaise), 0);
      return {
        state: 'live' as const,
        hospitalName: row.hospitalName,
        patientName: row.patientName,
        status: row.status,
        admittedAt: row.admittedAt,
        dischargedAt: row.dischargedAt,
        billNumber: billRows.find((b) => b.status === 'final')?.billNumber ?? null,
        timezone: row.timezone,
        lines: lines.map(({ description, quantity, unitPricePaise, totalPaise, discountPaise, day, at }) => ({
          description,
          quantity,
          unitPricePaise,
          totalPaise,
          discountPaise,
          day,
          at,
        })),
        totals,
        split: payerSplit({ totalPaise: totals.totalPaise, paidPaise, approvedAmountPaise: payer?.approvedAmountPaise ?? null }),
        payerName: payer && payer.kind !== 'self' ? payer.payerName : null,
      };
    },
    { clinical: true },
  );
}

/* ------------------------------------------------------------------ print */

export type PrintableBill = {
  hospital: { name: string; branchName: string; branchAddress: string | null };
  bill: { id: string; billNumber: string | null; status: string; finalizedAt: Date | null };
  patient: { name: string; phone: string; address: string | null; age: number | null; gender: string | null };
  admission: { id: string; admittedAt: Date | null; dischargedAt: Date | null; doctorName: string; bed: { label: string; wardName: string } | null };
  payer: { kind: string; payerName: string | null; policyNumber: string | null } | null;
  lines: BillLine[];
  payments: PaymentRow[];
  totals: ReturnType<typeof sumBillItems>;
  split: PayerSplit;
  timezone: string;
};

/**
 * The bill as it will be printed, logged as print_ipd_bill. A final bill
 * prints its frozen snapshot; a draft prints marked as provisional.
 */
export async function getBillForPrint(args: {
  hospitalId: string;
  billId: string;
  actorUserId: string;
}): Promise<PrintableBill | null> {
  if (!/^[0-9a-f-]{36}$/i.test(args.billId)) return null;
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [bill] = await tx.select().from(bills).where(eq(bills.id, args.billId));
      if (!bill) return null;
      const [admission] = await tx
        .select({ id: admissions.id })
        .from(admissions)
        .where(and(eq(admissions.encounterId, bill.encounterId), ne(admissions.status, 'cancelled')));
      if (!admission) return null;
      const header = (await admissionHeaderInTx(tx, admission.id))!;
      const [place] = await tx
        .select({ hospitalName: hospitals.name, branchName: branches.name, branchAddress: branches.address })
        .from(encounters)
        .innerJoin(hospitals, eq(hospitals.id, encounters.hospitalId))
        .innerJoin(branches, eq(branches.id, encounters.branchId))
        .where(eq(encounters.id, bill.encounterId));
      const [lines, payments, payer] = await Promise.all([
        linesInTx(tx, [bill.id], header.timezone),
        tx
          .select({
            id: patientPayments.id,
            kind: patientPayments.kind,
            amountPaise: patientPayments.amountPaise,
            method: patientPayments.method,
            receivedAt: patientPayments.receivedAt,
            voidedAt: patientPayments.voidedAt,
          })
          .from(patientPayments)
          .where(and(eq(patientPayments.encounterId, bill.encounterId), isNull(patientPayments.voidedAt)))
          .orderBy(asc(patientPayments.receivedAt)),
        getActivePayerInTx(tx, bill.encounterId),
      ]);
      await tx.insert(recordAccessLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        patientId: bill.patientId,
        encounterId: bill.encounterId,
        action: 'print_ipd_bill',
      });
      const live = lines.filter((line) => !line.voidedAt);
      const totals =
        bill.status === 'final' && bill.totalPaise !== null
          ? {
              subtotalPaise: bill.subtotalPaise ?? 0,
              discountPaise: bill.discountPaise ?? 0,
              taxPaise: bill.taxPaise ?? 0,
              totalPaise: bill.totalPaise,
            }
          : sumBillItems(live);
      const paidPaise = payments.reduce((sum, p) => sum + (p.kind === 'refund' ? -p.amountPaise : p.amountPaise), 0);
      return {
        hospital: { name: place.hospitalName, branchName: place.branchName, branchAddress: place.branchAddress },
        bill: { id: bill.id, billNumber: bill.billNumber, status: bill.status, finalizedAt: bill.finalizedAt },
        patient: {
          name: bill.patientName ?? header.patientName,
          phone: bill.patientPhone ?? header.phoneE164,
          address: bill.patientAddress ?? header.address,
          age: header.age,
          gender: header.gender,
        },
        admission: {
          id: header.id,
          admittedAt: header.admittedAt,
          dischargedAt: header.dischargedAt,
          doctorName: header.doctorName,
          bed: header.bed,
        },
        payer: payer ? { kind: payer.kind, payerName: payer.payerName, policyNumber: payer.policyNumber } : null,
        lines: live,
        payments,
        totals,
        split: payerSplit({ totalPaise: totals.totalPaise, paidPaise, approvedAmountPaise: payer?.approvedAmountPaise ?? null }),
        timezone: header.timezone,
      };
    },
    { clinical: true },
  );
}

/** Lookups the screens need by admission, for links between pages. */
export async function getEncounterPayer(hospitalId: string, encounterId: string) {
  return withTenant(hospitalId, (tx) =>
    tx
      .select()
      .from(encounterPayers)
      .where(and(eq(encounterPayers.encounterId, encounterId), isNull(encounterPayers.voidedAt))),
  );
}
