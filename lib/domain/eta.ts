export type EtaConfidence = 'low' | 'medium' | 'high';

/**
 * Where the doctor's day stands, as far as an estimate is concerned.
 *
 * - `planned`: OPD has not started and the scheduled start (plus a grace
 *   period) has not passed. Estimates count from the scheduled start, so they
 *   hold still while the clock moves.
 * - `not_started`: the grace period is over and OPD still has not started.
 *   No time is promised — a time that slides every minute is worse than none.
 * - `live`: OPD has started (or no start time is configured). Estimates count
 *   from now, which is how this worked before start times existed.
 */
export type EtaState = 'planned' | 'not_started' | 'live';

/**
 * How long after the scheduled start a planned estimate is still shown.
 * Doctors are routinely a few minutes late; past this the honest message is
 * "not started yet", not a quietly receding time.
 */
export const START_GRACE_MINUTES = 15;

export type EtaInput = {
  patientsAhead: number;
  /** Completed consultation durations in minutes, oldest first. */
  consultDurations: number[];
  /** Used until enough real durations have been observed. */
  fallbackConsultMinutes?: number;
  /** The doctor's scheduled start for the day, if one is configured. */
  scheduledStartAt?: Date | null;
  /** Set only by Start OPD. */
  sessionStartedAt?: Date | null;
  now: Date;
};

/**
 * Every input that produced an estimate, so a changed ETA can be explained:
 * which anchor it counted from, how many were ahead, at what pace, and how
 * late the day is running. The delay is reported, never added — the anchor
 * already reflects it.
 */
export type EtaBasis = {
  state: EtaState;
  anchor: 'scheduled_start' | 'now';
  anchorAt: Date;
  patientsAhead: number;
  consultMinutes: number;
  sampleSize: number;
  delayMinutes: number;
};

export type EtaEstimate = {
  waitMinutes: number;
  windowStart: Date;
  windowEnd: Date;
  confidence: EtaConfidence;
  basisConsultMinutes: number;
  sampleSize: number;
  state: Exclude<EtaState, 'not_started'>;
  basis: EtaBasis;
};

export type EtaResult = EtaEstimate | { state: 'not_started'; basis: EtaBasis };

const MAX_SAMPLES = 50;
const DEFAULT_CONSULT_MINUTES = 10;
const MIN_HALF_WIDTH_MINUTES = 10;
const ROUND_TO_MINUTES = 5;
/** A patient-facing window moving by less than this is not worth a message. */
export const ETA_NOTIFY_THRESHOLD_MINUTES = 15;

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

const minutesBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 60_000;

/** Which of the three states the doctor's day is in. */
export function etaState(input: Pick<EtaInput, 'scheduledStartAt' | 'sessionStartedAt' | 'now'>): EtaState {
  if (input.sessionStartedAt || !input.scheduledStartAt) return 'live';
  return minutesBetween(input.scheduledStartAt, input.now) >= START_GRACE_MINUTES
    ? 'not_started'
    : 'planned';
}

/**
 * How late the day is running, for explanation only. After Start OPD this is
 * fixed (actual minus scheduled start), so a doctor who started late does not
 * keep "getting later" for the rest of the day.
 */
export function startDelayMinutes(input: Pick<EtaInput, 'scheduledStartAt' | 'sessionStartedAt' | 'now'>): number {
  if (!input.scheduledStartAt) return 0;
  const reference = input.sessionStartedAt ?? input.now;
  return Math.max(0, Math.round(minutesBetween(input.scheduledStartAt, reference)));
}

/**
 * A deliberately imprecise estimate. The honest number is `patientsAhead`;
 * this window exists so a patient can decide whether to leave, not so we can
 * promise a consultation at 5:20pm.
 *
 * Counts from the scheduled start while OPD is `planned`, and from now once it
 * is `live`. Delay is never added on top: before the start the anchor is the
 * schedule, after it the clock already contains whatever lateness happened.
 * Call `resolveEta` when the `not_started` state must be honoured; this
 * function always returns a window.
 */
export function estimateEta(input: EtaInput): EtaEstimate {
  const samples = input.consultDurations.slice(-MAX_SAMPLES);
  const consult =
    median(samples) ??
    input.fallbackConsultMinutes ??
    DEFAULT_CONSULT_MINUTES;

  const planned =
    !input.sessionStartedAt &&
    input.scheduledStartAt != null &&
    input.scheduledStartAt.getTime() > input.now.getTime() - START_GRACE_MINUTES * 60_000;
  const anchorAt = planned ? input.scheduledStartAt! : input.now;

  const queueMinutes = Math.max(0, input.patientsAhead * consult);
  // Clamped to now: during the grace period the front of the line is due now,
  // not five minutes ago.
  const centreMs = Math.max(input.now.getTime(), anchorAt.getTime() + queueMinutes * 60_000);
  const waitMinutes = (centreMs - input.now.getTime()) / 60_000;

  const confidence = confidenceFor(samples.length);
  // The uncertainty is in the consultations, not in the wait before OPD opens.
  const halfWidth = Math.max(
    MIN_HALF_WIDTH_MINUTES,
    queueMinutes * HALF_WIDTH_FRACTION[confidence],
  );

  const state = planned ? 'planned' : 'live';
  return {
    waitMinutes: Math.round(waitMinutes),
    windowStart: roundUpToInterval(
      new Date(Math.max(input.now.getTime(), centreMs - halfWidth * 60_000)),
    ),
    windowEnd: roundUpToInterval(new Date(centreMs + halfWidth * 60_000)),
    confidence,
    basisConsultMinutes: consult,
    sampleSize: samples.length,
    state,
    basis: {
      state,
      anchor: planned ? 'scheduled_start' : 'now',
      anchorAt,
      patientsAhead: input.patientsAhead,
      consultMinutes: consult,
      sampleSize: samples.length,
      delayMinutes: startDelayMinutes(input),
    },
  };
}

/** The estimate a patient may be shown: none once the doctor is overdue to start. */
export function resolveEta(input: EtaInput): EtaResult {
  if (etaState(input) !== 'not_started') return estimateEta(input);
  const consult = median(input.consultDurations.slice(-MAX_SAMPLES)) ??
    input.fallbackConsultMinutes ?? DEFAULT_CONSULT_MINUTES;
  return {
    state: 'not_started',
    basis: {
      state: 'not_started',
      anchor: 'scheduled_start',
      anchorAt: input.scheduledStartAt!,
      patientsAhead: input.patientsAhead,
      consultMinutes: consult,
      sampleSize: Math.min(input.consultDurations.length, MAX_SAMPLES),
      delayMinutes: startDelayMinutes(input),
    },
  };
}

/**
 * Whether a patient-facing estimate changed enough to be worth telling them.
 * Small drifts are absorbed; a change of state always counts.
 */
export function isMeaningfulEtaShift(
  previous: EtaResult | null,
  next: EtaResult | null,
  thresholdMinutes = ETA_NOTIFY_THRESHOLD_MINUTES,
): boolean {
  if (!previous || !next) return previous !== next;
  if (previous.state === 'not_started' || next.state === 'not_started') {
    return previous.state !== next.state;
  }
  return (
    Math.abs(minutesBetween(previous.windowStart, next.windowStart)) >= thresholdMinutes
  );
}
