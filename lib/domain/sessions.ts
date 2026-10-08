import { zonedTimeToUtc } from './time';

/**
 * A doctor's day as a list of sessions.
 *
 * Each session is one `doctor_schedules` row: its own mode, hours and slot
 * length. One row is the classic day and behaves exactly as before. Several
 * rows make a split day; the hybrid one doctors asked for is
 *
 *   12:00–19:00  queue   live tokens, served in token order
 *   (break)               simply the gap between the rows
 *   20:00–22:00  slot    pre-booked times only, numbered S1, S2… by time
 *
 * Pure: the service loads the rows, this module answers questions about them.
 */

export type SessionMode = 'queue' | 'slot' | 'both';

/** A session as configured, in wall-clock times. */
export type SessionConfig = {
  mode: SessionMode;
  startTime: string; // "12:00"
  endTime: string; // "19:00"
  slotMinutes: number;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
};

/** A session placed on one service date. */
export type DaySession = SessionConfig & { startAt: Date; endAt: Date };

export const MAX_SESSIONS = 3;
const MIN_SLOT_MINUTES = 5;
const MAX_SLOT_MINUTES = 120;

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

export const takesQueue = (session: Pick<SessionConfig, 'mode'>) => session.mode !== 'slot';
export const takesSlots = (session: Pick<SessionConfig, 'mode'>) => session.mode !== 'queue';

/** Problems with a session list, worded for the settings screen. Empty when valid. */
export function validateSessions(sessions: SessionConfig[]): string[] {
  const errors: string[] = [];
  if (sessions.length === 0) errors.push('Add at least one session.');
  if (sessions.length > MAX_SESSIONS) errors.push(`A day can have at most ${MAX_SESSIONS} sessions.`);

  sessions.forEach((s, i) => {
    const label = `Session ${i + 1}`;
    if (!TIME.test(s.startTime) || !TIME.test(s.endTime)) {
      errors.push(`${label}: times must be HH:MM.`);
      return;
    }
    if (toMinutes(s.startTime) >= toMinutes(s.endTime)) errors.push(`${label}: must end after it starts.`);
    if (!Number.isInteger(s.slotMinutes) || s.slotMinutes < MIN_SLOT_MINUTES || s.slotMinutes > MAX_SLOT_MINUTES) {
      errors.push(`${label}: slot length must be ${MIN_SLOT_MINUTES}–${MAX_SLOT_MINUTES} minutes.`);
    }
    if (s.breakStartTime && s.breakEndTime) {
      if (!TIME.test(s.breakStartTime) || !TIME.test(s.breakEndTime)) {
        errors.push(`${label}: break times must be HH:MM.`);
      } else if (toMinutes(s.breakStartTime) >= toMinutes(s.breakEndTime)) {
        errors.push(`${label}: break must end after it starts.`);
      }
    }
  });

  const sorted = [...sessions]
    .filter((s) => TIME.test(s.startTime) && TIME.test(s.endTime))
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  for (let i = 1; i < sorted.length; i += 1) {
    if (toMinutes(sorted[i].startTime) < toMinutes(sorted[i - 1].endTime)) {
      errors.push('Sessions must not overlap.');
      break;
    }
  }
  if (sessions.filter((s) => s.mode !== 'slot').length > 1) {
    errors.push('Only one session can run the live queue.');
  }
  return errors;
}

/** Places configured sessions on a service date, earliest first. */
export function toDaySessions(configs: SessionConfig[], serviceDate: string, timezone: string): DaySession[] {
  return configs
    .map((c) => ({
      ...c,
      startAt: zonedTimeToUtc(serviceDate, c.startTime, timezone),
      endAt: zonedTimeToUtc(serviceDate, c.endTime, timezone),
    }))
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/** The session that runs the live queue, if any. */
export const queueSession = (sessions: DaySession[]): DaySession | null => sessions.find(takesQueue) ?? null;

/** When the day's OPD begins: the live queue's start, else the first session's. */
export const dayStartAt = (sessions: DaySession[]): Date | null =>
  (queueSession(sessions) ?? sessions[0])?.startAt ?? null;

/**
 * When the live queue stops taking new tokens, or null when it never does.
 *
 * Only a hybrid day closes: there is a slot-only session after the queue, and
 * from the queue's end the evening belongs to booked slots. A plain queue day
 * keeps its old behaviour — tokens are issued for as long as the desk issues
 * them — so no existing hospital sees a change it did not configure.
 */
export function liveQueueClosesAt(sessions: DaySession[]): Date | null {
  const queue = queueSession(sessions);
  if (!queue) return null;
  const slotAfter = sessions.some((s) => s.mode === 'slot' && s.startAt.getTime() >= queue.endAt.getTime());
  return slotAfter ? queue.endAt : null;
}

export function isLiveQueueOpen(sessions: DaySession[], now: Date): boolean {
  const closes = liveQueueClosesAt(sessions);
  return closes === null || now.getTime() < closes.getTime();
}

/**
 * What a patient booking now can choose: the live queue, a slot, or either.
 * A hybrid day offers both until the queue closes, then slots only. Null when
 * the doctor has no sessions that day.
 */
export function effectiveMode(sessions: DaySession[], now: Date): SessionMode | null {
  if (sessions.length === 0) return null;
  const queue = sessions.some(takesQueue) && isLiveQueueOpen(sessions, now);
  const slots = sessions.some(takesSlots);
  if (queue && slots) return 'both';
  if (queue) return 'queue';
  return slots ? 'slot' : 'queue';
}

/** The session a slot time belongs to, if it is a bookable slot of one. */
export function sessionForSlot(sessions: DaySession[], slotAt: Date): DaySession | null {
  const t = slotAt.getTime();
  return sessions.find((s) => takesSlots(s) && t >= s.startAt.getTime() && t < s.endAt.getTime()) ?? null;
}

/**
 * Whether a session keeps its own numbered list (S1, S2…) instead of handing
 * out live-queue tokens: a slot-only session on a split day. A single-session
 * day, slot-only included, books exactly as it always has.
 */
export const runsOwnList = (sessions: DaySession[], session: Pick<DaySession, 'mode'>): boolean =>
  session.mode === 'slot' && sessions.length > 1;

/**
 * The S-number of a slot in a session that runs its own list: its position by
 * time across those sessions, counting every slot whether or not it is open.
 * So 20:00 is S1 and 20:10 is S2 whatever order they were booked in, and the
 * number tells reception the calling order at a glance. Null for anything else.
 */
export function slotNumber(sessions: DaySession[], slotAt: Date): number | null {
  if (sessions.length < 2) return null;
  let offset = 0;
  for (const s of sessions.filter((x) => x.mode === 'slot')) {
    const slotMs = s.slotMinutes * 60_000;
    const count = Math.floor((s.endAt.getTime() - s.startAt.getTime()) / slotMs);
    const delta = slotAt.getTime() - s.startAt.getTime();
    if (delta >= 0 && delta < count * slotMs) {
      return delta % slotMs === 0 ? offset + delta / slotMs + 1 : null;
    }
    offset += count;
  }
  return null;
}
