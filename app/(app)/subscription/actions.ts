'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import {
  PaymentError,
  reconcilePayment,
  startRenewalCheckout,
} from '@/lib/services/payments';

/**
 * Sends the owner to Razorpay to renew.
 *
 * The hospital is taken from the session and the amount from the stored
 * subscription — nothing about what gets charged comes from the form, so there
 * is no field to tamper with. The action's only job is to produce a URL.
 */
export async function renewPlan() {
  const session = await requireSession();

  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!baseUrl) {
    // Without this, Razorpay's callback would point at nothing and a paying
    // customer would land on a broken page. Better to refuse up front.
    redirect('/subscription?error=NOT_CONFIGURED');
  }

  let checkout;
  try {
    checkout = await startRenewalCheckout({
      hospitalId: session.hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        isPlatformAdmin: session.isPlatformAdmin,
      },
      baseUrl,
      timezone: session.timezone,
    });
  } catch (error) {
    if (error instanceof PaymentError) {
      redirect(`/subscription?error=${error.code}`);
    }
    throw error;
  }

  // redirect() throws, so it must sit outside the try above or it would be
  // caught as a failure and turned into an error page.
  redirect(checkout.url);
}

/**
 * Checks with Razorpay whether a payment actually completed.
 *
 * Called when the owner returns from the payment page. The redirect itself
 * proves nothing — it is a URL anybody can visit — so this re-reads the link's
 * real status from the gateway. It exists for the case where the webhook never
 * arrived: a hospital that has genuinely paid recovers by reloading rather than
 * waiting for someone to notice.
 */
export async function checkPaymentStatus(formData: FormData) {
  const session = await requireSession();
  const paymentId = String(formData.get('paymentId') ?? '').trim();
  if (!paymentId) redirect('/subscription');

  try {
    const result = await reconcilePayment({
      hospitalId: session.hospitalId,
      paymentId,
    });

    revalidatePath('/subscription');
    redirect(
      result.outcome === 'unknown_reference'
        ? '/subscription?payment=pending'
        : '/subscription?payment=confirmed',
    );
  } catch (error) {
    if (error instanceof PaymentError) {
      redirect(`/subscription?error=${error.code}`);
    }
    throw error;
  }
}
