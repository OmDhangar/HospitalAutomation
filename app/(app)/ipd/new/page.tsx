import Link from 'next/link';
import { Card, EmptyState } from '@/components/ui';
import { UnifiedIntakeForm } from '@/components/ipd/intake/unified-intake-form';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { listBranches } from '@/lib/services/auth';
import { listDoctors } from '@/lib/services/hospital';
import { listFreeBeds } from '@/lib/services/ipd-census';

export const metadata = { title: 'New Admission · IPD' };

export default async function NewAdmissionPage({ searchParams }: PageProps<'/ipd/new'>) {
  const session = await requireSession();
  const query = await searchParams;

  if (!can(session.role, 'ipd.admit')) {
    return (
      <Card>
        <EmptyState title="The desk admits patients" hint="Ask reception to admit this patient." />
      </Card>
    );
  }

  const branchRows = await listBranches(session.hospitalId);
  const branchId = session.branchId ?? branchRows[0]?.id ?? '';
  const [doctorRows, freeWards] = await Promise.all([
    listDoctors({ hospitalId: session.hospitalId, branchId }),
    branchId ? listFreeBeds({ hospitalId: session.hospitalId, branchId }) : Promise.resolve([]),
  ]);

  const preselectedBedId = typeof query.bed === 'string' ? query.bed : null;

  return (
    <UnifiedIntakeForm
      mode="direct"
      branchId={branchId}
      freeWards={freeWards}
      doctors={doctorRows}
      preselectedBedId={preselectedBedId}
    />
  );
}
