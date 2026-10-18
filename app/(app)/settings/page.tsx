import { Card, EmptyState } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { canConfigureHospital, listBranches, listStaffMembers } from '@/lib/services/auth';
import { describeLimit } from '@/lib/services/entitlements';
import { listDoctors } from '@/lib/services/hospital';
import { getConsultationFees } from '@/lib/services/patient-billing';
import { serviceDateIn } from '@/lib/domain/time';
import { SettingsClientView } from './settings-client-view';

export const metadata = { title: 'Settings · OPD Queue' };

export default async function SettingsPage({ searchParams }: PageProps<'/settings'>) {
  const session = await requireSession();
  const params = await searchParams;
  const today = serviceDateIn(session.timezone, new Date());

  /**
   * Recomputed here rather than passed through the redirect, so the secret of
   * what the plan allows is never a URL parameter somebody can edit, and the
   * numbers shown are the ones true at render time.
   */
  const limitKind =
    params.limit === 'branches'
      ? 'branches'
      : params.limit === 'doctors'
        ? 'doctors'
        : params.limit === 'staff'
          ? 'staff'
          : null;
  const limitHit = limitKind
    ? await describeLimit({ hospitalId: session.hospitalId, kind: limitKind })
    : null;

  if (!canConfigureHospital(session.role)) {
    return (
      <Card>
        <EmptyState
          title="Only the hospital owner can change settings"
          hint="Ask your administrator if a doctor or branch needs adding."
        />
      </Card>
    );
  }

  const [branches, doctors, staff] = await Promise.all([
    listBranches(session.hospitalId),
    listDoctors({ hospitalId: session.hospitalId, includeInactive: true }),
    listStaffMembers(session.hospitalId),
  ]);

  const feesMap = await getConsultationFees(
    session.hospitalId,
    doctors.map((d) => d.id),
  );

  const fees: Record<string, number> = {};
  feesMap.forEach((val, key) => {
    fees[key] = val;
  });

  return (
    <SettingsClientView
      session={{
        hospitalId: session.hospitalId,
        hospitalName: session.hospitalName,
        timezone: session.timezone,
        role: session.role,
        userId: session.userId,
      }}
      branches={branches}
      doctors={doctors}
      staff={staff}
      fees={fees}
      limitHit={limitHit}
      today={today}
      searchParams={params}
    />
  );
}
