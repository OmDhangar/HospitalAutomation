import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';

export const metadata = { title: 'Patient · IPD' };

interface AdmissionPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Admission route: directs nurses to their bedside treatment workspace,
 * and doctors/administrators to the clinical summary cockpit.
 */
export default async function AdmissionPage({ params }: AdmissionPageProps) {
  const session = await requireSession();
  const { id } = await params;
  if (session.role === 'nurse') {
    redirect(`/ipd/admissions/${id}/treatment`);
  }
  redirect(`/ipd/patients/${id}/summary`);
}
