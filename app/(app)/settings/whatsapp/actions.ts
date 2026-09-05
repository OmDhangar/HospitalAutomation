'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import { getProvider } from '@/lib/notify/provider';
import { canConfigureHospital } from '@/lib/services/auth';
import { getHospital, updateWhatsAppSettings } from '@/lib/services/hospital';
import {
  assignNumberToHospital,
  getHospitalNumber,
} from '@/lib/services/whatsapp-numbers';

async function authorize() {
  const session = await requireSession();
  if (!canConfigureHospital(session.role)) {
    throw new Error('Only a hospital owner can change WhatsApp settings');
  }
  return session;
}

export async function saveWhatsAppSettings(formData: FormData) {
  const session = await authorize();

  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();
  const rawOwnerPhone = String(formData.get('ownerPhone') ?? '').trim();

  const ownerPhone = rawOwnerPhone ? normalizeIndianPhone(rawOwnerPhone) : null;
  if (rawOwnerPhone && !ownerPhone) {
    redirect('/settings/whatsapp?error=phone');
  }

  await updateWhatsAppSettings({
    hospitalId: session.hospitalId,
    ownerPhoneE164: ownerPhone,
  });

  if (phoneNumberId) {
    await assignNumberToHospital({
      hospitalId: session.hospitalId,
      phoneNumberId,
      wabaId: String(formData.get('wabaId') ?? '').trim() || null,
      displayPhoneNumber: String(formData.get('displayPhone') ?? '').trim() || null,
      verifiedName: String(formData.get('verifiedName') ?? '').trim() || null,
    });
  }

  revalidatePath('/settings/whatsapp');
  redirect('/settings/whatsapp?saved=1');
}

/**
 * Sends one real message to a number the owner controls.
 *
 * This is the only way to find out whether credentials, the phone number id and
 * the approved templates actually line up — every other check is a guess.
 */
export async function sendTestMessage(formData: FormData) {
  const session = await authorize();

  const to = normalizeIndianPhone(String(formData.get('testPhone') ?? ''));
  if (!to) redirect('/settings/whatsapp?error=phone');

  const [hospital, number] = await Promise.all([
    getHospital(session.hospitalId),
    getHospitalNumber(session.hospitalId),
  ]);
  const phoneNumberId = number?.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!phoneNumberId) redirect('/settings/whatsapp?error=nonumber');

  try {
    await getProvider().sendTemplate({
      phoneNumberId,
      toPhoneE164: to,
      templateCode: 'queue_link',
      locale: hospital?.defaultLocale ?? 'en',
      variables: ['1', 'Test Doctor', `${process.env.PUBLIC_BASE_URL ?? ''}/q/test`],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    redirect(`/settings/whatsapp?error=send&detail=${encodeURIComponent(message)}`);
  }

  redirect('/settings/whatsapp?sent=1');
}
