import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';

export const metadata = { title: 'Patient · IPD' };

interface AdmissionPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Admission route: directs authenticated users directly to the patient summary cockpit
 * (or bedside eMAR for nurses). Unauthenticated users are redirected to login by requireSession.
 */
export default async function AdmissionPage({ params }: AdmissionPageProps) {
  const session = await requireSession();
  const { id } = await params;
  if (session.role === 'nurse') {
    redirect(`/ipd/patients/${id}/emar`);
  }
  redirect(`/ipd/patients/${id}/summary`);
}
