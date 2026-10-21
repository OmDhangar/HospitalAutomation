import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';

export const metadata = { title: 'Claims & TPA Desk · IPD' };

export default async function ClaimsDeskPage() {
  const session = await requireSession();
  await requireModule(session, 'claims_tracker');
  if (!can(session.role, 'claims.view')) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink-900 tracking-tight">Claims & TPA Desk</h1>
          <p className="text-sm text-ink-600 mt-1">
            Pre-authorizations, query countdowns, and insurer settlement workflow.
          </p>
        </div>
      </div>
      <div className="p-8 text-center text-ink-500 border border-dashed rounded-lg bg-surface-subtle">
        Claims Desk high-density operational view
      </div>
    </div>
  );
}
