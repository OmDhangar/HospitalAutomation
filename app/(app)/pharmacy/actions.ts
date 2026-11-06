'use server';

import { and, eq, ilike, or } from 'drizzle-orm';
import { requireWritableSession } from '@/lib/auth/session';
import { can, type Permission } from '@/lib/domain/permissions';
import { withTenant } from '@/lib/db';
import { medicines } from '@/lib/db/schema';
import {
  getAvailableBatchesForMedicine,
  getPharmacyLocation,
  getPrescriptionFulfillmentQueue,
  processPharmacyReturn,
  processPharmacySale,
  type ProcessReturnInput,
  type ProcessSaleInput,
} from '@/lib/services/pharmacy';

async function authorize(permission: Permission) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) {
    throw new Error('Your login cannot do this');
  }
  return session;
}

export async function getQueueAction() {
  try {
    const session = await authorize('stock.view');
    const queue = await getPrescriptionFulfillmentQueue(session.hospitalId);
    return { success: true, queue };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to fetch queue' };
  }
}

export async function searchMedicinesAction(query: string) {
  try {
    const session = await authorize('stock.view');
    const term = `%${query.trim()}%`;
    const rows = await withTenant(session.hospitalId, async (tx) => {
      return tx
        .select({
          id: medicines.id,
          name: medicines.name,
          genericName: medicines.genericName,
          strength: medicines.strength,
          form: medicines.form,
          sellingPricePaise: medicines.sellingPricePaise,
          taxRateBp: medicines.taxRateBp,
        })
        .from(medicines)
        .where(
          and(
            eq(medicines.hospitalId, session.hospitalId),
            eq(medicines.active, true),
            or(ilike(medicines.name, term), ilike(medicines.genericName, term))
          )
        )
        .limit(20);
    });

    return { success: true, medicines: rows };
  } catch (err: any) {
    return { success: false, error: err.message || 'Search failed', medicines: [] };
  }
}

export async function getBatchesAction(medicineId: string) {
  try {
    const session = await authorize('stock.view');
    const locationId = await withTenant(session.hospitalId, async (tx) => {
      return getPharmacyLocation(session.hospitalId, tx);
    });

    const batches = await getAvailableBatchesForMedicine(
      session.hospitalId,
      locationId,
      medicineId
    );
    return { success: true, batches };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to fetch batches', batches: [] };
  }
}

export async function completeSaleAction(
  input: Omit<ProcessSaleInput, 'dispensedByUserId'>
) {
  try {
    const session = await authorize('stock.move');
    const result = await processPharmacySale(session.hospitalId, {
      ...input,
      dispensedByUserId: session.userId,
    });
    return {
      success: true,
      saleId: result.saleId,
      saleNo: result.saleNo,
      totalPaise: result.totalPaise,
      receipt: result.receipt,
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to complete sale' };
  }
}

export async function processReturnAction(
  input: Omit<ProcessReturnInput, 'returnedByUserId'>
) {
  try {
    const session = await authorize('stock.move');
    const result = await processPharmacyReturn(session.hospitalId, {
      ...input,
      returnedByUserId: session.userId,
    });
    return {
      success: true,
      returnId: result.returnId,
      returnNo: result.returnNo,
      refundAmountPaise: result.refundAmountPaise,
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to process return' };
  }
}
