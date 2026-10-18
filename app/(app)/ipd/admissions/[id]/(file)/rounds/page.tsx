import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';

export const metadata = { title: 'Doctor Summary · IPD' };

export default async function RoundsPage({
  params,
}: PageProps<'/ipd/admissions/[id]/rounds'>) {
  const session = await requireSession();
  const { id } = await params;
  if (session.role === 'nurse') {
    redirect(`/ipd/admissions/${id}/treatment`);
  }
  redirect(`/ipd/patients/${id}/summary`);
}
