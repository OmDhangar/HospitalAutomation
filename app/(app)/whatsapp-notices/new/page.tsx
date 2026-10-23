import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { getAdminDb } from '@/lib/db/admin';
import { hospitals } from '@/lib/db/schema';
import { NoticeWizard } from '@/components/whatsapp-notices/notice-wizard';

export const metadata = {
  title: 'Create WhatsApp Notice | Hospital Admin',
  description: 'Create and dispatch priority-based WhatsApp closure notices to patients.',
};

export default async function NewWhatsAppNoticePage() {
  const session = await requireSession();

  if (session.role !== 'owner' && session.role !== 'receptionist') {
    redirect('/dashboard');
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
