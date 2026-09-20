'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import { getProvider } from '@/lib/notify/provider';
import { canConfigureHospital } from '@/lib/services/auth';
import { getHospital, updateWhatsAppSettings } from '@/lib/services/hospital';
import {
  disconnectIntegration,
  IntegrationAuthError,
  IntegrationError,
  startOnboarding,
  validateConnection,
  type Actor,
} from '@/lib/services/whatsapp-integration';
import { getHospitalNumber } from '@/lib/services/whatsapp-numbers';

/**
 * Every mutation derives its hospital from the session and never from the form.
 *
 * A hospital id in a form field is a hospital id the browser chose, and the
 * whole tenant boundary would then rest on the server remembering to distrust
 * it. Deriving it here means there is no field to distrust.
 */
async function authorize(): Promise<{ hospitalId: string; actor: Actor }> {
  const session = await requireSession();
  if (!canConfigureHospital(session.role) && !session.isPlatformAdmin) {
    throw new IntegrationAuthError();
  }
  return {
    hospitalId: session.hospitalId,
    actor: {
      userId: session.userId,
      role: session.role,
      isPlatformAdmin: session.isPlatformAdmin,
    },
  };
}

/** Redirects with a category the page can render, never a provider message. */
function failWith(error: unknown): never {
  if (error instanceof IntegrationError) {
    redirect(`/settings/whatsapp?error=${encodeURIComponent(error.errorCode)}`);
  }
  if (error instanceof IntegrationAuthError) {
    redirect('/settings/whatsapp?error=PERMISSION_DENIED');
  }
  throw error;
}

/**
 * The hospital asks us to set WhatsApp up.
 *
 * Under platform ownership this is the entire ask. We buy the SIM, hold the
 * WABA, complete the verification and register the number; the owner's part is
 * this button and, later, approving the display name their patients will see.
 */
export async function requestWhatsAppSetup() {
  const { hospitalId, actor } = await authorize();

  try {
    await startOnboarding({ hospitalId, actor });
  } catch (error) {
    failWith(error);
  }

  revalidatePath('/settings/whatsapp');
  redirect('/settings/whatsapp?requested=1');
}

/** Asks Meta whether the number is still ours, still registered, still healthy. */
export async function validateWhatsAppConnection() {
  const { hospitalId, actor } = await authorize();

  try {
    await validateConnection({ hospitalId, actor });
  } catch (error) {
    failWith(error);
  }

  revalidatePath('/settings/whatsapp');
  redirect('/settings/whatsapp?validated=1');
}

/**
 * Stops QueueCare using this hospital's WhatsApp.
 *
 * Nothing is deleted: the Meta account is untouched, the number row survives,
 * and every message already sent stays in the record. What changes is that the
 * number leaves `registered`, which is the single condition
 * `resolve_whatsapp_number` checks — so inbound routing stops at the database
 * rather than at a flag some code path might forget to read.
 */
export async function disconnectWhatsApp(formData: FormData) {
  const { hospitalId, actor } = await authorize();

  // Typed confirmation, because this silently stops every patient notification
  // and the person clicking it may not be the person who will notice.
  if (String(formData.get('confirm') ?? '').trim().toUpperCase() !== 'DISCONNECT') {
    redirect('/settings/whatsapp?error=CONFIRM');
  }

  try {
    await disconnectIntegration({ hospitalId, actor });
  } catch (error) {
    failWith(error);
  }

  revalidatePath('/settings/whatsapp');
  redirect('/settings/whatsapp?disconnected=1');
}

/** Where the monthly summary goes. Not part of the integration, but it lives here. */
export async function saveOwnerPhone(formData: FormData) {
  const { hospitalId } = await authorize();

  const raw = String(formData.get('ownerPhone') ?? '').trim();
  const ownerPhone = raw ? normalizeIndianPhone(raw) : null;
  if (raw && !ownerPhone) redirect('/settings/whatsapp?error=PHONE');

  await updateWhatsAppSettings({ hospitalId, ownerPhoneE164: ownerPhone });

  revalidatePath('/settings/whatsapp');
  redirect('/settings/whatsapp?saved=1');
}

/**
 * Sends one real message to a number the owner controls.
 *
 * Still the only end-to-end proof that credentials, number and approved
 * templates line up. Validation confirms the first two against Meta's
 * configuration API; only an actual send exercises the templates.
 */
export async function sendTestMessage(formData: FormData) {
  const { hospitalId } = await authorize();

  const to = normalizeIndianPhone(String(formData.get('testPhone') ?? ''));
  if (!to) redirect('/settings/whatsapp?error=PHONE');

  const [hospital, number] = await Promise.all([
    getHospital(hospitalId),
    getHospitalNumber(hospitalId),
  ]);

  if (!number?.phoneNumberId) redirect('/settings/whatsapp?error=CONFIGURATION_ERROR');

  try {
    await getProvider().sendTemplate({
      phoneNumberId: number.phoneNumberId,
      toPhoneE164: to,
      templateCode: 'queue_link',
      locale: hospital?.defaultLocale ?? 'en',
      variables: ['1', 'Test Doctor', `${process.env.PUBLIC_BASE_URL ?? ''}/q/test`],
    });
  } catch {
    // The provider's message names the template, the token and the Graph
    // endpoint. None of that belongs in a query string or on a settings page.
    redirect('/settings/whatsapp?error=SEND');
  }

  redirect('/settings/whatsapp?sent=1');
}
