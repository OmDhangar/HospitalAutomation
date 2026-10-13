import { redirect } from 'next/navigation';

export const metadata = { title: 'Patient · IPD' };

interface AdmissionPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Legacy admission route: 307-redirects to the canonical patient chart URL
 * (/ipd/patients/:admissionId/summary).
 */
export default async function AdmissionPage({ params }: AdmissionPageProps) {
  const { id } = await params;
  redirect(`/ipd/patients/${id}/summary`);
}
