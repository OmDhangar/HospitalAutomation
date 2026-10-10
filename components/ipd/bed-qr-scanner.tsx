'use client';

import { useEffect, useRef, useState } from 'react';
import { bedCodeFromQr } from '@/lib/domain/mar';

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (options: { formats: string[] }) => Detector;

/**
 * Scans the QR on the bed label with the phone's camera (IPD sheets plan §5,
 * B3b), using the browser's own BarcodeDetector. Where the browser has none
 * (some iPhones, older Android), the button is not shown and the nurse types
 * the code printed under the QR — the same proof.
 */
export function BedQrScanner({ onCode }: { onCode: (code: string) => void }) {
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Held in a ref so a re-render of the form does not restart the camera.
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  useEffect(() => {
    // Feature detection after mount: the server cannot know.
    const has = typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);
    const timer = window.setTimeout(() => setSupported(has), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let stopped = false;
    const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
    const detector = new Ctor({ formats: ['qr_code'] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        stream = s;
        if (stopped || !videoRef.current) return;
        videoRef.current.srcObject = s;
        await videoRef.current.play();
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            for (const found of await detector.detect(videoRef.current)) {
              const code = bedCodeFromQr(found.rawValue);
              if (code) {
                onCodeRef.current(code);
                setOpen(false);
                return;
              }
            }
          } catch {
            // A frame that could not be read: try the next one.
          }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      })
      .catch(() => setError('The camera is not available. Type the code instead.'));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  if (!supported) return null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(!open);
        }}
        className="min-h-11 rounded-lg px-3 text-sm font-semibold text-brand-700 ring-1 ring-inset ring-brand-300 hover:bg-brand-50"
      >
        {open ? 'Stop scanning' : 'Scan the bed’s QR'}
      </button>
      {open ? <video ref={videoRef} muted playsInline className="aspect-square w-full max-w-xs rounded-lg bg-black object-cover" /> : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
