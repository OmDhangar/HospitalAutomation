import { redirect } from 'next/navigation';

interface PatientPageProps {
  params: Promise<{ id: string }>;
}

export default async function PatientPage({ params }: PatientPageProps) {
  const { id } = await params;
  redirect(`/ipd/patients/${id}/summary`);
}
