import { serviceDateIn } from './time';

/**
 * The life of an admission, as pure rules (IPD plan §5.1–5.5, task T1.4).
 *
 *   awaiting_bed ──assign bed──▶ admitted ──Discharge ready──▶ discharge_ready
 *        │                          ▲   │                            │
 *        │                          └───┼──── (not ready after all) ─┘
 *        └──cancel / undo──▶ cancelled  └──────────finalise──────────▶ discharged
 *
 * The database stamps each state (0032's CHECKs); the service owns the moves;
 * this module says which moves exist.
 */

export const ADMISSION_STATUSES = [
  'awaiting_bed',
  'admitted',
  'discharge_ready',
  'discharged',
  'cancelled',
] as const;
export type AdmissionStatus = (typeof ADMISSION_STATUSES)[number];

const TRANSITIONS: Record<AdmissionStatus, readonly AdmissionStatus[]> = {
  awaiting_bed: ['admitted', 'cancelled'],
  admitted: ['discharge_ready', 'discharged'],
  discharge_ready: ['admitted', 'discharged'],
  discharged: [],
  cancelled: [],
};

export const canMoveAdmission = (from: AdmissionStatus, to: AdmissionStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** A stay that is still going: the patient is, or is about to be, in a bed. */
export const isLiveAdmission = (status: AdmissionStatus): boolean =>
  status === 'awaiting_bed' || status === 'admitted' || status === 'discharge_ready';

/** Statuses in which the patient occupies a bed and bedside entries are accepted. */
export const IN_BED_STATUSES = ['admitted', 'discharge_ready'] as const;
export const isInBed = (status: AdmissionStatus): boolean =>
  (IN_BED_STATUSES as readonly string[]).includes(status);

/** How long the doctor's Undo of "Shift to IPD" stays available. */
export const UNDO_SHIFT_WINDOW_MS = 10 * 60_000;

export type UndoShiftRefusal = 'not_awaiting_bed' | 'too_late' | 'has_entries';

/**
 * Undo is for a mis-tap, not a way to unwind a stay: only while the patient
 * is still waiting for a bed, within ten minutes, and before anything has
 * been recorded against the admission.
 */
export function undoShiftRefusal(args: {
  status: AdmissionStatus;
  requestedAt: Date;
  careEntryCount: number;
  now: Date;
}): UndoShiftRefusal | null {
  if (args.status !== 'awaiting_bed') return 'not_awaiting_bed';
  if (args.now.getTime() - args.requestedAt.getTime() > UNDO_SHIFT_WINDOW_MS) return 'too_late';
  if (args.careEntryCount > 0) return 'has_entries';
  return null;
}

export const UNDO_SHIFT_MESSAGES: Record<UndoShiftRefusal, string> = {
  not_awaiting_bed: 'A bed has already been assigned. Ask the desk to cancel the admission.',
  too_late: 'Undo is only possible for 10 minutes. Ask the desk to cancel the admission.',
  has_entries: 'Something has already been recorded for this patient. Ask the desk to cancel.',
};

/**
 * "Day 3": the calendar day of the stay in the hospital's timezone, the
 * admission day being Day 1. Calendar days, not 24-hour blocks, because that
 * is how wards count and how the bed-day charge counts (D-BD default).
 */
export function dayOfStay(admittedAt: Date, now: Date, timezone: string): number {
  const from = Date.parse(serviceDateIn(timezone, admittedAt));
  const to = Date.parse(serviceDateIn(timezone, now));
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

/** "Rahul P." — enough to recognise on a bed tile, short enough to fit. */
export function shortPatientName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

/** "12 min ago", "2 h ago", "3 days ago": time since a request, for the desk. */
export function sinceLabel(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** A one-line reason for admission, optional. */
export function tidyReason(raw: string | null | undefined): string | null {
  const reason = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!reason) return null;
  return reason.slice(0, 200);
}
