'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const KEY = 'qurio:last-ward';

/** Remembers the ward this phone was last used on (IPD plan §5.6). */
export function RememberWard({ wardId }: { wardId: string }) {
  useEffect(() => {
    try {
      localStorage.setItem(KEY, wardId);
    } catch {
      // Storage blocked: the picker simply asks again.
    }
  }, [wardId]);
  return null;
}

/**
 * On the ward picker: goes straight to the remembered ward, if it is still
 * one of the choices. "Change ward" links add ?pick=1 to stay on the picker.
 */
export function GoToLastWard({ wardIds }: { wardIds: readonly string[] }) {
  const router = useRouter();
  useEffect(() => {
    try {
      const last = localStorage.getItem(KEY);
      if (last && wardIds.includes(last)) router.replace(`/ipd/ward/${last}`);
    } catch {
      // Storage blocked: stay on the picker.
    }
  }, [router, wardIds]);
  return null;
}
