import { redirect } from 'next/navigation';

export default async function PatientPage({ params }: { params: Promise<any> }) {
  const resolvedParams = await params;
  const id = resolvedParams?.id as string;
  redirect(`/ipd/patients/${id}/summary`);
}
