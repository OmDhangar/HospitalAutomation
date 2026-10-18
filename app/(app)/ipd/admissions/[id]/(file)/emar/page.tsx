import { permanentRedirect } from 'next/navigation';

/**
 * Legacy eMAR Route Alias.
 *
 * Provides a permanent HTTP 308 redirect from `/ipd/admissions/[id]/emar`
 * to the consolidated `/ipd/admissions/[id]/treatment` workspace.
 */
export default async function LegacyEmarAliasPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(`/ipd/admissions/${id}/treatment`);
}
