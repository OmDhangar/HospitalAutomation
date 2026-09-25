'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cancelByPublicToken } from '@/lib/services/queue';
import { consumeToken } from '@/lib/security/rate-limit';

/**
 * A patient calling off their own appointment.
 *
 * Unauthenticated by design. The public token in the URL is the credential —
 * the same one that lets them see the page — because it arrived on their own
 * phone. Requiring a login to cancel is how you guarantee nobody does, and a
 * no-show costs the hospital more than a cancellation ever could.
 */
export async function cancelAppointment(formData: FormData) {
  const token = String(formData.get('token') ?? '').trim();
  const lang = String(formData.get('lang') ?? '').trim();
  const suffix = lang ? `&lang=${encodeURIComponent(lang)}` : '';

  if (!token) redirect('/');

  /**
   * Throttled per token, not per IP.
   *
   * The endpoint is public and writes to the database, so it needs a bound.
   * Keying on the token means a patient on a shared mobile network is never
   * blocked by a stranger's activity, while the same link cannot be hammered.
   * Cancelling is idempotent anyway — this exists to stop the write, not to
   * protect correctness.
   */
  const limit = consumeToken({
    key: `q:cancel:${token}`,
    capacity: 5,
    windowMs: 60_000,
  });
  if (!limit.allowed) redirect(`/q/${token}?cancel=busy${suffix}`);

  const result = await cancelByPublicToken({ publicToken: token });

  revalidatePath(`/q/${token}`);

  // The page reads its own state after this, so the outcome only has to steer
  // which message is shown, not carry any data.
  redirect(
    `/q/${token}?cancel=${
      result.outcome === 'cancelled' || result.outcome === 'already_cancelled'
        ? 'done'
        : result.outcome === 'too_late'
          ? 'late'
          : 'error'
    }${suffix}`,
  );
}
