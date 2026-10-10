'use client';

import { useEffect, useState } from 'react';
import { minutesLabel } from '@/lib/domain/test-orders';

/**
 * "Waiting 23 min", kept current between page refreshes. Rendered first with
 * the server's time so the first paint matches; then ticks every 20 seconds (the page itself refreshes every 30).
 */
export function SinceClock({ from, serverNow, prefix = '' }: { from: string; serverNow: string; prefix?: string }) {
  const [now, setNow] = useState(() => new Date(serverNow).getTime());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="tabular-nums">
      {prefix}
      {minutesLabel(new Date(from).getTime(), now)}
    </span>
  );
}
