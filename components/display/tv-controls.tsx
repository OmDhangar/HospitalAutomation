'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface TVControlsProps {
  currentTokens: Array<{ doctorId: string; doctorName: string; token: number | null }>;
}

export function TVControls({ currentTokens }: TVControlsProps) {
  const router = useRouter();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [isLargeScale, setIsLargeScale] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>('');

  const prevTokensRef = useRef<Map<string, number | null>>(new Map());
  const isFirstRender = useRef(true);

  // Initialize state from browser
  useEffect(() => {
    setLastRefreshed(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    
    // Check saved sound preference
    const savedSound = localStorage.getItem('qurio_tv_sound') === 'true';
    setSoundEnabled(savedSound);

    // Check saved scale preference
    const savedScale = localStorage.getItem('qurio_tv_scale') === 'large';
    setIsLargeScale(savedScale);

    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Web Audio chime function
  const playChime = () => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      // First chime tone (G4 - 392Hz)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(392, now);
      gain1.gain.setValueAtTime(0, now);
      gain1.gain.linearRampToValueAtTime(0.3, now + 0.05);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.9);

      // Second chime tone (C5 - 523.25Hz) - standard pleasant hospital chime
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(523.25, now + 0.25);
      gain2.gain.setValueAtTime(0, now + 0.25);
      gain2.gain.linearRampToValueAtTime(0.35, now + 0.3);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.25);
      osc2.stop(now + 1.2);
    } catch {
      // AudioContext not permitted before user interaction
    }
  };

  // Detect token changes to trigger chime
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      const initialMap = new Map<string, number | null>();
      for (const item of currentTokens) {
        initialMap.set(item.doctorId, item.token);
      }
      prevTokensRef.current = initialMap;
      return;
    }

    let tokenChanged = false;
    for (const item of currentTokens) {
      const prev = prevTokensRef.current.get(item.doctorId);
      if (item.token !== null && item.token !== prev && prev !== undefined) {
        tokenChanged = true;
        break;
      }
    }

    // Update reference
    const newMap = new Map<string, number | null>();
    for (const item of currentTokens) {
      newMap.set(item.doctorId, item.token);
    }
    prevTokensRef.current = newMap;

    if (tokenChanged && soundEnabled) {
      playChime();
    }
    setLastRefreshed(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }, [currentTokens, soundEnabled]);

  // Toggle Fullscreen
  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Fullscreen not supported or rejected
    }
  };

  // Toggle Sound
  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem('qurio_tv_sound', String(next));
    if (next) {
      playChime();
    }
  };

  // Toggle Scale
  const toggleScale = () => {
    const next = !isLargeScale;
    setIsLargeScale(next);
    localStorage.setItem('qurio_tv_scale', next ? 'large' : 'standard');
    if (next) {
      document.documentElement.classList.add('tv-scale-large');
    } else {
      document.documentElement.classList.remove('tv-scale-large');
    }
  };

  // Manual Refresh
  const handleRefresh = () => {
    setIsRefreshing(true);
    router.refresh();
    setTimeout(() => {
      setIsRefreshing(false);
      setLastRefreshed(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }, 600);
  };

  // Keyboard navigation / TV remote shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when inside inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 's' || e.key === 'S' || e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        toggleSound();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleRefresh();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [soundEnabled, isLargeScale]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Sound Chime Toggle */}
      <button
        type="button"
        onClick={toggleSound}
        className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all cursor-pointer select-none active:scale-[0.98] ${
          soundEnabled
            ? 'bg-brand-500/20 text-brand-300 ring-1 ring-brand-400/40 hover:bg-brand-500/30'
            : 'bg-white/10 text-white/70 ring-1 ring-white/10 hover:bg-white/15 hover:text-white'
        }`}
        title="Toggle Audio Chime on token advance (Shortcuts: S or M)"
        aria-label={soundEnabled ? 'Chime sound active' : 'Chime sound muted'}
      >
        <span className="text-base" aria-hidden="true">
          {soundEnabled ? '🔔' : '🔕'}
        </span>
        <span className="hidden sm:inline">{soundEnabled ? 'Chime ON' : 'Chime OFF'}</span>
      </button>

      {/* TV Scaling Toggle */}
      <button
        type="button"
        onClick={toggleScale}
        className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all cursor-pointer select-none active:scale-[0.98] ${
          isLargeScale
            ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-400/40 hover:bg-amber-500/30'
            : 'bg-white/10 text-white/70 ring-1 ring-white/10 hover:bg-white/15 hover:text-white'
        }`}
        title="Toggle TV Display Magnification"
        aria-label="Toggle TV scaling"
      >
        <span className="text-base" aria-hidden="true">
          🔍
        </span>
        <span className="hidden md:inline">{isLargeScale ? 'Zoom 125%' : 'Zoom 100%'}</span>
      </button>

      {/* Manual Refresh Button */}
      <button
        type="button"
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-white/80 ring-1 ring-white/10 transition-all hover:bg-white/15 hover:text-white cursor-pointer select-none active:scale-[0.98] disabled:opacity-50"
        title="Refresh queue display (Shortcut: R)"
        aria-label="Refresh display"
      >
        <span className={`text-base leading-none ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true">
          ↻
        </span>
        <span className="hidden sm:inline">Refresh</span>
      </button>

      {/* Fullscreen Button */}
      <button
        type="button"
        onClick={toggleFullscreen}
        className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-md transition-all hover:bg-brand-500 cursor-pointer select-none active:scale-[0.98] ring-1 ring-brand-400/50"
        title="Toggle Fullscreen Mode (Shortcut: F or F11)"
        aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
      >
        <span className="text-base" aria-hidden="true">
          {isFullscreen ? '🗗' : '⛶'}
        </span>
        <span className="hidden sm:inline">{isFullscreen ? 'Exit Full' : 'Fullscreen'}</span>
      </button>

      {/* Live Sync Status */}
      <div className="hidden xl:flex items-center gap-2 rounded-xl bg-white/5 px-3.5 py-2 ring-1 ring-white/10 text-xs text-white/60">
        <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
        <span>Live</span>
        {lastRefreshed ? <span className="text-white/40">({lastRefreshed})</span> : null}
      </div>
    </div>
  );
}
