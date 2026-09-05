'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps a server-rendered page current without websockets.
 *
 * Polling pauses while the tab is hidden and refreshes immediately on return,
 * which is the whole polling policy: useful when someone is looking, quiet when
 * nobody is.
 */
export function AutoRefresh({ seconds = 10 }: { seconds?: number }) {
  const router = useRouter();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };

    const timer = setInterval(tick, seconds * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const goOnline = () => {
      setOnline(true);
      router.refresh();
    };
    const goOffline = () => setOnline(false);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    setOnline(navigator.onLine);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [router, seconds]);

  if (online) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950"
    >
      No internet connection — this screen may be out of date
    </div>
  );
}
