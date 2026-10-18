import { sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { auditLogs, hospitalFeatures } from '@/lib/db/schema';
import { depositAlert, type DepositAlert, type DepositAlertSettings } from '@/lib/domain/discharge-bill';

/**
 * Deposit alerts (IPD sheets plan B2, D-DEP): patients in a bed whose charges
 * have used up most of what they paid, or who owe more than the limit, for
 * the desk to ask for more deposit before the bill grows. Read on demand from
 * the bill lines and payments as they are — nothing is stored.
 */

export class DepositAlertError extends Error {}

export type DepositAlertRow = DepositAlert & {
  admissionId: string;
  patientName: string;
  bed: string | null;
  totalPaise: number;
  paidPaise: number;
};

export async function listDepositAlerts(args: { hospitalId: string; branchId?: string | null; settings: DepositAlertSettings }): Promise<DepositAlertRow[]> {
  const rows = await withTenant(args.hospitalId, (tx) =>
    tx.execute<{ admission_id: string; patient_name: string; bed: string | null; total_paise: number; paid_paise: number }>(sql`
      select a.id as admission_id, p.name as patient_name,
        (select w.name || ' · Bed ' || b.label from bed_assignments ba join beds b on b.id = ba.bed_id join wards w on w.id = b.ward_id
          where ba.admission_id = a.id and ba.to_at is null limit 1) as bed,
        coalesce((select sum(bi.total_paise) from bill_items bi join bills bl on bl.id = bi.bill_id
          where bl.encounter_id = a.encounter_id and bl.status <> 'cancelled' and bi.voided_at is null), 0)::int as total_paise,
        coalesce((select sum(case when pp.kind = 'refund' then -pp.amount_paise else pp.amount_paise end) from patient_payments pp
          where pp.encounter_id = a.encounter_id and pp.voided_at is null), 0)::int as paid_paise
      from admissions a
      join patients p on p.id = a.patient_id
      where a.status in ('admitted', 'discharge_ready')
        ${args.branchId ? sql`and a.branch_id = ${args.branchId}::uuid` : sql``}
    `),
    // Admissions are medical records (0028): read with the clinical key, as the census does.
    { clinical: true },
  );
  const alerts: DepositAlertRow[] = [];
  for (const r of rows) {
    const alert = depositAlert({ totalPaise: Number(r.total_paise), paidPaise: Number(r.paid_paise), settings: args.settings });
    if (alert) {
      alerts.push({ ...alert, admissionId: r.admission_id, patientName: r.patient_name, bed: r.bed, totalPaise: Number(r.total_paise), paidPaise: Number(r.paid_paise) });
    }
  }
  return alerts.sort((a, b) => (a.reason === b.reason ? b.balancePaise - a.balancePaise : a.reason === 'owed' ? -1 : 1));
}

/** The owner sets when the alert comes up: percentage of the deposit used, and the amount owed. */
export async function updateDepositAlertSettings(args: { hospitalId: string; usedPct: number; balanceRupees: number; actorUserId: string }): Promise<void> {
  if (!Number.isInteger(args.usedPct) || args.usedPct < 50 || args.usedPct > 100) throw new DepositAlertError('Percentage: a whole number from 50 to 100');
  if (!Number.isInteger(args.balanceRupees) || args.balanceRupees < 0 || args.balanceRupees > 10_00_000) throw new DepositAlertError('Amount owed: whole rupees, up to 10,00,000');
  const settings = { usedPct: args.usedPct, balanceRupees: args.balanceRupees };
  await withTenant(args.hospitalId, async (tx) => {
    await tx
      .insert(hospitalFeatures)
      .values({ hospitalId: args.hospitalId, moduleId: 'deposit_alert', state: 'off', settings, updatedByUserId: args.actorUserId })
      .onConflictDoUpdate({
        target: [hospitalFeatures.hospitalId, hospitalFeatures.moduleId],
        set: { settings, updatedByUserId: args.actorUserId, updatedAt: new Date() },
      });
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'billing.deposit_alert_settings',
      objectType: 'hospital',
      objectId: args.hospitalId,
      metadata: settings,
    });
  });
}
