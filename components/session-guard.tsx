'use client';

import { useEffect, useRef } from 'react';

/**
 * Locks the screen of a phone or ward tablet that is left alone (ADR-022).
 *
 * The server already refuses a session that has been idle too long, but only
 * on its next request; a page left open would keep showing patient details.
 * This watches for taps and keys, and for the page going into the
 * background, and locks the screen after the hospital's limits:
 *
 * - a nurse's or doctor's own phone: after 15 idle minutes (the owner's
 *   setting) or 5 minutes in the background → the unlock screen (PIN);
 * - a ward tablet: after 10 idle minutes → "Who is recording?".
 *
 * Auto-refreshing pages do not count as use: only the person's own input does.
 * Entries waiting in the offline outbox are kept and sent after the unlock.
 */
export function SessionGuard({
  idleMs,
  backgroundMs,
  channel,
}: {
  idleMs: number | null;
  backgroundMs: number | null;
  channel: 'personal' | 'ward_device';
}) {
  // Set when the effect starts (not during render, which must stay pure).
  const lastInput = useRef(0);
  const hiddenAt = useRef<number | null>(null);
  const locking = useRef(false);

  useEffect(() => {
    if (idleMs === null && backgroundMs === null) return;
    lastInput.current = Date.now();

    const lock = async (reason: 'idle' | 'background') => {
      if (locking.current) return;
      locking.current = true;
      let next = channel === 'ward_device' ? '/ward-device' : '/unlock';
      try {
        const res = await fetch('/api/session/lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        });
        if (res.ok) next = ((await res.json()) as { next?: string }).next ?? next;
      } catch {
        // Offline: the server locks the session on its next request anyway.
      }
      window.location.replace(`${next}?next=${encodeURIComponent(window.location.pathname)}`);
    };

    const touch = () => {
      lastInput.current = Date.now();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      const away = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current;
      hiddenAt.current = null;
      if (backgroundMs !== null && away >= backgroundMs) void lock('background');
      else if (idleMs !== null && Date.now() - lastInput.current >= idleMs) void lock('idle');
    };
    const tick = window.setInterval(() => {
      if (idleMs !== null && Date.now() - lastInput.current >= idleMs) void lock('idle');
    }, 15_000);

    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    for (const event of events) window.addEventListener(event, touch, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(tick);
      for (const event of events) window.removeEventListener(event, touch);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [idleMs, backgroundMs, channel]);

  return null;
}
