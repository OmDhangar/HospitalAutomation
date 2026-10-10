/**
 * The due engine (IPD sheets plan B3b, §7.10). Pure, and run on the ward
 * tablet too, so the board keeps counting when the connection drops.
 *
 * A line's timing becomes due instances: fixed clock times (08:00 / 20:00),
 * an interval from the first dose (every 12 h), once (STAT), or when needed
 * (SOS: never due). Each instance has a two-sided window — ±30 min for a
 * time-critical medicine, ±60 for the rest, or the medicine's own — and a
 * status: upcoming, due soon, due now, overdue; or, once recorded, given on
 * time / late / early, or not given. Nothing is stored ahead: the instances
 * are computed from the line and what was recorded against it.
 *
 * After a late dose: a clock line keeps its schedule (the board warns when
 * the next dose is close); an interval line shifts (next = given + interval).
 * The doctor can choose the other per line. Late past the window end + 15 min
 * is escalation level 1 (ward in-charge), + 45 min level 2 (doctor on call).
 * We hard-code no clinical timings beyond these defaults, which the hospital
 * sets and its doctor signs off (D-TIMECRIT, D-ESCAL).
 */

import { serviceDateIn, zonedTimeToUtc } from '@/lib/domain/time';

export type TimingMode = 'clock' | 'interval' | 'prn' | 'once';
export type LatePolicy = 'keep' | 'shift';
export const TASK_KINDS = {
  vitals: 'Vitals (TPR, BP)',
  bsl: 'Blood sugar check',
  dressing: 'Dressing',
  reposition: 'Turn / reposition',
  other: 'Other task',
} as const;
export type TaskKind = keyof typeof TASK_KINDS;
export const isTaskKind = (value: string): value is TaskKind => value in TASK_KINDS;

export type Timing =
  | { mode: 'clock'; clockTimes: number[]; latePolicy: LatePolicy }
  | { mode: 'interval'; intervalMin: number; firstDueAt: Date; latePolicy: LatePolicy }
  | { mode: 'once'; firstDueAt: Date }
  | { mode: 'prn' };

export type DueSettings = {
  tcWindowMin: number;
  otherWindowMin: number;
  dueSoonLeadMin: number;
  l1AfterMin: number;
  l2AfterMin: number;
};

export const DEFAULT_DUE_SETTINGS: DueSettings = {
  tcWindowMin: 30,
  otherWindowMin: 60,
  dueSoonLeadMin: 30,
  l1AfterMin: 15,
  l2AfterMin: 45,
};

/** The hospital's settings, from the module's stored settings, each kept inside sensible bounds. */
export function dueSettingsFrom(raw: Record<string, unknown> | null | undefined): DueSettings {
  const pick = (key: keyof DueSettings, min: number, max: number) => {
    const value = raw?.[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : DEFAULT_DUE_SETTINGS[key];
  };
  return {
    tcWindowMin: pick('tcWindowMin', 5, 120),
    otherWindowMin: pick('otherWindowMin', 5, 240),
    dueSoonLeadMin: pick('dueSoonLeadMin', 0, 120),
    l1AfterMin: pick('l1AfterMin', 5, 120),
    l2AfterMin: pick('l2AfterMin', 10, 240),
  };
}

/* ------------------------------------------------------------------ timing */

export const minutesToClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** "08:00, 20:00" or "8, 20" or "0800 2000" → [480, 1200]. Null when any part is not a time. */
export function parseClockTimes(raw: string): number[] | null {
  const parts = raw.split(/[\s,;/]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 24) return null;
  const minutes: number[] = [];
  for (const part of parts) {
    const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(part);
    if (!m) return null;
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
    minutes.push((h % 24) * 60 + min);
  }
  return [...new Set(minutes)].sort((a, b) => a - b);
}

/**
 * What a written frequency suggests, for the doctor to accept or change:
 * OD 08:00; BD 08:00/20:00; TDS 06:00/14:00/22:00; QID 06/12/18/24; HS 22:00;
 * qNh every N hours from now; SOS when needed; STAT once now.
 */
export function suggestTiming(frequency: string): { mode: TimingMode; clockTimes?: number[]; intervalMin?: number } {
  const f = frequency.trim().toUpperCase().replace(/\s+/g, '');
  const clock = (...hours: number[]) => ({ mode: 'clock' as const, clockTimes: hours.map((h) => (h % 24) * 60) });
  if (f === 'OD' || f === 'QD' || f === 'DAILY') return clock(8);
  if (f === 'BD' || f === 'BID') return clock(8, 20);
  if (f === 'TDS' || f === 'TID') return clock(6, 14, 22);
  if (f === 'QID' || f === 'QDS') return clock(6, 12, 18, 24);
  if (f === 'HS') return clock(22);
  if (f === 'SOS' || f === 'PRN') return { mode: 'prn' };
  if (f === 'STAT' || f === 'ONCE') return { mode: 'once' };
  const q = /^Q(\d{1,2})H$/.exec(f);
  if (q && Number(q[1]) >= 1 && Number(q[1]) <= 72) return { mode: 'interval', intervalMin: Number(q[1]) * 60 };
  return { mode: 'prn' };
}

/** The default after a late dose: clock keeps its schedule; interval shifts (D-ORD). */
export const defaultLatePolicy = (mode: TimingMode): LatePolicy => (mode === 'interval' ? 'shift' : 'keep');

/* ---------------------------------------------------------------- instances */

export type InstanceStatus =
  | 'upcoming'
  | 'due_soon'
  | 'due_now'
  | 'overdue'
  | 'given_on_time'
  | 'given_late'
  | 'given_early'
  | 'not_given';

export const STATUS_TEXT: Record<InstanceStatus, string> = {
  upcoming: 'Later',
  due_soon: 'Due soon',
  due_now: 'Due now',
  overdue: 'OVERDUE',
  given_on_time: 'Given',
  given_late: 'Given late',
  given_early: 'Given early',
  not_given: 'Not given',
};

export type DueRecord = {
  id: string;
  /** The due time it answers; null for a dose given outside the schedule, or a chart reading. */
  dueAt: Date | null;
  state: 'given' | 'held' | 'refused' | 'not_available' | 'omitted';
  occurredAt: Date;
  /** A chart reading that completes a vitals or sugar task in its window. */
  fromChart?: boolean;
};

export type Instance = {
  dueAt: Date;
  windowStart: Date;
  windowEnd: Date;
  status: InstanceStatus;
  record: DueRecord | null;
  /** Minutes past the window end, for an overdue instance. */
  overdueMin: number;
  /** 0 none, 1 ward in-charge, 2 doctor on call — only meaningful for time-critical lines. */
  escalation: 0 | 1 | 2;
  /** Snoozed until this time (alerts and escalation held). */
  snoozedUntil: Date | null;
  /** A clock line after a late dose: the next dose comes too soon — check with the doctor. */
  closeToPrevious: boolean;
};

export type LineForDue = {
  timing: Timing;
  orderedAt: Date;
  stoppedAt: Date | null;
  /** Half-width of the window in minutes, before and after. */
  windowBeforeMin: number;
  windowAfterMin: number;
};

const MIN = 60_000;

/** The window for a line: the medicine's own when time-critical and set, else the hospital's. */
export function windowFor(args: {
  timeCritical: boolean;
  medicineBefore: number | null;
  medicineAfter: number | null;
  settings: DueSettings;
}): { before: number; after: number } {
  if (args.timeCritical) {
    return { before: args.medicineBefore ?? args.settings.tcWindowMin, after: args.medicineAfter ?? args.settings.tcWindowMin };
  }
  return { before: args.settings.otherWindowMin, after: args.settings.otherWindowMin };
}

/** Raw due times of a line inside [from, to), before records shift anything. */
function scheduledDues(line: LineForDue, from: Date, to: Date, timezone: string, records: readonly DueRecord[]): Date[] {
  const t = line.timing;
  const start = line.orderedAt;
  const end = line.stoppedAt && line.stoppedAt < to ? line.stoppedAt : to;
  const out: Date[] = [];
  if (t.mode === 'prn') return out;
  if (t.mode === 'once') {
    if (t.firstDueAt >= from && t.firstDueAt < end) out.push(t.firstDueAt);
    return out;
  }
  if (t.mode === 'clock') {
    // Each local day touching the range, a little either side for windows that cross midnight.
    let day = serviceDateIn(timezone, new Date(from.getTime() - 24 * 3_600_000));
    const lastDay = serviceDateIn(timezone, new Date(end.getTime() + 24 * 3_600_000));
    for (let guard = 0; day <= lastDay && guard < 400; guard++) {
      for (const minutes of t.clockTimes) {
        const due = zonedTimeToUtc(day, minutesToClock(minutes), timezone);
        if (due >= start && due >= from && due < end) out.push(due);
      }
      const d = new Date(`${day}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      day = d.toISOString().slice(0, 10);
    }
    return out.sort((a, b) => a.getTime() - b.getTime());
  }
  // Interval.
  const step = t.intervalMin * MIN;
  if (t.latePolicy === 'keep') {
    const k0 = Math.max(0, Math.ceil((from.getTime() - t.firstDueAt.getTime()) / step));
    for (let k = k0, guard = 0; guard < 2000; k++, guard++) {
      const due = new Date(t.firstDueAt.getTime() + k * step);
      if (due >= end) break;
      out.push(due);
    }
    return out;
  }
  // Shift: each next due counts from the dose actually given against the one before.
  const given = new Map(records.filter((r) => r.dueAt && r.state === 'given').map((r) => [r.dueAt!.getTime(), r.occurredAt]));
  let due = t.firstDueAt;
  for (let guard = 0; guard < 2000 && due < end; guard++) {
    if (due >= from) out.push(due);
    const at = given.get(due.getTime());
    due = new Date((at ?? due).getTime() + step);
  }
  return out;
}

/**
 * The instances of one line in [from, to) at `now`, with what was recorded
 * against each: first by the due time a dose was given for, then — for task
 * lines — chart readings taken inside a window.
 */
export function instancesFor(args: {
  line: LineForDue;
  records: readonly DueRecord[];
  from: Date;
  to: Date;
  now: Date;
  timezone: string;
  settings: DueSettings;
  snoozes?: readonly { dueAt: Date; until: Date }[];
}): Instance[] {
  const live = args.records;
  const dues = scheduledDues(args.line, args.from, args.to, args.timezone, live);
  const byDue = new Map(live.filter((r) => r.dueAt).map((r) => [r.dueAt!.getTime(), r]));
  const chart = live.filter((r) => r.fromChart).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const usedChart = new Set<string>();
  const before = args.line.windowBeforeMin * MIN;
  const after = args.line.windowAfterMin * MIN;
  const now = args.now.getTime();

  const out: Instance[] = [];
  let previous: { dueAt: Date; record: DueRecord | null } | null = null;
  for (const dueAt of dues) {
    const windowStart = new Date(dueAt.getTime() - before);
    const windowEnd = new Date(dueAt.getTime() + after);
    let record = byDue.get(dueAt.getTime()) ?? null;
    if (!record) {
      const reading = chart.find((r) => !usedChart.has(r.id) && r.occurredAt >= windowStart && r.occurredAt <= windowEnd);
      if (reading) {
        usedChart.add(reading.id);
        record = reading;
      }
    }

    let status: InstanceStatus;
    if (record) {
      if (record.state !== 'given') status = 'not_given';
      else if (record.occurredAt < windowStart) status = 'given_early';
      else if (record.occurredAt > windowEnd) status = 'given_late';
      else status = 'given_on_time';
    } else if (now > windowEnd.getTime()) status = 'overdue';
    else if (now >= windowStart.getTime()) status = 'due_now';
    else if (now >= windowStart.getTime() - args.settings.dueSoonLeadMin * MIN) status = 'due_soon';
    else status = 'upcoming';

    const snoozedUntil =
      (args.snoozes ?? [])
        .filter((s) => s.dueAt.getTime() === dueAt.getTime())
        .map((s) => s.until)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const overdueMin = status === 'overdue' ? Math.floor((now - windowEnd.getTime()) / MIN) : 0;
    const held = snoozedUntil !== null && snoozedUntil.getTime() > now;
    const escalation: 0 | 1 | 2 =
      status !== 'overdue' || held ? 0 : overdueMin >= args.settings.l2AfterMin ? 2 : overdueMin >= args.settings.l1AfterMin ? 1 : 0;

    // Keep-schedule after a late dose: warn when the gap to this one is under half the usual gap.
    let closeToPrevious = false;
    if (previous?.record?.state === 'given' && args.line.timing.mode !== 'interval' && !record) {
      const usual = dueAt.getTime() - previous.dueAt.getTime();
      const gap = dueAt.getTime() - previous.record.occurredAt.getTime();
      closeToPrevious = usual > 0 && gap < usual / 2;
    }

    out.push({ dueAt, windowStart, windowEnd, status, record, overdueMin, escalation, snoozedUntil, closeToPrevious });
    previous = { dueAt, record };
  }
  return out;
}

/** How a give stands against the due time it answers: for the dose row (timing_status, delay_min). */
export function timingOfGive(args: { dueAt: Date; occurredAt: Date; windowBeforeMin: number; windowAfterMin: number }): {
  status: 'on_time' | 'late' | 'early';
  delayMin: number;
} {
  const delayMin = Math.round((args.occurredAt.getTime() - args.dueAt.getTime()) / MIN);
  if (delayMin > args.windowAfterMin) return { status: 'late', delayMin };
  if (delayMin < -args.windowBeforeMin) return { status: 'early', delayMin };
  return { status: 'on_time', delayMin };
}

export const SNOOZE_MAX_MIN = 30;
export const SNOOZES_PER_DOSE = 2;

/* -------------------------------------------------------------- the board */

/** The paper MAR's round columns, in chart-day order from 8 am. */
export const DEFAULT_SLOTS = [8, 10, 12, 14, 16, 18, 20, 22, 0, 2, 4, 6] as const;

/** Which round column (an hour) a due time falls in: the slot at or before it, two hours wide. */
export function slotOf(dueAt: Date, timezone: string, slots: readonly number[] = DEFAULT_SLOTS): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).formatToParts(dueAt);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const sorted = [...slots].sort((a, b) => a - b);
  let slot = sorted[sorted.length - 1];
  for (const s of sorted) if (s <= hour) slot = s;
  return slot;
}

/** The mark a cell shows, as on paper: ✓ on time, ✓ with the time if late or early, ✗/H/R, or the due state. */
export function cellMark(instance: Instance, recordState?: DueRecord['state']): string {
  switch (instance.status) {
    case 'given_on_time':
      return '✓';
    case 'given_late':
    case 'given_early':
      return '✓*';
    case 'not_given':
      return recordState === 'held' ? 'H' : recordState === 'refused' ? 'R' : '✗';
    case 'overdue':
      return '!';
    default:
      return '';
  }
}

/** Shifts 8–2–8, for the once-per-shift alert-volume question. */
export function shiftNow(at: Date, timezone: string): { day: string; shift: 'morning' | 'evening' | 'night' } {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const today = serviceDateIn(timezone, at);
  if (hour >= 8 && hour < 14) return { day: today, shift: 'morning' };
  if (hour >= 14 && hour < 20) return { day: today, shift: 'evening' };
  // The night shift belongs to the day it started on.
  if (hour >= 20) return { day: today, shift: 'night' };
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { day: d.toISOString().slice(0, 10), shift: 'night' };
}

/** Quiet hours for the ward-tablet chime: "22:00"–"06:00" wraps midnight. */
export function inQuietHours(at: Date, timezone: string, from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: timezone }).formatToParts(at);
  const now = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const a = fh * 60 + fm;
  const b = th * 60 + tm;
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

/** Medicines the hospital may want to review as time-critical (§7.10, informed by ISMP; to verify). Never switched on by us. */
export const TIME_CRITICAL_STARTER_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'IV antibiotics', pattern: /ceftriaxone|cefotaxime|cefepime|piperacillin|meropenem|imipenem|vancomycin|amikacin|gentamicin|ampicillin|linezolid|metronidazole iv/i },
  { label: 'Anticoagulants (LMWH, heparin)', pattern: /enoxaparin|dalteparin|heparin|fondaparinux/i },
  { label: 'Insulin', pattern: /insulin/i },
  { label: 'Anti-epileptics', pattern: /phenytoin|levetiracetam|valpro|carbamazepine|lacosamide|phenobarb/i },
  { label: 'Parkinson’s medicines', pattern: /levodopa|carbidopa|pramipexole|ropinirole/i },
  { label: 'Immunosuppressants', pattern: /tacrolimus|cyclosporin|mycophenol/i },
  { label: 'Vasoactive infusions', pattern: /noradrenaline|norepinephrine|dopamine|dobutamine|adrenaline|vasopressin/i },
];

/* ----------------------------------------------------------- order timing */

export class TimingError extends Error {}

export type TimingInput =
  | { mode: 'clock'; clockTimes: number[]; latePolicy: LatePolicy }
  | { mode: 'interval'; intervalMin: number; firstDueAt: Date; latePolicy: LatePolicy }
  | { mode: 'once'; firstDueAt: Date }
  | { mode: 'prn' };

/**
 * The timing the doctor chose, checked: clock times as typed; every N hours
 * from a first dose (default now); once at a time (default now); or when
 * needed. Missing timing follows the written frequency's suggestion.
 */
export function parseTiming(
  raw: { timingMode?: string | null; clockTimes?: string | null; intervalHours?: string | number | null; firstDueAt?: string | null; latePolicy?: string | null },
  frequency: string | null,
  now: Date,
): TimingInput {
  const suggested = suggestTiming(frequency ?? '');
  const mode = (raw.timingMode || suggested.mode) as TimingMode;
  const policy = raw.latePolicy === 'keep' || raw.latePolicy === 'shift' ? raw.latePolicy : defaultLatePolicy(mode);
  const first = raw.firstDueAt ? new Date(raw.firstDueAt) : now;
  if (Number.isNaN(first.getTime())) throw new TimingError('Check the time of the first dose');
  if (first.getTime() < now.getTime() - 24 * 3_600_000 || first.getTime() > now.getTime() + 7 * 24 * 3_600_000) {
    throw new TimingError('The first dose must be within a day before and a week after now');
  }
  switch (mode) {
    case 'clock': {
      const times = raw.clockTimes ? parseClockTimes(raw.clockTimes) : (suggested.clockTimes ?? null);
      if (!times || times.length === 0) throw new TimingError('Write the clock times, e.g. 08:00, 20:00');
      return { mode, clockTimes: times, latePolicy: policy };
    }
    case 'interval': {
      const hours = raw.intervalHours !== undefined && raw.intervalHours !== null && raw.intervalHours !== '' ? Number(raw.intervalHours) : (suggested.intervalMin ?? 0) / 60;
      const minutes = Math.round(hours * 60);
      if (!Number.isFinite(hours) || minutes < 15 || minutes > 10080) throw new TimingError('Every how many hours? (¼ to 168)');
      return { mode, intervalMin: minutes, firstDueAt: first, latePolicy: policy };
    }
    case 'once':
      return { mode, firstDueAt: first };
    case 'prn':
      return { mode };
    default:
      throw new TimingError('Choose when it is given');
  }
}

/** A line's timing as one short phrase: "08:00 · 20:00", "every 12 h", "once 14:30", "when needed". */
export function timingText(t: Timing | null, timezone: string): string {
  if (!t) return '';
  if (t.mode === 'clock') return t.clockTimes.map(minutesToClock).join(' · ');
  if (t.mode === 'interval') return `every ${t.intervalMin % 60 === 0 ? `${t.intervalMin / 60} h` : `${t.intervalMin} min`}${t.latePolicy === 'keep' ? ' (fixed)' : ''}`;
  if (t.mode === 'once') return `once ${t.firstDueAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })}`;
  return 'when needed';
}

/** A stored line's timing columns as a Timing, or null for lines without one. */
export function timingFromRow(row: {
  timingMode: TimingMode | null;
  clockTimes: number[] | null;
  intervalMin: number | null;
  firstDueAt: Date | null;
  latePolicy: LatePolicy | null;
}): Timing | null {
  switch (row.timingMode) {
    case 'clock':
      return row.clockTimes ? { mode: 'clock', clockTimes: row.clockTimes, latePolicy: row.latePolicy ?? 'keep' } : null;
    case 'interval':
      return row.intervalMin && row.firstDueAt ? { mode: 'interval', intervalMin: row.intervalMin, firstDueAt: row.firstDueAt, latePolicy: row.latePolicy ?? 'shift' } : null;
    case 'once':
      return row.firstDueAt ? { mode: 'once', firstDueAt: row.firstDueAt } : null;
    case 'prn':
      return { mode: 'prn' };
    default:
      return null;
  }
}

/* --------------------------------------------------- the board, over the wire */

/** Timing as JSON (the board is computed on the tablet too). */
export type TimingJson =
  | { mode: 'clock'; clockTimes: number[]; latePolicy: LatePolicy }
  | { mode: 'interval'; intervalMin: number; firstDueAt: string; latePolicy: LatePolicy }
  | { mode: 'once'; firstDueAt: string }
  | { mode: 'prn' };

export function timingToJson(t: Timing): TimingJson {
  if (t.mode === 'interval') return { ...t, firstDueAt: t.firstDueAt.toISOString() };
  if (t.mode === 'once') return { ...t, firstDueAt: t.firstDueAt.toISOString() };
  return t;
}

export function timingFromJson(t: TimingJson): Timing {
  if (t.mode === 'interval') return { ...t, firstDueAt: new Date(t.firstDueAt) };
  if (t.mode === 'once') return { ...t, firstDueAt: new Date(t.firstDueAt) };
  return t;
}

export type MarSettings = DueSettings & { chime: boolean; quietFrom: string | null; quietTo: string | null };

export function marSettingsFrom(raw: Record<string, unknown> | null | undefined): MarSettings {
  const clock = (v: unknown) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
  return {
    ...dueSettingsFrom(raw),
    chime: raw?.chime === true,
    quietFrom: clock(raw?.quietFrom) ?? '22:00',
    quietTo: clock(raw?.quietTo) ?? '06:00',
  };
}

export type BoardLine = {
  orderId: string;
  admissionId: string;
  kind: 'medicine' | 'task';
  taskKind: TaskKind | null;
  description: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
  timing: TimingJson;
  orderedAt: string;
  stoppedAt: string | null;
  timeCritical: boolean;
  windowBefore: number;
  windowAfter: number;
  risk: boolean;
};

export type BoardRecord = { id: string; orderId: string; dueAt: string | null; state: DueRecord['state']; occurredAt: string; fromChart?: boolean };

export type BoardPayload = {
  ward: { id: string; name: string };
  timezone: string;
  serverNow: string;
  stage: 'observe' | 'warn' | 'enforce';
  settings: MarSettings;
  tcActive: boolean;
  from: string;
  to: string;
  beds: { bedId: string; label: string; admissionId: string | null; patientName: string | null; detail: string | null }[];
  lines: BoardLine[];
  records: BoardRecord[];
  snoozes: { orderId: string; dueAt: string; until: string; count: number }[];
  escalations: { id: string; orderId: string; dueAt: string; level: 1 | 2; acknowledged: boolean }[];
  ratedThisShift: boolean;
};

export type BoardItem = { line: BoardLine; instance: Instance };

/** Every instance on the board at `now`, from a payload (server or the tablet's cached copy). */
export function boardInstances(payload: BoardPayload, now: Date): BoardItem[] {
  const out: BoardItem[] = [];
  for (const line of payload.lines) {
    const records = payload.records
      .filter((r) => r.orderId === line.orderId)
      .map((r) => ({ id: r.id, dueAt: r.dueAt ? new Date(r.dueAt) : null, state: r.state, occurredAt: new Date(r.occurredAt), fromChart: r.fromChart }));
    const snoozes = payload.snoozes.filter((s) => s.orderId === line.orderId).map((s) => ({ dueAt: new Date(s.dueAt), until: new Date(s.until) }));
    const instances = instancesFor({
      line: {
        timing: timingFromJson(line.timing),
        orderedAt: new Date(line.orderedAt),
        stoppedAt: line.stoppedAt ? new Date(line.stoppedAt) : null,
        windowBeforeMin: line.windowBefore,
        windowAfterMin: line.windowAfter,
      },
      records,
      from: new Date(payload.from),
      to: new Date(payload.to),
      now,
      timezone: payload.timezone,
      settings: payload.settings,
      snoozes,
    });
    for (const instance of instances) out.push({ line, instance });
  }
  return out.sort((a, b) => a.instance.dueAt.getTime() - b.instance.dueAt.getTime());
}
