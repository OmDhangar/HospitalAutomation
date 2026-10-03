'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangleIcon } from '@/components/icons';

/**
 * Real-time instant updater for the Waiting Room TV display.
 *
 * Instead of relying on a 10s static timer, this connects to the server's SSE stream
 * and triggers `router.refresh()` within ~50ms whenever the receptionist clicks
 * "Call Next Patient", advances the queue, pauses a doctor, or adds a walk-in.
 *
 * Includes a periodic fallback heartbeat (30s) and online/offline detection for 100% resilience.
 */
export function DisplayLiveUpdater({
  branchId,
  fallbackSeconds = 30,
}: {
  branchId: string;
  fallbackSeconds?: number;
}) {
  const router = useRouter();
  const [online, setOnline] = useState(true);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const triggerRefresh = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (document.visibilityState === 'visible') {
          router.refresh();
        }
      }, 50);
    };

    // 1. Instant Real-time SSE Connection
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(`/api/display/${branchId}/events`);
      eventSource.addEventListener('queue_update', () => {
        triggerRefresh();
      });
      eventSource.onerror = () => {
        // SSE reconnects automatically by browser default
      };
    } catch {
      // Fallback to polling if SSE fails
    }

    // 2. Safety Fallback Poller (e.g. 30s)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        router.refresh();
      }
    }, fallbackSeconds * 1000);

    // 3. Tab Visibility & Online Handlers
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
      }
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
      if (debounceRef.current) clearTimeout(debounceRef.current);
      clearInterval(timer);
      if (eventSource) {
        eventSource.close();
      }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [branchId, fallbackSeconds, router]);

  if (online) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-center text-sm font-bold text-amber-950 shadow-lg"
    >
      <AlertTriangleIcon className="h-4 w-4 shrink-0" />
      <span>No internet connection — display will auto-reconnect once network is restored</span>
    </div>
  );
}
