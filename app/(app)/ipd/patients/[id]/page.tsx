import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';

export default async function PatientPage({ params }: { params: Promise<any> }) {
  const session = await requireSession();
  const resolvedParams = await params;
  const id = resolvedParams?.id as string;
  if (session.role === 'nurse') {
    redirect(`/ipd/patients/${id}/emar`);
  }
  redirect(`/ipd/patients/${id}/summary`);
}
