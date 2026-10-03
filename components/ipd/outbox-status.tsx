'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { WifiOffIcon } from '@/components/icons';
import { OUTBOX_EVENT, flushOutbox, pendingEntries, type EntryResult } from './outbox';
import { useOnline } from './use-online';

/**
 * On every nurse screen: sends whatever is waiting in the phone's outbox —
 * on load, when the connection returns, and every 30 seconds — and says
 * plainly what is still waiting, or what the server refused and why.
 */
export function OutboxStatus() {
  const router = useRouter();
  const [waiting, setWaiting] = useState(0);
  const online = useOnline();
  const [failed, setFailed] = useState<EntryResult[]>([]);

  const refreshCount = useCallback(async () => {
    try {
      setWaiting((await pendingEntries()).length);
    } catch {
      setWaiting(0);
    }
  }, []);

  const flush = useCallback(async () => {
    try {
      const { sent, failed: refused } = await flushOutbox();
      if (refused.length > 0) setFailed((list) => [...list, ...refused]);
      if (sent > 0) router.refresh();
    } catch {
      // IndexedDB unavailable (private mode): nothing was ever queued.
    }
    await refreshCount();
  }, [refreshCount, router]);

  useEffect(() => {
    const first = setTimeout(() => void flush(), 0);
    const goOnline = () => void flush();
    const changed = () => void refreshCount();
    window.addEventListener('online', goOnline);
    window.addEventListener(OUTBOX_EVENT, changed);
    const timer = setInterval(() => {
      if (navigator.onLine) void flush();
    }, 30_000);
    return () => {
      clearTimeout(first);
      window.removeEventListener('online', goOnline);
      window.removeEventListener(OUTBOX_EVENT, changed);
      clearInterval(timer);
    };
  }, [flush, refreshCount]);

  if (waiting === 0 && failed.length === 0 && online) return null;

  return (
    <div className="space-y-2">
      {!online || waiting > 0 ? (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-amber-100 px-4 py-3 text-sm font-medium text-amber-950">
          <WifiOffIcon className="size-5 shrink-0" />
          {!online ? 'No connection. ' : ''}
          {waiting > 0
            ? `${waiting} entr${waiting === 1 ? 'y is' : 'ies are'} saved on this phone and will be sent when the connection is back.`
            : 'Entries you save will wait on this phone.'}
        </p>
      ) : null}
      {failed.length > 0 ? (
        <div role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-900 ring-1 ring-rose-200">
          <p className="font-semibold">
            {failed.length} saved entr{failed.length === 1 ? 'y was' : 'ies were'} not accepted. Tell the desk:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {failed.map((entry) => (
              <li key={entry.clientId}>{entry.ok ? '' : entry.error}</li>
            ))}
          </ul>
          <button type="button" onClick={() => setFailed([])} className="mt-2 min-h-11 font-semibold underline">
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
