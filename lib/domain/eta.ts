export type EtaConfidence = 'low' | 'medium' | 'high';

export type EtaInput = {
  patientsAhead: number;
  /** Completed consultation durations in minutes, oldest first. */
  consultDurations: number[];
  /** How far behind the doctor is running right now, in minutes. */
  currentDelayMinutes: number;
  /** Used until enough real durations have been observed. */
  fallbackConsultMinutes?: number;
  now: Date;
};

export type EtaEstimate = {
  waitMinutes: number;
  windowStart: Date;
  windowEnd: Date;
  confidence: EtaConfidence;
  basisConsultMinutes: number;
  sampleSize: number;
};

const MAX_SAMPLES = 50;
const DEFAULT_CONSULT_MINUTES = 10;
const MIN_HALF_WIDTH_MINUTES = 10;
const ROUND_TO_MINUTES = 5;

/** Widen the window when we have less evidence, rather than pretending precision. */
const HALF_WIDTH_FRACTION: Record<EtaConfidence, number> = {
  low: 0.5,
  medium: 0.35,
  high: 0.25,
};

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function confidenceFor(sampleSize: number): EtaConfidence {
  if (sampleSize < 5) return 'low';
  if (sampleSize < 20) return 'medium';
  return 'high';
}

/**
 * Both ends round up, never down.
 *
 * Rounding the start down can move it before `now` — a window that already
 * began, which reads as a missed promise to someone staring at the page. The
 * cost is a slightly wider window, which is the honest direction to err.
 */
const roundUpToInterval = (date: Date): Date => {
  const ms = ROUND_TO_MINUTES * 60_000;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
};

/**
 * A deliberately imprecise estimate. The honest number is `patientsAhead`;
 * this window exists so a patient can decide whether to leave, not so we can
 * promise a consultation at 5:20pm.
 */
export function estimateEta(input: EtaInput): EtaEstimate {
  const samples = input.consultDurations.slice(-MAX_SAMPLES);
  const basis =
    median(samples) ??
    input.fallbackConsultMinutes ??
    DEFAULT_CONSULT_MINUTES;

  const waitMinutes = Math.max(
    0,
    input.patientsAhead * basis + input.currentDelayMinutes,
  );

  const confidence = confidenceFor(samples.length);
  const halfWidth = Math.max(
    MIN_HALF_WIDTH_MINUTES,
    waitMinutes * HALF_WIDTH_FRACTION[confidence],
  );

  const centre = input.now.getTime() + waitMinutes * 60_000;

  return {
    waitMinutes: Math.round(waitMinutes),
    windowStart: roundUpToInterval(
      new Date(Math.max(input.now.getTime(), centre - halfWidth * 60_000)),
    ),
    windowEnd: roundUpToInterval(new Date(centre + halfWidth * 60_000)),
    confidence,
    basisConsultMinutes: basis,
    sampleSize: samples.length,
  };
}
