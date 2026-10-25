import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { getAdminDb } from '@/lib/db/admin';
import { hospitals } from '@/lib/db/schema';
import { NoticeWizard } from '@/components/whatsapp-notices/notice-wizard';
import { getPlanAccess } from '@/lib/services/subscriptions';
import { getFeatureDecision } from '@/lib/domain/plan-policy';

export const metadata = {
  title: 'Create WhatsApp Notice | Hospital Admin',
  description: 'Create and dispatch priority-based WhatsApp closure notices to patients.',
};

export default async function NewWhatsAppNoticePage() {
  const session = await requireSession();

  if (session.role !== 'owner' && session.role !== 'receptionist') {
    redirect('/dashboard');
  }

  const access = await getPlanAccess(session.hospitalId);
  if (getFeatureDecision({ access, feature: 'messaging.campaigns' }) === 'blocked') {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
        <h2 className="text-lg font-semibold text-amber-900">Broadcast Campaigns Paused</h2>
        <p className="mt-2 text-sm text-amber-800">
          WhatsApp broadcast notices are currently paused because the hospital plan is overdue or inactive. Essential one-to-one queue notices continue to work.
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <Link
            href="/whatsapp-notices"
            className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
          >
            Back to Notices
          </Link>
          <Link
            href="/subscription"
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
          >
            Renew Plan
          </Link>
        </div>
      </div>
    );
  }

  const db = getAdminDb();
  const [hospital] = await db
    .select({
      name: hospitals.name,
      ownerPhoneE164: hospitals.ownerPhoneE164,
      letterheadPhones: hospitals.letterheadPhones,
    })
    .from(hospitals)
    .where(eq(hospitals.id, session.hospitalId));

  const hospitalName = hospital?.name || 'Hospital OPD';
  const defaultPhone = hospital?.letterheadPhones?.split(/[,/]/)[0]?.trim() || hospital?.ownerPhoneE164 || '';

  return (
    <NoticeWizard
      hospitalId={session.hospitalId}
      hospitalName={hospitalName}
      defaultPhone={defaultPhone}
    />
  );
}
