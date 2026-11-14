import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  hospitals,
  medicines,
  patients,
  pharmacyReturnItems,
  pharmacyReturns,
  pharmacySaleItems,
  pharmacySales,
  prescriptionItems,
  prescriptions,
  stockBalances,
  stockBatches,
  stockLedger,
  stockLocations,
  users,
} from '@/lib/db/schema';
import { getEntitlements } from '@/lib/services/entitlements';
import {
  calculateItemTax,
  calculateSaleTotals,
  formatReturnNumber,
  formatSaleNumber,
  generateReceiptData,
  type FormattedReceipt,
} from '@/lib/domain/pharmacy';
import { fefo } from '@/lib/domain/stock';

export interface ProcessSaleItemInput {
  medicineId: string;
  batchId: string;
  batchNo?: string;
  expiryDate?: string;
  hsnCode?: string;
  quantity: number;
  unitPricePaise: number;
  mrpPaise: number;
  discountPercent?: number;
  gstRate?: number;
}

export interface ProcessSaleInput {
  saleType: 'prescription' | 'counter';
  prescriptionId?: string;
  patientId?: string;
  customerName: string;
  customerPhone?: string;
  doctorName?: string;
  paymentMode: 'cash' | 'upi' | 'card';
  billDiscountPaise?: number;
  items: ProcessSaleItemInput[];
  dispensedByUserId: string;
  storeLocationId?: string;
}

export interface ProcessSaleResult {
  saleId: string;
  saleNo: string;
  totalPaise: number;
  receipt: FormattedReceipt;
}

export interface ProcessReturnItemInput {
  saleItemId: string;
  batchId: string;
  quantityReturned: number;
  refundAmountPaise: number;
}

export interface ProcessReturnInput {
  saleId: string;
  reason: string;
  refundMode: 'cash' | 'upi' | 'credit_note';
  items: ProcessReturnItemInput[];
  returnedByUserId: string;
  storeLocationId?: string;
}

export interface ProcessReturnResult {
  returnId: string;
  returnNo: string;
  refundAmountPaise: number;
}

/** Check if hospital has in-house retail pharmacy enabled */
export async function assertInhousePharmacyEntitled(hospitalId: string, tx?: Tx): Promise<void> {
  const entitlements = await getEntitlements(hospitalId);
  if (!entitlements.hasInhousePharmacy) {
    throw new Error(
      'In-house retail pharmacy module is not enabled for this hospital. External pharmacy mode is active.'
    );
  }
}

/** Find or default the hospital's pharmacy store location */
export async function getPharmacyLocation(hospitalId: string, tx: Tx): Promise<string> {
  const loc = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.hospitalId, hospitalId),
        eq(stockLocations.active, true)
      )
    )
    .orderBy(desc(stockLocations.isMainStore))
    .limit(1);

  if (loc.length > 0) return loc[0].id;

  // Fallback: create default pharmacy main store location if none exists
  const [created] = await tx
    .insert(stockLocations)
    .values({
      hospitalId,
      name: 'Central Pharmacy Store',
      kind: 'main_store',
      isMainStore: true,
      active: true,
    })
    .returning({ id: stockLocations.id });

  return created.id;
}

/** Get unfulfilled OPD prescriptions for pharmacy queue */
export async function getPrescriptionFulfillmentQueue(hospitalId: string) {
  return withTenant(hospitalId, async (tx) => {
    await assertInhousePharmacyEntitled(hospitalId, tx);

    const rows = await tx
      .select({
        prescriptionId: prescriptions.id,
        encounterId: prescriptions.encounterId,
        patientId: prescriptions.patientId,
        patientName: patients.fullName,
        patientPhone: patients.phoneE164,
        patientMrn: patients.mrn,
        prescriberDoctorId: prescriptions.prescriberDoctorId,
        prescriberName: prescriptions.prescriberName,
        advice: prescriptions.advice,
        followUpOn: prescriptions.followUpOn,
        fulfillmentStatus: prescriptions.fulfillmentStatus,
        createdAt: prescriptions.createdAt,
      })
      .from(prescriptions)
      .innerJoin(patients, eq(prescriptions.patientId, patients.id))
      .where(
        and(
          eq(prescriptions.hospitalId, hospitalId),
          eq(prescriptions.status, 'final'),
          eq(prescriptions.fulfillmentStatus, 'unfulfilled')
        )
      )
      .orderBy(desc(prescriptions.createdAt))
      .limit(50);

    const results = [];
    for (const r of rows) {
      const items = await tx
        .select({
          id: prescriptionItems.id,
          medicineId: prescriptionItems.medicineId,
          medicineName: prescriptionItems.medicineName,
          dose: prescriptionItems.dose,
          frequency: prescriptionItems.frequency,
          durationDays: prescriptionItems.durationDays,
          instructions: prescriptionItems.instructions,
        })
        .from(prescriptionItems)
        .where(
          and(
            eq(prescriptionItems.hospitalId, hospitalId),
            eq(prescriptionItems.prescriptionId, r.prescriptionId)
          )
        )
        .orderBy(prescriptionItems.sortOrder);

      results.push({ ...r, items });
    }

    return results;
  });
}

/** Get batches for a medicine sorted by FEFO */
export async function getAvailableBatchesForMedicine(
  hospitalId: string,
  locationId: string,
  medicineId: string
) {
  return withTenant(hospitalId, async (tx) => {
    const batches = await tx
      .select({
        id: stockBatches.id,
        batchNo: stockBatches.batchNo,
        expiryDate: stockBatches.expiryDate,
        mrpPaise: stockBatches.mrpPaise,
        purchasePricePaise: stockBatches.purchasePricePaise,
        quantity: stockBalances.quantity,
      })
      .from(stockBatches)
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.batchId, stockBatches.id),
          eq(stockBalances.locationId, locationId)
        )
      )
      .where(
        and(
          eq(stockBatches.hospitalId, hospitalId),
          eq(stockBatches.medicineId, medicineId)
        )
      );

    // Map and sort via pure domain FEFO
    const formatted = batches
      .filter((b) => (b.quantity ?? 0) > 0)
      .map((b) => ({
        batchId: b.id,
        batchNo: b.batchNo,
        expiry: b.expiryDate,
        expiryStatus: 'active' as const,
        quantity: b.quantity ?? 0,
        mrpPaise: b.mrpPaise ?? 0,
      }));

    return fefo(formatted);
  });
}

/** Process outpatient retail pharmacy sale atomically */
export async function processPharmacySale(
  hospitalId: string,
  input: ProcessSaleInput
): Promise<ProcessSaleResult> {
  return withTenant(hospitalId, async (tx) => {
    await assertInhousePharmacyEntitled(hospitalId, tx);

    const locationId = input.storeLocationId || (await getPharmacyLocation(hospitalId, tx));

    // 1. Calculate sequential sale number
    const countRes = await tx
      .select({ count: sql<number>`count(*)` })
      .from(pharmacySales)
      .where(eq(pharmacySales.hospitalId, hospitalId));
    const nextSeq = Number(countRes[0]?.count ?? 0) + 1;
    const year = new Date().getFullYear();
    const saleNo = formatSaleNumber('PH', year, nextSeq);

    // 2. Calculate line items taxes
    const calculatedItems = input.items.map((item) => {
      const tax = calculateItemTax({
        unitPricePaise: item.unitPricePaise,
        quantity: item.quantity,
        discountPercent: item.discountPercent ?? 0,
        gstRate: item.gstRate ?? 12,
      });

      return {
        ...item,
        tax,
      };
    });

    const totals = calculateSaleTotals(
      calculatedItems.map((i) => i.tax),
      input.billDiscountPaise ?? 0
    );

    // 3. Insert sale header
    const [sale] = await tx
      .insert(pharmacySales)
      .values({
        hospitalId,
        saleNo,
        saleType: input.saleType,
        prescriptionId: input.prescriptionId ?? null,
        patientId: input.patientId ?? null,
        customerName: input.customerName,
        customerPhone: input.customerPhone ?? null,
        doctorName: input.doctorName ?? null,
        paymentMode: input.paymentMode,
        subtotalPaise: totals.subtotalPaise,
        cgstPaise: totals.totalCgstPaise,
        sgstPaise: totals.totalSgstPaise,
        discountPaise: totals.discountPaise,
        totalPaise: totals.totalPaise,
        status: 'completed',
        dispensedByUserId: input.dispensedByUserId ?? null,
      })
      .returning({ id: pharmacySales.id });

    // 4. Insert sale items & ledger entries
    const receiptItems = [];

    for (const item of calculatedItems) {
      // Lookup batch metadata if missing
      let batchNo = item.batchNo;
      let expiryDate = item.expiryDate;
      if (!batchNo || !expiryDate) {
        const [b] = await tx
          .select({ batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate })
          .from(stockBatches)
          .where(eq(stockBatches.id, item.batchId));
        batchNo = batchNo || b?.batchNo || 'UNKNOWN';
        expiryDate = expiryDate || b?.expiryDate || '2099-12-31';
      }

      await tx.insert(pharmacySaleItems).values({
        hospitalId,
        saleId: sale.id,
        medicineId: item.medicineId,
        batchId: item.batchId,
        batchNo,
        expiryDate,
        hsnCode: item.hsnCode ?? '3004',
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
        mrpPaise: item.mrpPaise,
        discountPercent: item.discountPercent ?? 0,
        gstRate: item.gstRate ?? 12,
        taxableAmountPaise: item.tax.taxableAmountPaise,
        cgstAmountPaise: item.tax.cgstAmountPaise,
        sgstAmountPaise: item.tax.sgstAmountPaise,
        totalAmountPaise: item.tax.totalAmountPaise,
      });

      // Post inventory ledger deduction (triggers update stock_balances automatically)
      await tx.insert(stockLedger).values({
        hospitalId,
        locationId,
        medicineId: item.medicineId,
        batchId: item.batchId,
        kind: 'give',
        quantity: -item.quantity,
        source: 'pharmacy_sale',
        recordedByUserId: input.dispensedByUserId,
      });

      // Lookup medicine name for receipt
      const [med] = await tx
        .select({ name: medicines.name })
        .from(medicines)
        .where(eq(medicines.id, item.medicineId));

      receiptItems.push({
        medicineName: med?.name || 'Medicine',
        batchNo,
        expiryDate,
        quantity: item.quantity,
        mrpPaise: item.mrpPaise,
        unitPricePaise: item.unitPricePaise,
        discountPercent: item.discountPercent ?? 0,
        gstRate: item.gstRate ?? 12,
        taxableAmountPaise: item.tax.taxableAmountPaise,
        cgstAmountPaise: item.tax.cgstAmountPaise,
        sgstAmountPaise: item.tax.sgstAmountPaise,
        totalAmountPaise: item.tax.totalAmountPaise,
      });
    }

    // 5. Update prescription fulfillment status if applicable
    if (input.prescriptionId) {
      await tx
        .update(prescriptions)
        .set({ fulfillmentStatus: 'dispensed' })
        .where(eq(prescriptions.id, input.prescriptionId));
    }

    // 6. Generate formatted receipt data (English-only)
    const [hosp] = await tx
      .select({ name: hospitals.name, registrationNo: hospitals.registrationNo })
      .from(hospitals)
      .where(eq(hospitals.id, hospitalId));

    const receipt = generateReceiptData({
      hospitalName: hosp?.name || 'Qurio Hospital',
      drugLicenseNo: hosp?.registrationNo || undefined,
      saleNo,
      saleDate: new Date(),
      cashierName: 'Pharmacy Counter',
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      doctorName: input.doctorName,
      paymentMode: input.paymentMode,
      items: receiptItems,
      subtotalPaise: totals.subtotalPaise,
      cgstPaise: totals.totalCgstPaise,
      sgstPaise: totals.totalSgstPaise,
      discountPaise: totals.discountPaise,
      totalPaise: totals.totalPaise,
    });

    return {
      saleId: sale.id,
      saleNo,
      totalPaise: totals.totalPaise,
      receipt,
    };
  });
}

/** Process pharmacy return & restock inventory */
export async function processPharmacyReturn(
  hospitalId: string,
  input: ProcessReturnInput
): Promise<ProcessReturnResult> {
  return withTenant(hospitalId, async (tx) => {
    await assertInhousePharmacyEntitled(hospitalId, tx);

    const locationId = input.storeLocationId || (await getPharmacyLocation(hospitalId, tx));

    const countRes = await tx
      .select({ count: sql<number>`count(*)` })
      .from(pharmacyReturns)
      .where(eq(pharmacyReturns.hospitalId, hospitalId));
    const nextSeq = Number(countRes[0]?.count ?? 0) + 1;
    const year = new Date().getFullYear();
    const returnNo = formatReturnNumber('RET', year, nextSeq);

    const totalRefundPaise = input.items.reduce((sum, item) => sum + item.refundAmountPaise, 0);

    const [ret] = await tx
      .insert(pharmacyReturns)
      .values({
        hospitalId,
        returnNo,
        saleId: input.saleId,
        reason: input.reason,
        refundMode: input.refundMode,
        refundAmountPaise: totalRefundPaise,
        returnedByUserId: input.returnedByUserId ?? null,
      })
      .returning({ id: pharmacyReturns.id });

    for (const item of input.items) {
      await tx.insert(pharmacyReturnItems).values({
        hospitalId,
        returnId: ret.id,
        saleItemId: item.saleItemId,
        batchId: item.batchId,
        quantityReturned: item.quantityReturned,
        refundAmountPaise: item.refundAmountPaise,
      });

      // Find medicineId for this batch
      const [batch] = await tx
        .select({ medicineId: stockBatches.medicineId })
        .from(stockBatches)
        .where(eq(stockBatches.id, item.batchId));

      if (batch) {
        // Restock ledger: kind = receive, positive quantity
        await tx.insert(stockLedger).values({
          hospitalId,
          locationId,
          medicineId: batch.medicineId,
          batchId: item.batchId,
          kind: 'receive',
          quantity: item.quantityReturned,
          source: 'pharmacy_return',
          recordedByUserId: input.returnedByUserId,
        });
      }
    }

    // Update sale status to returned or partially_returned
    await tx
      .update(pharmacySales)
      .set({ status: 'returned' })
      .where(eq(pharmacySales.id, input.saleId));

    return {
      returnId: ret.id,
      returnNo,
      refundAmountPaise: totalRefundPaise,
    };
  });
}
