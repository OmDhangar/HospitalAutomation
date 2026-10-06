'use client';

import React, { useEffect, useRef, useState } from 'react';
import { BellIcon, BellOffIcon } from '@/components/icons';
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
        role="switch"
        aria-checked={audioEnabled}
        onClick={toggleAudio}
        className={`group flex items-center gap-2.5 rounded-2xl px-3.5 py-1.5 text-xs font-bold transition-all select-none cursor-pointer ring-1 outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
          audioEnabled
            ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40 hover:bg-emerald-500/25 shadow-sm shadow-emerald-950/40'
            : 'bg-white/5 text-slate-400 ring-white/10 hover:bg-white/10 hover:text-slate-200'
        }`}
        title={audioEnabled ? 'Click to turn off bell sound' : 'Click to turn on bell sound for called tokens'}
      >
        {audioEnabled ? (
          <BellIcon className="size-4 shrink-0 text-emerald-400 animate-bounce transition-transform" />
        ) : (
          <BellOffIcon className="size-4 shrink-0 text-slate-400 group-hover:text-slate-200 transition-colors" />
        )}
        
        <span className="font-semibold tracking-wide">
          Bell Sound: <span className={audioEnabled ? 'text-emerald-400 font-black' : 'text-slate-400 font-bold'}>{audioEnabled ? 'ON' : 'OFF'}</span>
        </span>

        {/* Visual Toggle Switch Slider */}
        <span
          aria-hidden="true"
          className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
            audioEnabled ? 'bg-emerald-500' : 'bg-slate-700'
          }`}
        >
          <span
            className={`inline-block size-3 rounded-full bg-white shadow-md transform transition-transform duration-200 ease-in-out ${
              audioEnabled ? 'translate-x-3' : 'translate-x-0'
            }`}
          />
        </span>
      </button>
    </div>
  );
}
