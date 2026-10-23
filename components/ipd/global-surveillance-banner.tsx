'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, ClockIcon, XIcon } from '@/components/icons';
import { Button, cn } from '@/components/ui';
import {
  acknowledgeClinicalAlertAction,
  getActiveClinicalAlertsAction,
  sweepClinicalAlertsAction,
} from '@/app/(app)/ipd/actions';

export interface ClinicalAlertItem {
  id: string;
  type: string;
  status: string;
  title: string;
  message: string;
  createdAt: Date | string;
  metadata?: {
    admissionId?: string;
    patientName?: string;
    ipdNumber?: number | null;
    bedLabel?: string;
    wardName?: string;
    urgency?: string;
    isMlc?: boolean;
    [key: string]: unknown;
  } | null;
}

/**
 * Web Audio synthetic hospital chime. Plays a gentle two-tone chime (D5 -> A5)
 * when a new surveillance alert arrives, without needing external audio assets.
 */
function playClinicalChime() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880, now + 0.14); // A5

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.55);
  } catch {
    // Graceful fallback if autoplay policy or browser audio restrictions apply
  }
}

export function GlobalSurveillanceBanner() {
  const [alerts, setAlerts] = useState<ClinicalAlertItem[]>([]);
  const [isMinimized, setIsMinimized] = useState(false);
  const [acknowledgedIds, setAcknowledgedIds] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const seenIdsRef = useRef<Set<string>>(new Set());
  const hasMountedRef = useRef(false);

  // Poll for active alerts and run background sweep
  useEffect(() => {
    let isMounted = true;

    async function loadAlerts() {
      try {
        const res = await getActiveClinicalAlertsAction();
        if (res.ok && Array.isArray(res.data) && isMounted) {
          const freshAlerts = res.data as ClinicalAlertItem[];
          setAlerts(freshAlerts);

          // Check for newly arrived alerts to ring chime
          if (hasMountedRef.current) {
            const hasNew = freshAlerts.some((a) => !seenIdsRef.current.has(a.id));
            if (hasNew) {
              playClinicalChime();
            }
          }
          freshAlerts.forEach((a) => seenIdsRef.current.add(a.id));
          hasMountedRef.current = true;
        }
      } catch {
        // network or auth error, silent retry on next interval
      }
    }

    // Initial load
    void loadAlerts();

    // Poll every 25 seconds
    const interval = setInterval(() => {
      void loadAlerts();
      void sweepClinicalAlertsAction();
    }, 25000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const activeVisibleAlerts = alerts.filter(
    (a) => !acknowledgedIds.has(a.id) && (a.status === 'pending' || a.status === 'escalated'),
  );

  if (activeVisibleAlerts.length === 0) {
    return null;
  }

  const handleAcknowledge = (alertId: string) => {
    setAcknowledgedIds((prev) => new Set([...prev, alertId]));
    startTransition(async () => {
      await acknowledgeClinicalAlertAction(alertId);
    });
  };

  const alertCount = activeVisibleAlerts.length;
  const primaryAlert = activeVisibleAlerts[0];
  const metadata = primaryAlert.metadata || {};
  const isEmergency = metadata.urgency === 'emergency' || primaryAlert.type === 'new_emergency_admission';
  const isEscalated = primaryAlert.status === 'escalated';

  if (isMinimized) {
    return (
      <aside aria-label="Clinical surveillance alerts" className="fixed bottom-4 right-4 z-50 animate-bounce">
        <button
          type="button"
          onClick={() => setIsMinimized(false)}
          className={cn(
            'flex items-center gap-2 rounded-full px-4 py-2.5 text-xs font-bold shadow-xl transition-transform hover:scale-105 cursor-pointer',
            isEmergency
              ? 'bg-rose-600 text-white ring-2 ring-rose-400'
              : 'bg-amber-600 text-white ring-2 ring-amber-400',
          )}
        >
          <span className="size-2 rounded-full bg-white animate-ping" />
          <span>Surveillance Alert ({alertCount})</span>
        </button>
      </aside>
    );
  }

  return (
    <aside aria-label="Clinical surveillance alerts" className="mx-auto w-full max-w-[1600px] px-3.5 pt-2 sm:px-6">
      <div
        className={cn(
          'relative overflow-hidden rounded-xl border p-4 shadow-md transition-all',
          isEmergency
            ? 'border-rose-400 bg-linear-to-r from-rose-50 via-white to-rose-50 text-rose-950'
            : isEscalated
            ? 'border-purple-400 bg-linear-to-r from-purple-50 via-white to-purple-50 text-purple-950'
            : 'border-amber-400 bg-linear-to-r from-amber-50 via-white to-amber-50 text-amber-950',
        )}
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          {/* Left: Badge & Description */}
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg shadow-xs',
                isEmergency ? 'bg-rose-600 text-white' : 'bg-amber-600 text-white',
              )}
            >
              <AlertCircleIcon className="size-5" />
            </span>

            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider',
                    isEmergency
                      ? 'bg-rose-200 text-rose-900'
                      : isEscalated
                      ? 'bg-purple-200 text-purple-900'
                      : 'bg-amber-200 text-amber-900',
                  )}
                >
                  <span
                    className={cn(
                      'size-2 rounded-full animate-ping',
                      isEmergency ? 'bg-rose-600' : 'bg-amber-600',
                    )}
                  />
                  {isEscalated
                    ? 'ESCALATED SURVEILLANCE ALERT'
                    : isEmergency
                    ? 'EMERGENCY ADMISSION SURVEILLANCE'
                    : 'PATIENT REACHED WARD'}
                </span>

                {alertCount > 1 ? (
                  <span className="rounded-full bg-ink-200 px-2 py-0.5 font-mono text-[10px] font-bold text-ink-800">
                    +{alertCount - 1} more alert{alertCount > 2 ? 's' : ''}
                  </span>
                ) : null}

                {metadata.isMlc ? (
                  <span className="rounded bg-purple-700 px-2 py-0.5 text-[10px] font-extrabold uppercase text-white shadow-2xs">
                    MLC
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2 flex-wrap text-sm font-bold text-ink-900">
                <span>{primaryAlert.title}</span>
                {metadata.bedLabel && metadata.wardName ? (
                  <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-xs font-semibold text-ink-800 border border-ink-200">
                    Bed {metadata.bedLabel} · {metadata.wardName}
                  </span>
                ) : null}
              </div>

              <p className="text-xs text-ink-600 max-w-2xl">{primaryAlert.message}</p>
            </div>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2 self-end md:self-center shrink-0">
            {metadata.admissionId ? (
              <Link
                href={`/ipd/patients/${metadata.admissionId}/summary`}
                className="inline-flex items-center gap-1 rounded-lg bg-white px-3.5 py-2 text-xs font-bold text-ink-800 border border-ink-300 shadow-2xs hover:bg-ink-50 transition-colors"
              >
                Open IPD Chart →
              </Link>
            ) : null}

            <Button
              variant="primary"
              size="sm"
              disabled={isPending}
              onClick={() => handleAcknowledge(primaryAlert.id)}
              className={cn(
                'text-xs font-bold cursor-pointer',
                isEmergency ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-700 hover:bg-amber-800',
              )}
            >
              <CheckIcon className="mr-1 size-3.5" />
              Acknowledge
            </Button>

            <button
              type="button"
              onClick={() => setIsMinimized(true)}
              title="Minimize alert banner"
              className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-200 hover:text-ink-900 transition-colors cursor-pointer"
            >
              <ChevronDownIcon className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
