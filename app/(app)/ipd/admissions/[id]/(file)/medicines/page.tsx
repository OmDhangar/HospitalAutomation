import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';

export const metadata = { title: 'Home medicines · IPD' };

interface MedicinesPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Legacy medicines/medrec sheet route. Directs users directly to the modern
 * inpatient patient cockpit discharge & medication reconciliation view.
 * Guard: requireModule('med_reconciliation')
 */
export default async function MedicinesPage({ params }: MedicinesPageProps) {
  await requireSession();
  const { id } = await params;
  redirect(`/ipd/patients/${id}/discharge`);
}
