'use client';

import React, { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markBedCleanedAction } from '@/app/(app)/ipd/actions';

export function BedCleaningAction({ bedId }: { bedId: string }) {
  let router: { refresh: () => void } | null = null;
  try {
    router = useRouter();
  } catch {
    router = null;
  }

  const [isPending, startTransition] = useTransition();

  const handleClean = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      await markBedCleanedAction({ bedId });
      router?.refresh();
    });
  };

  return (
    <button
      type="button"
      onClick={handleClean}
      disabled={isPending}
      className="mt-1 rounded bg-purple-200 px-1.5 py-0.5 text-[10px] font-bold text-purple-900 hover:bg-purple-300 transition-colors disabled:opacity-50"
      title="Click to mark sanitized and vacant"
    >
      {isPending ? 'Cleaning...' : 'Mark Clean'}
    </button>
  );
}
