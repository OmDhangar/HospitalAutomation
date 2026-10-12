import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { withTenant } from '@/lib/db';
import { doctors } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRoundingCockpitData } from '@/lib/services/ipd-rounding-cockpit';
import { RoundingCockpit } from '@/components/ipd/rounding/rounding-cockpit';
import { loadAdmission } from '../data';

export const metadata = { title: 'Doctor Rounding Cockpit · IPD' };

export default async function RoundsPage({
  params,
}: PageProps<'/ipd/admissions/[id]/rounds'>) {
  const session = await requireSession();
  await requireModule(session, 'patient_file');
  const { id } = await params;

  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();

  // Load aggregated rounding cockpit data
  const cockpitData = await getRoundingCockpitData({
    hospitalId: session.hospitalId,
    admissionId: id,
    userId: session.userId,
    timezone: session.timezone,
  });

  // Check if session user is linked to a doctor
  const [doc] = await withTenant(session.hospitalId, async (tx) =>
    tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, session.userId)),
  );

  const canPrescribe = can(session.role, 'ipd.prescribe') && !session.readOnly;

  return (
    <div className="space-y-4">
      <RoundingCockpit
        initialData={cockpitData}
        doctorId={doc?.id}
        readOnly={!canPrescribe}
      />
    </div>
  );
}
