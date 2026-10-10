'use server';

import { redirect } from 'next/navigation';
import { getSessionState, readSessionCookie } from '@/lib/auth/session';
import { isNoticeLocale } from '@/lib/domain/monitoring-notice';
import { acceptMonitoringNotice } from '@/lib/services/staff-access';

/** The person accepts the current monitoring notice, in the language they read it in. */
export async function acceptNoticeAction(form: FormData) {
  const session = await getSessionState();
  if (!session || session.locked) redirect('/login');
  if (session.readOnly) redirect('/dashboard');
  const locale = String(form.get('locale') ?? 'en');
  await acceptMonitoringNotice({
    hospitalId: session.hospitalId,
    userId: session.userId,
    locale: isNoticeLocale(locale) ? locale : 'en',
    channel: session.channel,
    deviceId: session.deviceId,
    token: await readSessionCookie(),
  });
  redirect(session.channel === 'ward_device' ? '/ipd' : '/dashboard');
}
