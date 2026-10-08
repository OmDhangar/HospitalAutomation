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
  /**
   * Observed minutes per patient today, measured call to call (see
   * `paceSample`). Null before the first sample.
   */
  paceMinutes?: number | null;
  /** How many intervals `paceMinutes` was built from. */
  paceSamples?: number;
  /** The doctor's configured consultation minutes: the prior the pace is blended with. */
  configuredMinutes?: number;
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

const DEFAULT_CONSULT_MINUTES = 10;
const MIN_LATE_WIDTH_MINUTES = 10;
const ROUND_TO_MINUTES = 5;
/** A patient-facing window moving by less than this is not worth a message. */
export const ETA_NOTIFY_THRESHOLD_MINUTES = 15;

/**
 * How many samples the configured minutes are worth. Until the day has seen
 * about this many patients, the doctor's own number dominates, so one quick
 * consultation can no longer make every estimate in the room 70% shorter.
 */
const PRIOR_WEIGHT = 5;

/**
 * The late side of the window: wider when we have less evidence, rather than
 * pretending precision. Queues run late far more often than early.
 */
const LATE_FRACTION: Record<EtaConfidence, number> = {
  low: 0.5,
  medium: 0.35,
  high: 0.25,
};

/**
 * The early side is deliberately narrow. Patients read the start of the
 * window as "my time" and arrive then; a symmetric window (it reached at least
 * ten minutes early) told them to come 5-10 minutes before they could
 * possibly be seen.
 */
const EARLY_FRACTION: Record<EtaConfidence, number> = {
  low: 0.15,
  medium: 0.1,
  high: 0.05,
};

/* ------------------------------------------------------------------ pace */

/** An interval longer than this is a break, idle time or the gap between sessions. */
export const PACE_MAX_GAP_MINUTES = 60;
/** Each sample is clipped to this band around the configured minutes. */
const PACE_CLIP = { min: 0.3, max: 3 };
/** A true mean for the first N samples, then an exponential average over about N. */
const PACE_WINDOW = 20;

/**
 * Minutes per patient, blended with the configured value by how much evidence
 * the day has. The single answer to "how long does each patient take",
 * shared by every estimate.
 */
export function effectivePace(input: Pick<EtaInput, 'paceMinutes' | 'paceSamples' | 'configuredMinutes'>): number {
  const configured =
    input.configuredMinutes && input.configuredMinutes > 0 ? input.configuredMinutes : DEFAULT_CONSULT_MINUTES;
  const n = input.paceSamples ?? 0;
  if (input.paceMinutes == null || n <= 0) return configured;
  return (PRIOR_WEIGHT * configured + n * input.paceMinutes) / (PRIOR_WEIGHT + n);
}

/**
 * The interval a call contributes to the pace, or null when it is not a fair
 * sample.
 *
 * Measured call to call, not consultation start to complete: what a patient
 * really costs includes walking in, the notes after they leave, and the pause
 * before Next. In-room time left all of that out, which is why estimates ran
 * short of reality.
 *
 * Not a sample: the first call of the day or after a break (no previous
 * call), a gap over an hour, a previous patient who was held or skipped rather
 * than seen, or a doctor who sat idle until this patient joined the line.
 */
export function paceSample(args: {
  lastCalledAt: Date | null;
  now: Date;
  previousWasSeen: boolean;
  calledEnqueuedAt: Date | null;
  configuredMinutes: number;
}): number | null {
  if (!args.lastCalledAt || !args.previousWasSeen) return null;
  if (args.calledEnqueuedAt && args.calledEnqueuedAt.getTime() > args.lastCalledAt.getTime()) return null;
  const minutes = minutesBetween(args.lastCalledAt, args.now);
  if (!(minutes > 0) || minutes > PACE_MAX_GAP_MINUTES) return null;
  const configured = args.configuredMinutes > 0 ? args.configuredMinutes : DEFAULT_CONSULT_MINUTES;
  return Math.min(configured * PACE_CLIP.max, Math.max(configured * PACE_CLIP.min, minutes));
}

/** Folds one sample into the running pace. Pure; the caller stores the result. */
export function foldPaceSample(
  prev: { paceMinutes: number | null; paceSamples: number },
  sample: number,
): { paceMinutes: number; paceSamples: number } {
  if (prev.paceMinutes == null || prev.paceSamples <= 0) return { paceMinutes: sample, paceSamples: 1 };
  const weight = Math.min(prev.paceSamples + 1, PACE_WINDOW);
  return {
    paceMinutes: prev.paceMinutes + (sample - prev.paceMinutes) / weight,
    paceSamples: prev.paceSamples + 1,
  };
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
  const consult = effectivePace(input);
  const sampleSize = input.paceSamples ?? 0;

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

  const confidence = confidenceFor(sampleSize);
  // The uncertainty is in the consultations, not in the wait before OPD opens.
  const earlyWidth = queueMinutes * EARLY_FRACTION[confidence];
  const lateWidth = Math.max(MIN_LATE_WIDTH_MINUTES, queueMinutes * LATE_FRACTION[confidence]);

  const state = planned ? 'planned' : 'live';
  return {
    waitMinutes: Math.round(waitMinutes),
    windowStart: roundUpToInterval(
      new Date(Math.max(input.now.getTime(), centreMs - earlyWidth * 60_000)),
    ),
    windowEnd: roundUpToInterval(new Date(centreMs + lateWidth * 60_000)),
    confidence,
    basisConsultMinutes: consult,
    sampleSize,
    state,
    basis: {
      state,
      anchor: planned ? 'scheduled_start' : 'now',
      anchorAt,
      patientsAhead: input.patientsAhead,
      consultMinutes: consult,
      sampleSize,
      delayMinutes: startDelayMinutes(input),
    },
  };
}

/** The estimate a patient may be shown: none once the doctor is overdue to start. */
export function resolveEta(input: EtaInput): EtaResult {
  if (etaState(input) !== 'not_started') return estimateEta(input);
  const consult = effectivePace(input);
  return {
    state: 'not_started',
    basis: {
      state: 'not_started',
      anchor: 'scheduled_start',
      anchorAt: input.scheduledStartAt!,
      patientsAhead: input.patientsAhead,
      consultMinutes: consult,
      sampleSize: input.paceSamples ?? 0,
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
