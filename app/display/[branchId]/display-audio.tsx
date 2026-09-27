'use client';

import React, { useEffect, useRef, useState } from 'react';
import { playChime } from '@/lib/utils/sound';

export type ServingTokenState = {
  doctorId: string;
  doctorName: string;
  tokenNumber: number | null;
  patientName: string | null;
  status: string | null;
};

const STORAGE_KEY = 'opd_tv_audio_enabled';

export function DisplayAudioNotifier({
  servingState,
}: {
  servingState: ServingTokenState[];
}) {
  const [audioEnabled, setAudioEnabled] = useState<boolean>(false);
  const prevStateRef = useRef<string | null>(null);
  const isFirstRender = useRef(true);

  // Initialize audio preference from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'true') {
        setAudioEnabled(true);
      }
    } catch {
      // localStorage may be unavailable in private mode
    }
  }, []);

  const toggleAudio = () => {
    const nextState = !audioEnabled;
    setAudioEnabled(nextState);
    try {
      localStorage.setItem(STORAGE_KEY, String(nextState));
    } catch {
      // ignore
    }
    if (nextState) {
      // Play immediate test chime on activation to unlock browser AudioContext
      playChime();
    }
  };

  // Generate a signature of currently serving tokens: "doc1:14:CALLED|doc2:5:IN_CONSULTATION"
  const currentSignature = servingState
    .map((s) => `${s.doctorId}:${s.tokenNumber ?? 'none'}:${s.status ?? 'idle'}`)
    .sort()
    .join('|');

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevStateRef.current = currentSignature;
      return;
    }

    if (prevStateRef.current !== currentSignature) {
      const prev = prevStateRef.current;
      prevStateRef.current = currentSignature;

      // Check if a new token was called or updated
      if (audioEnabled && prev !== null) {
        // Small delay to synchronize with visual DOM transition
        const timer = setTimeout(() => {
          playChime();
        }, 150);
        return () => clearTimeout(timer);
      }
    }
  }, [currentSignature, audioEnabled]);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggleAudio}
        className={`flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-bold transition-all select-none cursor-pointer ring-1 ${
          audioEnabled
            ? 'bg-emerald-500/20 text-emerald-300 ring-emerald-500/40 hover:bg-emerald-500/30'
            : 'bg-white/5 text-slate-400 ring-white/10 hover:bg-white/10 hover:text-white'
        }`}
        title={audioEnabled ? 'Click to mute TV chime' : 'Click to enable TV bell chime for new tokens'}
      >
        <span className="text-base leading-none">
          {audioEnabled ? '🔔' : '🔕'}
        </span>
        <span className="hidden sm:inline">
          {audioEnabled ? 'Chime Alert ON' : 'Turn Sound ON'}
        </span>
      </button>
    </div>
  );
}
