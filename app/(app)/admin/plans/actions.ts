'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { quoteCustomPlan } from '@/lib/domain/custom-plan';
import { createCustomPlan, CustomPlanError } from '@/lib/services/custom-plans';
import { resolvePaisePerMessage } from '@/lib/services/platform';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = (formData: FormData, key: string): number => {
  const value = Number(String(formData.get(key) ?? '').trim());
  return Number.isFinite(value) ? value : 0;
};

const flag = (formData: FormData, key: string): boolean => formData.get(key) !== null;

/**
 * Creates a bespoke plan from the builder.
 *
 * The allowances are recomputed here rather than taken from the form. The
 * builder posts what it displayed, but a form field is whatever the browser
 * says it is, and an allowance that does not match the price is a billing
 * dispute six months from now. The price itself is accepted as sent — that one
 * is a judgement the operator is entitled to make.
 */
export async function createCustomPlanAction(formData: FormData) {
  const session = await requirePlatformAdmin();

  const hospitalId = String(formData.get('hospitalId') ?? '').trim();
  if (!UUID_RE.test(hospitalId)) redirect('/admin/plans?error=INVALID_INPUT');

  const monthlyPricePaise = Math.round(num(formData, 'monthlyPricePaise'));
  const patientsPerDay = Math.round(num(formData, 'patientsPerDay'));
  const billingCycle =
    String(formData.get('billingCycle') ?? 'monthly') === 'annual' ? 'annual' : 'monthly';

  if (monthlyPricePaise < 0 || patientsPerDay <= 0) {
    redirect('/admin/plans?error=INVALID_INPUT');
  }

  const maxBranches = Math.round(num(formData, 'maxBranches'));
  const maxDoctors = Math.round(num(formData, 'maxDoctors'));
  const maxStaffLogins = Math.round(num(formData, 'maxStaffLogins'));

  const rate = await resolvePaisePerMessage();
  const quote = quoteCustomPlan({
    patientsPerDay,
    branches: maxBranches,
    doctors: maxDoctors,
    staffLogins: maxStaffLogins,
    paisePerMessage: rate.paise,
    // Irrelevant to the allowances, which is all we take from the quote here.
    targetMargin: 0.65,
    billingCycle,
  });

  try {
    const { code } = await createCustomPlan({
      hospitalId,
      name: String(formData.get('name') ?? '').trim(),
      monthlyPricePaise,
      annualPricePaise: Math.round(num(formData, 'annualPricePaise')) || monthlyPricePaise * 10,
      setupFeePaise: quote.setupFeePaise,
      patientsPerDay,
      includedAppointments: quote.includedAppointments,
      includedMessages: quote.includedMessages,
      // Zero means "not limited" from a number input that cannot express null.
      maxBranches: maxBranches > 0 ? maxBranches : null,
      maxDoctors: maxDoctors > 0 ? maxDoctors : null,
      maxStaffLogins: maxStaffLogins > 0 ? maxStaffLogins : null,
      supportTier: String(formData.get('supportTier') ?? 'dedicated'),
      hasDisplayBoard: flag(formData, 'hasDisplayBoard'),
      hasOwnerReport: flag(formData, 'hasOwnerReport'),
      hasAdvancedReports: flag(formData, 'hasAdvancedReports'),
      hasDataExport: flag(formData, 'hasDataExport'),
      hasAuditLog: flag(formData, 'hasAuditLog'),
      assign: formData.get('assign') === 'true',
      billingCycle,
      actorUserId: session.userId,
    });

    revalidatePath('/admin/plans');
    revalidatePath(`/admin/hospitals/${hospitalId}`);
    redirect(`/admin/hospitals/${hospitalId}?done=custom_plan&code=${encodeURIComponent(code)}`);
  } catch (error) {
    if (error instanceof CustomPlanError) {
      redirect(`/admin/plans?error=${error.code}`);
    }
    throw error;
  }
}
