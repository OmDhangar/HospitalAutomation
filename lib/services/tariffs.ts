import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  chargeItems,
  chargeItemTariffs,
  encounterPayers,
  ratePlans,
} from '@/lib/db/schema';
import { resolveTariffPrice } from '@/lib/domain/tariff';

export interface RatePlanInput {
  name: string;
  code: string;
  payerKind: 'self' | 'insurer' | 'tpa' | 'corporate';
  payerName?: string | null;
  modifierBp?: number;
  isDefault?: boolean;
  active?: boolean;
}

export interface SetTariffInput {
  ratePlanId: string;
  chargeItemId: string;
  tariffPricePaise: number;
}

/** Lists active rate plans for a hospital. */
export async function listRatePlansInTx(tx: Tx, hospitalId: string) {
  return tx
    .select()
    .from(ratePlans)
    .where(and(eq(ratePlans.hospitalId, hospitalId), isNull(ratePlans.voidedAt)))
    .orderBy(desc(ratePlans.isDefault), ratePlans.name);
}

/** Gets a rate plan by ID along with its configured charge item tariffs. */
export async function getRatePlanByIdInTx(tx: Tx, hospitalId: string, ratePlanId: string) {
  const [plan] = await tx
    .select()
    .from(ratePlans)
    .where(
      and(
        eq(ratePlans.hospitalId, hospitalId),
        eq(ratePlans.id, ratePlanId),
        isNull(ratePlans.voidedAt),
      ),
    );
  if (!plan) return null;

  const tariffs = await tx
    .select({
      id: chargeItemTariffs.id,
      chargeItemId: chargeItemTariffs.chargeItemId,
      tariffPricePaise: chargeItemTariffs.tariffPricePaise,
      chargeItemName: chargeItems.name,
      chargeItemKind: chargeItems.kind,
      basePricePaise: chargeItems.sellingPricePaise,
    })
    .from(chargeItemTariffs)
    .innerJoin(chargeItems, eq(chargeItems.id, chargeItemTariffs.chargeItemId))
    .where(
      and(
        eq(chargeItemTariffs.hospitalId, hospitalId),
        eq(chargeItemTariffs.ratePlanId, ratePlanId),
        isNull(chargeItemTariffs.voidedAt),
      ),
    );

  return { plan, tariffs };
}

/** Saves (creates or updates) a rate plan, enforcing single default constraint. */
export async function saveRatePlanInTx(
  tx: Tx,
  hospitalId: string,
  data: RatePlanInput & { id?: string },
  actorUserId?: string | null,
) {
  const isDefault = data.isDefault ?? false;

  // Enforce single default rate plan per hospital: if this plan is default, unset any existing default
  if (isDefault) {
    await tx
      .update(ratePlans)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(ratePlans.hospitalId, hospitalId),
          eq(ratePlans.isDefault, true),
          isNull(ratePlans.voidedAt),
        ),
      );
  }

  if (data.id) {
    const [updated] = await tx
      .update(ratePlans)
      .set({
        name: data.name.trim(),
        code: data.code.trim().toUpperCase(),
        payerKind: data.payerKind,
        payerName: data.payerName ? data.payerName.trim() : null,
        modifierBp: data.modifierBp ?? 0,
        isDefault,
        active: data.active ?? true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ratePlans.hospitalId, hospitalId),
          eq(ratePlans.id, data.id),
          isNull(ratePlans.voidedAt),
        ),
      )
      .returning();
    return updated;
  }

  const [inserted] = await tx
    .insert(ratePlans)
    .values({
      hospitalId,
      name: data.name.trim(),
      code: data.code.trim().toUpperCase(),
      payerKind: data.payerKind,
      payerName: data.payerName ? data.payerName.trim() : null,
      modifierBp: data.modifierBp ?? 0,
      isDefault,
      active: data.active ?? true,
      createdByUserId: actorUserId ?? null,
    })
    .returning();
  return inserted;
}

/** Upserts an item-specific tariff override for a rate plan. */
export async function setChargeItemTariffInTx(
  tx: Tx,
  hospitalId: string,
  data: SetTariffInput,
  actorUserId?: string | null,
) {
  const [row] = await tx
    .insert(chargeItemTariffs)
    .values({
      hospitalId,
      ratePlanId: data.ratePlanId,
      chargeItemId: data.chargeItemId,
      tariffPricePaise: Math.max(0, data.tariffPricePaise),
      createdByUserId: actorUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [chargeItemTariffs.hospitalId, chargeItemTariffs.ratePlanId, chargeItemTariffs.chargeItemId],
      targetWhere: sql`voided_at is null`,
      set: {
        tariffPricePaise: Math.max(0, data.tariffPricePaise),
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** Finds the effective rate plan for an admission (attached to encounter payer, or hospital default). */
export async function findEffectiveRatePlanForAdmissionInTx(
  tx: Tx,
  hospitalId: string,
  admissionId: string,
): Promise<{ id: string; modifierBp: number } | null> {
  const [admission] = await tx
    .select({ encounterId: admissions.encounterId })
    .from(admissions)
    .where(and(eq(admissions.id, admissionId), eq(admissions.hospitalId, hospitalId)));
  if (!admission?.encounterId) return null;

  const [payer] = await tx
    .select({ ratePlanId: encounterPayers.ratePlanId })
    .from(encounterPayers)
    .where(
      and(
        eq(encounterPayers.encounterId, admission.encounterId),
        isNull(encounterPayers.voidedAt),
      ),
    );

  if (payer?.ratePlanId) {
    const [plan] = await tx
      .select({ id: ratePlans.id, modifierBp: ratePlans.modifierBp })
      .from(ratePlans)
      .where(
        and(
          eq(ratePlans.id, payer.ratePlanId),
          eq(ratePlans.active, true),
          isNull(ratePlans.voidedAt),
        ),
      );
    if (plan) return plan;
  }

  // Fallback to hospital default rate plan
  const [defaultPlan] = await tx
    .select({ id: ratePlans.id, modifierBp: ratePlans.modifierBp })
    .from(ratePlans)
    .where(
      and(
        eq(ratePlans.hospitalId, hospitalId),
        eq(ratePlans.isDefault, true),
        eq(ratePlans.active, true),
        isNull(ratePlans.voidedAt),
      ),
    );

  return defaultPlan ?? null;
}

/**
 * Resolves a charge item's price for an inpatient stay:
 * 1. Specific item override in charge_item_tariffs.
 * 2. Rate plan modifierBp applied to base selling price.
 * 3. Base catalog selling price in charge_items.
 */
export async function resolveChargeItemPriceForStayInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    chargeItemId: string;
    ratePlanId?: string | null;
  },
): Promise<number | null> {
  let tariffOverridePrice: number | null = null;
  let modifierBp: number | null = null;

  if (args.ratePlanId) {
    const tariffRows = await tx
      .select({ tariffPricePaise: chargeItemTariffs.tariffPricePaise })
      .from(chargeItemTariffs)
      .where(
        and(
          eq(chargeItemTariffs.hospitalId, args.hospitalId),
          eq(chargeItemTariffs.ratePlanId, args.ratePlanId),
          eq(chargeItemTariffs.chargeItemId, args.chargeItemId),
          isNull(chargeItemTariffs.voidedAt),
        ),
      );

    if (tariffRows && tariffRows.length > 0) {
      tariffOverridePrice = tariffRows[0].tariffPricePaise;
    } else {
      // If no override, fetch rate plan modifierBp
      const planRows = await tx
        .select({ modifierBp: ratePlans.modifierBp })
        .from(ratePlans)
        .where(
          and(
            eq(ratePlans.hospitalId, args.hospitalId),
            eq(ratePlans.id, args.ratePlanId),
            isNull(ratePlans.voidedAt),
          ),
        );
      if (planRows && planRows.length > 0) {
        modifierBp = planRows[0].modifierBp;
      }
    }
  }

  // Fetch base catalog selling price
  const itemRows = await tx
    .select({ sellingPricePaise: chargeItems.sellingPricePaise })
    .from(chargeItems)
    .where(
      and(
        eq(chargeItems.hospitalId, args.hospitalId),
        eq(chargeItems.id, args.chargeItemId),
      ),
    );

  if (!itemRows || itemRows.length === 0) {
    return null;
  }

  const basePricePaise = itemRows[0].sellingPricePaise;

  // Resolve using pure domain calculator
  return resolveTariffPrice({
    basePricePaise,
    tariffPricePaise: tariffOverridePrice,
    modifierBp,
  });
}

/** Lists all billable non-medicine charge items for the tariff matrix editor. */
export async function listChargeItemsForTariffInTx(tx: Tx, hospitalId: string) {
  return tx
    .select({
      id: chargeItems.id,
      name: chargeItems.name,
      kind: chargeItems.kind,
      sellingPricePaise: chargeItems.sellingPricePaise,
      taxRateBp: chargeItems.taxRateBp,
      active: chargeItems.active,
    })
    .from(chargeItems)
    .where(and(eq(chargeItems.hospitalId, hospitalId), eq(chargeItems.active, true)))
    .orderBy(chargeItems.kind, chargeItems.name);
}

export async function listRatePlans(hospitalId: string) {
  return withTenant(hospitalId, (tx) => listRatePlansInTx(tx, hospitalId));
}

export async function getRatePlanById(hospitalId: string, ratePlanId: string) {
  return withTenant(hospitalId, (tx) => getRatePlanByIdInTx(tx, hospitalId, ratePlanId));
}

export async function saveRatePlan(
  hospitalId: string,
  data: RatePlanInput & { id?: string },
  actorUserId?: string | null,
) {
  return withTenant(hospitalId, (tx) => saveRatePlanInTx(tx, hospitalId, data, actorUserId));
}

export async function setChargeItemTariff(
  hospitalId: string,
  data: SetTariffInput,
  actorUserId?: string | null,
) {
  return withTenant(hospitalId, (tx) => setChargeItemTariffInTx(tx, hospitalId, data, actorUserId));
}

export async function listChargeItemsForTariff(hospitalId: string) {
  return withTenant(hospitalId, (tx) => listChargeItemsForTariffInTx(tx, hospitalId));
}

