'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { recordProviderInvoice } from '@/lib/services/platform';

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Records a provider invoice, which is what turns cost-per-message from an
 * estimate into a reconciliation — and with it every contribution figure on
 * the overview.
 */
export async function recordInvoiceAction(formData: FormData) {
  await requirePlatformAdmin();

  const month = String(formData.get('periodMonth') ?? '').trim();
  const messagesBilled = Number(String(formData.get('messagesBilled') ?? '').trim());
  const rupees = Number(String(formData.get('amountRupees') ?? '').trim());

  if (
    !MONTH_RE.test(month) ||
    !Number.isFinite(messagesBilled) ||
    messagesBilled < 0 ||
    !Number.isFinite(rupees) ||
    rupees < 0
  ) {
    redirect('/admin/revenue?error=INVALID_INPUT');
  }

  await recordProviderInvoice({
    // Stored as the first day of the billed month, which is what the unique
    // key and the cost lookup both expect.
    periodMonth: `${month}-01`,
    messagesBilled: Math.round(messagesBilled),
    amountPaise: Math.round(rupees * 100),
    notes: String(formData.get('notes') ?? '').trim() || null,
  });

  revalidatePath('/admin/revenue');
  revalidatePath('/admin');
  redirect('/admin/revenue?done=1');
}
