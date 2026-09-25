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

  /**
   * Back to our own page, not out to the gateway.
   *
   * `redirect()` in a Server Action performs a client-side navigation when
   * JavaScript is available, and a client-side navigation cannot cross
   * origins — so redirecting straight to rzp.io did nothing visible while
   * still creating the link. The button looked dead, and each later press
   * found and reused the same unpaid link.
   *
   * The page then renders that link as a plain anchor, which is the one
   * navigation a browser is guaranteed to perform.
   *
   * redirect() throws, so it sits outside the try above rather than being
   * caught as a failure.
   */
  revalidatePath('/subscription');
  redirect(`/subscription?pay=${checkout.paymentId}`);
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
