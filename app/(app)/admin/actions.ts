'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { isPlausiblePhoneNumberId } from '@/lib/domain/whatsapp-integration';
import {
  assignNumberToHospital,
  IntegrationAuthError,
  IntegrationError,
  type Actor,
} from '@/lib/services/whatsapp-integration';
import {
  refreshNumberHealth,
  returnNumberToInventory,
} from '@/lib/services/whatsapp-numbers';

/**
 * Platform operations, all of which cross tenant boundaries by design.
 *
 * `isPlatformAdmin` is checked here and again inside each service function.
 * That duplication is deliberate: this file is the only place a platform action
 * is currently reachable from, and it will not stay that way.
 */
async function authorizePlatform(): Promise<Actor> {
  const session = await requireSession();
  if (!session.isPlatformAdmin) throw new IntegrationAuthError();
  return {
    userId: session.userId,
    role: session.role,
    isPlatformAdmin: true,
  };
}

function failWith(error: unknown): never {
  if (error instanceof IntegrationError) {
    redirect(`/admin?error=${encodeURIComponent(error.errorCode)}`);
  }
  if (error instanceof IntegrationAuthError) {
    redirect('/admin?error=PERMISSION_DENIED');
  }
  throw error;
}

/**
 * Gives a hospital one of our numbers.
 *
 * The hospital id comes from a select on the platform dashboard rather than
 * from a session, because this is the one flow that legitimately acts on
 * another tenant. It is safe only because the service re-checks platform
 * admin and because Meta is asked to confirm the number is in our WABA before
 * anything is written.
 */
export async function assignNumber(formData: FormData) {
  const actor = await authorizePlatform();

  const hospitalId = String(formData.get('hospitalId') ?? '').trim();
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();

  if (!hospitalId) redirect('/admin?error=CONFIGURATION_ERROR');
  if (!isPlausiblePhoneNumberId(phoneNumberId)) {
    redirect('/admin?error=INVALID_PHONE_NUMBER');
  }

  try {
    await assignNumberToHospital({ hospitalId, phoneNumberId, actor });
  } catch (error) {
    failWith(error);
  }

  revalidatePath('/admin');
  redirect('/admin?assigned=1');
}

/** Pulls the current quality rating and throughput tier from Meta. */
export async function refreshHealth(formData: FormData) {
  const actor = await authorizePlatform();
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();

  try {
    await refreshNumberHealth({ phoneNumberId, actor });
  } catch (error) {
    failWith(error);
  }

  revalidatePath('/admin');
  redirect('/admin?refreshed=1');
}

/** Takes a number back for the next customer. */
export async function releaseNumber(formData: FormData) {
  const actor = await authorizePlatform();
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();

  if (String(formData.get('confirm') ?? '').trim().toUpperCase() !== 'RELEASE') {
    redirect('/admin?error=CONFIRM');
  }

  try {
    await returnNumberToInventory({ phoneNumberId, actor });
  } catch (error) {
    failWith(error);
  }

  revalidatePath('/admin');
  redirect('/admin?released=1');
}
