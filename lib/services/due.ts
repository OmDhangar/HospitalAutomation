import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, max, or, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import {
  admissions,
  alertRatings,
  auditLogs,
  bedAssignments,
  beds,
  chartEntries,
  doctors,
  dueEscalations,
  dueRollupsDaily,
  dueSnoozes,
  hospitalFeatures,
  hospitals,
  marAdministrations,
  medicineRiskClasses,
  medicines,
  onCallAssignments,
  patients,
  staffMemberships,
  timeCriticalSignoffs,
  treatmentOrders,
  users,
  wards,
} from '@/lib/db/schema';
import {
  SNOOZES_PER_DOSE,
  SNOOZE_MAX_MIN,
  TIME_CRITICAL_STARTER_PATTERNS,
  boardInstances,
  marSettingsFrom,
  shiftNow,
  timingFromRow,
  timingToJson,
  windowFor,
  type BoardLine,
  type BoardPayload,
  type BoardRecord,
  type MarSettings,
} from '@/lib/domain/due';
import { MarError } from '@/lib/domain/mar';
import { chartDayOf, chartDayWindow } from '@/lib/domain/tpr';
import { moduleAllows, resolveModuleStates, type ModuleStage } from '@/lib/modules/registry';

/**
 * Due times, the due board and time-critical alerts (IPD sheets plan B3b,
 * §7.10; migration 0049). The instances themselves come from
 * lib/domain/due.ts; this file loads what they are computed from, writes the
 * few things that happen (snoozes, escalations, ratings, settings, sign-offs,
 * on-call), and runs the escalation and roll-up sweeps.
 */

const clinical = { clinical: true } as const;
const MIN = 60_000;
const HOUR = 3_600_000;

async function audit(tx: Tx, args: { hospitalId: string; actorUserId: string | null; action: string; objectType: string; objectId: string; metadata?: Record<string, unknown> }) {
  await tx.insert(auditLogs).values(args);
}

/* ================================================================ settings */

export type MarConfig = { stage: ModuleStage; settings: MarSettings; tcActive: boolean; signoff: SignoffStatus };

export type SignoffStatus = {
  signedAt: Date | null;
  signedBy: string | null;
  /** The list and windows are as signed: time-critical alerts run. */
  current: boolean;
  /** Medicines marked time-critical now. */
  count: number;
};

const signedWindows = (s: MarSettings) => ({ tcWindowMin: s.tcWindowMin, l1AfterMin: s.l1AfterMin, l2AfterMin: s.l2AfterMin });

async function signoffStatusInTx(tx: Tx, hospitalId: string, settings: MarSettings): Promise<SignoffStatus> {
  const [[latest], [changed]] = await Promise.all([
    tx
      .select({ signedAt: timeCriticalSignoffs.signedAt, windows: timeCriticalSignoffs.windows, by: users.name })
      .from(timeCriticalSignoffs)
      .leftJoin(users, eq(users.id, timeCriticalSignoffs.signedByUserId))
      .where(eq(timeCriticalSignoffs.hospitalId, hospitalId))
      .orderBy(desc(timeCriticalSignoffs.signedAt))
      .limit(1),
    tx
      .select({ last: max(medicines.tcChangedAt), count: sql<number>`count(*) filter (where ${medicines.timeCritical})::int` })
      .from(medicines)
      .where(eq(medicines.hospitalId, hospitalId)),
  ]);
  // Compared key by key: jsonb does not keep the order keys were written in.
  const want = signedWindows(settings);
  const windowsSame = latest ? (Object.keys(want) as (keyof typeof want)[]).every((k) => latest.windows[k] === want[k]) : false;
  const listSame = latest ? !changed.last || changed.last <= latest.signedAt : false;
  return { signedAt: latest?.signedAt ?? null, signedBy: latest?.by ?? null, current: Boolean(latest) && windowsSame && listSame, count: changed.count };
}

async function configInTx(tx: Tx, hospitalId: string): Promise<MarConfig> {
  const [row] = await tx
    .select({ state: hospitalFeatures.state, stage: hospitalFeatures.stage, settings: hospitalFeatures.settings })
    .from(hospitalFeatures)
    .where(and(eq(hospitalFeatures.hospitalId, hospitalId), eq(hospitalFeatures.moduleId, 'mar')));
  const settings = marSettingsFrom(row?.settings);
  const signoff = await signoffStatusInTx(tx, hospitalId, settings);
  return { stage: row?.stage ?? 'observe', settings, tcActive: signoff.current, signoff };
}

export async function getMarConfig(hospitalId: string): Promise<MarConfig> {
  return withTenant(hospitalId, (tx) => configInTx(tx, hospitalId));
}

/** The windows, escalation delays and chime (owner). A change of the time-critical window or delays needs a new sign-off. */
export async function updateDueSettings(args: { hospitalId: string; settings: Partial<MarSettings>; actorUserId: string }): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    const current = (await configInTx(tx, args.hospitalId)).settings;
    const next = marSettingsFrom({ ...current, ...args.settings });
    if (next.l2AfterMin <= next.l1AfterMin) throw new MarError('Level 2 must come after level 1');
    await tx
      .insert(hospitalFeatures)
      .values({ hospitalId: args.hospitalId, moduleId: 'mar', state: 'off', settings: next, updatedByUserId: args.actorUserId })
      .onConflictDoUpdate({
        target: [hospitalFeatures.hospitalId, hospitalFeatures.moduleId],
        set: { settings: next, updatedByUserId: args.actorUserId, updatedAt: new Date() },
      });
    await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actorUserId, action: 'mar.due_settings', objectType: 'hospital', objectId: args.hospitalId, metadata: next });
  });
}

/* ============================================================ time-critical */

export type TcMedicine = { id: string; label: string; timeCritical: boolean; before: number | null; after: number | null; starter: string | null };

/** Medicines for the time-critical list: those marked, and (searching) any other; starter suggestions named. */
export async function listTimeCriticalMedicines(hospitalId: string, query = ''): Promise<TcMedicine[]> {
  const q = query.trim().toLowerCase();
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: medicines.id,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        timeCritical: medicines.timeCritical,
        before: medicines.tcWindowBeforeMin,
        after: medicines.tcWindowAfterMin,
      })
      .from(medicines)
      .where(and(eq(medicines.active, true), q ? sql`lower(${medicines.name}) like ${`%${q.replace(/[%_\\]/g, '\\$&')}%`}` : undefined))
      .orderBy(desc(medicines.timeCritical), asc(medicines.name))
      .limit(200),
  );
  return rows
    .map((r) => ({
      id: r.id,
      label: [r.name, r.strength, r.form].filter(Boolean).join(' '),
      timeCritical: r.timeCritical,
      before: r.before,
      after: r.after,
      starter: TIME_CRITICAL_STARTER_PATTERNS.find((p) => p.pattern.test(r.name))?.label ?? null,
    }))
    .filter((r) => q || r.timeCritical || r.starter);
}

/** Marks a medicine time-critical (or not), with its own window. The list then needs a new sign-off before alerts run. */
export async function setTimeCritical(args: {
  hospitalId: string;
  medicineId: string;
  timeCritical: boolean;
  before: number | null;
  after: number | null;
  actorUserId: string;
}): Promise<void> {
  for (const v of [args.before, args.after]) {
    if (v !== null && (!Number.isInteger(v) || v < 5 || v > 240)) throw new MarError('A window is 5 to 240 minutes');
  }
  await withTenant(args.hospitalId, async (tx) => {
    const updated = await tx
      .update(medicines)
      .set({
        timeCritical: args.timeCritical,
        tcWindowBeforeMin: args.timeCritical ? args.before : null,
        tcWindowAfterMin: args.timeCritical ? args.after : null,
        tcChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(medicines.id, args.medicineId))
      .returning({ id: medicines.id });
    if (updated.length === 0) throw new MarError('Medicine not found');
    await audit(tx, {
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'mar.time_critical_set',
      objectType: 'medicine',
      objectId: args.medicineId,
      metadata: { timeCritical: args.timeCritical, before: args.before, after: args.after },
    });
  });
}

/**
 * The hospital's doctor signs off the time-critical list and windows as they
 * stand (D-TIMECRIT). Only a login linked to a doctor. Alerts for
 * time-critical lines run while the list and windows are unchanged since.
 */
export async function signOffTimeCritical(args: { hospitalId: string; actorUserId: string; note: string | null }): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(and(eq(doctors.userId, args.actorUserId), eq(doctors.active, true)));
    if (!doctor) throw new MarError('Only a doctor of this hospital signs off the time-critical list');
    const config = await configInTx(tx, args.hospitalId);
    const settings = config.settings;
    const list = await tx
      .select({ id: medicines.id, name: medicines.name, before: medicines.tcWindowBeforeMin, after: medicines.tcWindowAfterMin })
      .from(medicines)
      .where(eq(medicines.timeCritical, true))
      .orderBy(asc(medicines.name));
    await tx.insert(timeCriticalSignoffs).values({
      hospitalId: args.hospitalId,
      signedByUserId: args.actorUserId,
      signedRole: 'doctor',
      doctorId: doctor.id,
      list: list.map((m) => ({ medicineId: m.id, name: m.name, before: m.before ?? settings.tcWindowMin, after: m.after ?? settings.tcWindowMin })),
      windows: signedWindows(settings),
      note: args.note?.trim().slice(0, 300) || null,
    });
  });
}

/* ================================================== on call and in charge */

export async function listOnCall(hospitalId: string, now: Date = new Date()) {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({ id: onCallAssignments.id, doctorName: doctors.name, branchId: onCallAssignments.branchId, startsAt: onCallAssignments.startsAt, endsAt: onCallAssignments.endsAt })
      .from(onCallAssignments)
      .innerJoin(doctors, eq(doctors.id, onCallAssignments.doctorId))
      .where(and(isNull(onCallAssignments.cancelledAt), gt(onCallAssignments.endsAt, now)))
      .orderBy(asc(onCallAssignments.startsAt))
      .limit(50),
  );
}

export async function addOnCall(args: { hospitalId: string; branchId: string; doctorId: string; startsAt: Date; endsAt: Date; actorUserId: string }) {
  if (!(args.endsAt > args.startsAt)) throw new MarError('The end must be after the start');
  if (args.endsAt.getTime() - args.startsAt.getTime() > 7 * 24 * HOUR) throw new MarError('One entry covers at most 7 days');
  await withTenant(args.hospitalId, (tx) =>
    tx.insert(onCallAssignments).values({
      hospitalId: args.hospitalId,
      branchId: args.branchId,
      doctorId: args.doctorId,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      createdByUserId: args.actorUserId,
    }),
  );
}

export async function cancelOnCall(args: { hospitalId: string; id: string; actorUserId: string }) {
  await withTenant(args.hospitalId, (tx) =>
    tx
      .update(onCallAssignments)
      .set({ cancelledAt: new Date(), cancelledByUserId: args.actorUserId })
      .where(and(eq(onCallAssignments.id, args.id), isNull(onCallAssignments.cancelledAt))),
  );
}

export async function setWardInCharge(args: { hospitalId: string; wardId: string; userId: string | null; actorUserId: string }) {
  await withTenant(args.hospitalId, async (tx) => {
    if (args.userId) {
      const [member] = await tx
        .select({ role: staffMemberships.role, active: staffMemberships.active })
        .from(staffMemberships)
        .where(eq(staffMemberships.userId, args.userId));
      if (!member?.active || !['owner', 'doctor', 'nurse'].includes(member.role)) throw new MarError('The in-charge must be a nurse or doctor on your staff');
    }
    await tx.update(wards).set({ inChargeUserId: args.userId, updatedAt: new Date() }).where(eq(wards.id, args.wardId));
    await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actorUserId, action: 'mar.ward_in_charge', objectType: 'ward', objectId: args.wardId, metadata: { userId: args.userId } });
  });
}

/* ============================================================== the board */

type Db = Tx;

type LoadedLine = BoardLine & { branchId: string; wardId: string | null; orderingDoctorUserId: string | null };

/**
 * The timed lines of these stays (medicines and tasks, not stopped, struck
 * out or instructions), the doses and chart readings recorded against them in
 * [from, to), and the snoozes — what the engine needs. Works on a tenant
 * transaction or the worker's connection.
 */
async function loadDueData(
  db: Db,
  args: { admissionIds: readonly string[]; from: Date; to: Date; settings: MarSettings; tcActive: boolean; onlyTimeCritical?: boolean },
): Promise<{ lines: LoadedLine[]; records: BoardRecord[]; snoozes: BoardPayload['snoozes'] }> {
  if (args.admissionIds.length === 0) return { lines: [], records: [], snoozes: [] };
  const rows = await db
    .select({
      orderId: treatmentOrders.id,
      admissionId: treatmentOrders.admissionId,
      branchId: treatmentOrders.branchId,
      kind: treatmentOrders.kind,
      taskKind: treatmentOrders.taskKind,
      description: treatmentOrders.description,
      dose: treatmentOrders.dose,
      route: treatmentOrders.route,
      frequency: treatmentOrders.frequency,
      orderedAt: treatmentOrders.orderedAt,
      stoppedAt: treatmentOrders.stoppedAt,
      timingMode: treatmentOrders.timingMode,
      clockTimes: treatmentOrders.clockTimes,
      intervalMin: treatmentOrders.intervalMin,
      firstDueAt: treatmentOrders.firstDueAt,
      latePolicy: treatmentOrders.latePolicy,
      timeCritical: medicines.timeCritical,
      tcBefore: medicines.tcWindowBeforeMin,
      tcAfter: medicines.tcWindowAfterMin,
      riskClassId: medicineRiskClasses.riskClassId,
      orderingDoctorUserId: doctors.userId,
    })
    .from(treatmentOrders)
    .innerJoin(doctors, eq(doctors.id, treatmentOrders.orderingDoctorId))
    .leftJoin(medicines, eq(medicines.id, treatmentOrders.medicineId))
    .leftJoin(medicineRiskClasses, eq(medicineRiskClasses.medicineId, treatmentOrders.medicineId))
    .where(
      and(
        inArray(treatmentOrders.admissionId, [...args.admissionIds]),
        isNull(treatmentOrders.voidedAt),
        inArray(treatmentOrders.timingMode, ['clock', 'interval', 'once', 'prn']),
        or(isNull(treatmentOrders.stoppedAt), gt(treatmentOrders.stoppedAt, args.from)),
        args.onlyTimeCritical ? eq(medicines.timeCritical, true) : undefined,
      ),
    )
    .orderBy(asc(treatmentOrders.orderedAt));

  const lines: LoadedLine[] = [];
  for (const r of rows) {
    const timing = timingFromRow(r);
    if (!timing || r.kind === 'instruction') continue;
    const timeCritical = Boolean(r.timeCritical) && args.tcActive;
    const window = windowFor({ timeCritical, medicineBefore: r.tcBefore, medicineAfter: r.tcAfter, settings: args.settings });
    lines.push({
      orderId: r.orderId,
      admissionId: r.admissionId,
      branchId: r.branchId,
      wardId: null,
      orderingDoctorUserId: r.orderingDoctorUserId,
      kind: r.kind === 'task' ? 'task' : 'medicine',
      taskKind: r.taskKind,
      description: r.description,
      dose: r.dose,
      route: r.route,
      frequency: r.frequency,
      timing: timingToJson(timing),
      orderedAt: r.orderedAt.toISOString(),
      stoppedAt: r.stoppedAt?.toISOString() ?? null,
      timeCritical,
      windowBefore: window.before,
      windowAfter: window.after,
      risk: Boolean(r.riskClassId),
    });
  }
  if (lines.length === 0) return { lines, records: [], snoozes: [] };
  const orderIds = lines.map((l) => l.orderId);
  // Records a little either side of the range: a dose given early or late still answers its due time.
  const recFrom = new Date(args.from.getTime() - 24 * HOUR);
  const recTo = new Date(args.to.getTime() + 24 * HOUR);
  const [doses, snoozes] = await Promise.all([
    db
      .select({ id: marAdministrations.id, orderId: marAdministrations.orderId, dueAt: marAdministrations.dueAt, state: marAdministrations.state, occurredAt: marAdministrations.occurredAt })
      .from(marAdministrations)
      .where(
        and(
          inArray(marAdministrations.orderId, orderIds),
          isNull(marAdministrations.voidedAt),
          gte(marAdministrations.occurredAt, recFrom),
          lt(marAdministrations.occurredAt, recTo),
        ),
      ),
    db
      .select({ orderId: dueSnoozes.orderId, dueAt: dueSnoozes.dueAt, until: dueSnoozes.until })
      .from(dueSnoozes)
      .where(and(inArray(dueSnoozes.orderId, orderIds), gte(dueSnoozes.dueAt, recFrom))),
  ]);
  const records: BoardRecord[] = doses.map((d) => ({
    id: d.id,
    orderId: d.orderId,
    dueAt: d.dueAt?.toISOString() ?? null,
    state: d.state,
    occurredAt: d.occurredAt.toISOString(),
  }));

  // Vitals and sugar tasks are done by a chart reading in their window.
  const taskLines = lines.filter((l) => l.taskKind === 'vitals' || l.taskKind === 'bsl');
  if (taskLines.length > 0) {
    const readings = await db
      .select({
        id: chartEntries.id,
        admissionId: chartEntries.admissionId,
        observedAt: chartEntries.observedAt,
        vitals: sql<boolean>`(${chartEntries.pulse} is not null or ${chartEntries.bpSystolic} is not null or ${chartEntries.tempFTenths} is not null)`,
        bsl: sql<boolean>`${chartEntries.bslMgDl} is not null`,
      })
      .from(chartEntries)
      .where(
        and(
          inArray(chartEntries.admissionId, [...new Set(taskLines.map((l) => l.admissionId))]),
          isNull(chartEntries.voidedAt),
          gte(chartEntries.observedAt, recFrom),
          lt(chartEntries.observedAt, recTo),
        ),
      );
    for (const line of taskLines) {
      for (const r of readings) {
        if (r.admissionId !== line.admissionId || !(line.taskKind === 'vitals' ? r.vitals : r.bsl)) continue;
        records.push({ id: `chart:${r.id}:${line.orderId}`, orderId: line.orderId, dueAt: null, state: 'given', occurredAt: r.observedAt.toISOString(), fromChart: true });
      }
    }
  }

  const grouped = new Map<string, BoardPayload['snoozes'][number]>();
  for (const s of snoozes) {
    const key = `${s.orderId}|${s.dueAt.toISOString()}`;
    const prev = grouped.get(key);
    grouped.set(key, {
      orderId: s.orderId,
      dueAt: s.dueAt.toISOString(),
      until: !prev || s.until.toISOString() > prev.until ? s.until.toISOString() : prev.until,
      count: (prev?.count ?? 0) + 1,
    });
  }
  return { lines, records, snoozes: [...grouped.values()] };
}

/** The ward's occupied beds and their stays. */
async function wardOccupancy(db: Db, wardId: string) {
  return db
    .select({
      bedId: beds.id,
      label: beds.label,
      sortOrder: beds.sortOrder,
      admissionId: admissions.id,
      patientName: patients.name,
      age: patients.age,
      gender: patients.gender,
    })
    .from(beds)
    .leftJoin(bedAssignments, and(eq(bedAssignments.bedId, beds.id), isNull(bedAssignments.toAt)))
    .leftJoin(admissions, and(eq(admissions.id, bedAssignments.admissionId), inArray(admissions.status, ['admitted', 'discharge_ready'])))
    .leftJoin(patients, eq(patients.id, admissions.patientId))
    .where(and(eq(beds.wardId, wardId), eq(beds.active, true)))
    .orderBy(asc(beds.sortOrder), asc(beds.label));
}

/**
 * Everything the ward's due board shows, as data the tablet can keep and
 * recompute offline: from 12 hours ago (last night's misses) to the end of
 * the current chart day (8 am to 8 am).
 */
export async function getWardBoard(args: { hospitalId: string; wardId: string; userId: string; timezone: string; now?: Date }): Promise<BoardPayload> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [ward] = await tx.select({ id: wards.id, name: wards.name }).from(wards).where(eq(wards.id, args.wardId));
      if (!ward) throw new MarError('Ward not found');
      const config = await configInTx(tx, args.hospitalId);
      const window = chartDayWindow(chartDayOf(now, args.timezone), args.timezone);
      const from = new Date(Math.min(window.from.getTime(), now.getTime() - 12 * HOUR));
      const to = window.to;
      const occupancy = await wardOccupancy(tx, args.wardId);
      const admissionIds = occupancy.flatMap((o) => (o.admissionId ? [o.admissionId] : []));
      const data = await loadDueData(tx, { admissionIds, from, to, settings: config.settings, tcActive: config.tcActive });
      const orderIds = data.lines.map((l) => l.orderId);
      const [escalations, [rated]] = await Promise.all([
        orderIds.length
          ? tx
              .select({ id: dueEscalations.id, orderId: dueEscalations.orderId, dueAt: dueEscalations.dueAt, level: dueEscalations.level, ackAt: dueEscalations.acknowledgedAt })
              .from(dueEscalations)
              .where(and(inArray(dueEscalations.orderId, orderIds), eq(dueEscalations.mode, 'live'), gte(dueEscalations.dueAt, from)))
          : Promise.resolve([]),
        tx
          .select({ id: alertRatings.id })
          .from(alertRatings)
          .where(
            and(
              eq(alertRatings.userId, args.userId),
              eq(alertRatings.wardId, args.wardId),
              eq(alertRatings.shiftDay, shiftNow(now, args.timezone).day),
              eq(alertRatings.shift, shiftNow(now, args.timezone).shift),
            ),
          ),
      ]);
      return {
        ward,
        timezone: args.timezone,
        serverNow: now.toISOString(),
        stage: config.stage,
        settings: config.settings,
        tcActive: config.tcActive,
        from: from.toISOString(),
        to: to.toISOString(),
        beds: occupancy.map((o) => ({
          bedId: o.bedId,
          label: o.label,
          admissionId: o.admissionId,
          patientName: o.patientName,
          detail: o.admissionId ? [o.age ? `${o.age} y` : null, o.gender?.[0]?.toUpperCase() ?? null].filter(Boolean).join(' ') || null : null,
        })),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- server-only fields dropped
        lines: data.lines.map(({ branchId, wardId, orderingDoctorUserId, ...line }) => line),
        records: data.records,
        snoozes: data.snoozes,
        escalations: escalations.map((e) => ({ id: e.id, orderId: e.orderId, dueAt: e.dueAt.toISOString(), level: e.level, acknowledged: Boolean(e.ackAt) })),
        ratedThisShift: Boolean(rated),
      };
    },
    clinical,
  );
}

/** "1 due", "1 overdue" on the ward's bed tiles; red once a time-critical dose is escalated. */
export async function wardBadges(args: { hospitalId: string; wardId: string; userId: string; timezone: string; now?: Date }) {
  const now = args.now ?? new Date();
  const board = await getWardBoard({ ...args, now });
  const badges = new Map<string, { due: number; overdue: number; escalated: boolean }>();
  for (const { line, instance } of boardInstances(board, now)) {
    const b = badges.get(line.admissionId) ?? { due: 0, overdue: 0, escalated: false };
    if (instance.status === 'due_now') b.due += 1;
    if (instance.status === 'overdue' && instance.dueAt.getTime() > now.getTime() - 12 * HOUR) b.overdue += 1;
    if (line.timeCritical && instance.escalation > 0) b.escalated = true;
    badges.set(line.admissionId, b);
  }
  return badges;
}

/* ============================================================ the actions */

/** Puts off a time-critical alert: a reason, at most 30 minutes, at most twice per dose. */
export async function snoozeDue(args: { hospitalId: string; orderId: string; dueAt: Date; minutes: number; reason: string; actorUserId: string; now?: Date }) {
  const now = args.now ?? new Date();
  const reason = args.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason.length < 2) throw new MarError('Write why the alert is put off');
  if (!Number.isInteger(args.minutes) || args.minutes < 5 || args.minutes > SNOOZE_MAX_MIN) throw new MarError(`Snooze for 5 to ${SNOOZE_MAX_MIN} minutes`);
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [order] = await tx
        .select({ id: treatmentOrders.id, timeCritical: medicines.timeCritical })
        .from(treatmentOrders)
        .leftJoin(medicines, eq(medicines.id, treatmentOrders.medicineId))
        .where(eq(treatmentOrders.id, args.orderId))
        .for('update', { of: treatmentOrders });
      if (!order) throw new MarError('Treatment line not found');
      if (!order.timeCritical) throw new MarError('Only a time-critical dose alerts; nothing to snooze');
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(dueSnoozes)
        .where(and(eq(dueSnoozes.orderId, args.orderId), eq(dueSnoozes.dueAt, args.dueAt)));
      if (n >= SNOOZES_PER_DOSE) throw new MarError('This dose was already put off twice');
      await tx.insert(dueSnoozes).values({
        hospitalId: args.hospitalId,
        orderId: args.orderId,
        dueAt: args.dueAt,
        snoozedByUserId: args.actorUserId,
        reason,
        snoozedAt: now,
        until: new Date(now.getTime() + args.minutes * MIN),
      });
    },
    clinical,
  );
}

export async function acknowledgeEscalation(args: { hospitalId: string; escalationId: string; actorUserId: string }) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const updated = await tx
        .update(dueEscalations)
        .set({ acknowledgedAt: new Date(), acknowledgedByUserId: args.actorUserId })
        .where(and(eq(dueEscalations.id, args.escalationId), eq(dueEscalations.mode, 'live'), isNull(dueEscalations.acknowledgedAt)))
        .returning({ id: dueEscalations.id });
      if (updated.length === 0) throw new MarError('Already acknowledged');
    },
    clinical,
  );
}

/** The nurse's once-a-shift view of alert volume (alert-fatigue control, §7.10). */
export async function rateAlerts(args: { hospitalId: string; wardId: string; userId: string; rating: string; timezone: string; now?: Date }) {
  if (!['too_many', 'about_right', 'too_few'].includes(args.rating)) throw new MarError('Choose one');
  const shift = shiftNow(args.now ?? new Date(), args.timezone);
  await withTenant(args.hospitalId, (tx) =>
    tx
      .insert(alertRatings)
      .values({
        hospitalId: args.hospitalId,
        wardId: args.wardId,
        userId: args.userId,
        shiftDay: shift.day,
        shift: shift.shift,
        rating: args.rating as 'too_many' | 'about_right' | 'too_few',
      })
      .onConflictDoNothing(),
  );
}

/**
 * Live, unacknowledged escalations for this person, by ward, without
 * patient or drug (no PHI in a banner): level 1 to the ward's in-charge (and
 * the owner, and tablets of that ward when no in-charge is set), level 2 to
 * the doctor it names.
 */
export async function myEscalations(args: {
  hospitalId: string;
  userId: string;
  isOwner: boolean;
  /** A ward tablet's wards ('all' for a tablet of every ward); null for a personal login. */
  wardIds: readonly string[] | 'all' | null;
}) {
  const rows = await withTenant(
    args.hospitalId,
    (tx) =>
      tx
        .select({ wardId: dueEscalations.wardId, wardName: wards.name, level: dueEscalations.level, n: sql<number>`count(*)::int` })
        .from(dueEscalations)
        .leftJoin(wards, eq(wards.id, dueEscalations.wardId))
        .where(
          and(
            eq(dueEscalations.mode, 'live'),
            isNull(dueEscalations.acknowledgedAt),
            gte(dueEscalations.raisedAt, new Date(Date.now() - 24 * HOUR)),
            // A dose recorded since (given or not, with its reason) closes the alert.
            sql`not exists (select 1 from mar_administrations m where m.order_id = ${dueEscalations.orderId}
              and m.due_at = ${dueEscalations.dueAt} and m.voided_at is null)`,
            or(
              eq(dueEscalations.targetUserId, args.userId),
              args.isOwner ? eq(dueEscalations.level, 1) : undefined,
              args.wardIds === 'all'
                ? eq(dueEscalations.target, 'ward')
                : args.wardIds && args.wardIds.length > 0
                  ? and(eq(dueEscalations.target, 'ward'), inArray(dueEscalations.wardId, [...args.wardIds]))
                  : undefined,
            ),
          ),
        )
        .groupBy(dueEscalations.wardId, wards.name, dueEscalations.level),
    clinical,
  );
  return rows.map((r) => ({ wardId: r.wardId, wardName: r.wardName ?? 'a ward', level: r.level, count: r.n }));
}

/* ================================================================= sweeps */

/**
 * The escalation sweep (every tick): for each hospital with the treatment
 * card on, every live time-critical line of a patient in a bed, its overdue
 * doses past the window end + L1 / L2 minutes. Observe: counted only. Warn:
 * level 1 live (level 2 counted). Enforce: both live. One row per dose and
 * level; the ward's in-charge (or the ward) for L1, the doctor on call (or
 * the ordering doctor) for L2.
 */
export async function sweepDueEscalations(now: Date = new Date()): Promise<{ live: number; observed: number }> {
  const db = getAdminDb() as unknown as Db;
  const features = await db
    .select({ hospitalId: hospitalFeatures.hospitalId, state: hospitalFeatures.state, stage: hospitalFeatures.stage, rolloutScope: hospitalFeatures.rolloutScope, settings: hospitalFeatures.settings })
    .from(hospitalFeatures)
    .where(and(eq(hospitalFeatures.moduleId, 'mar'), eq(hospitalFeatures.state, 'on')));
  let live = 0;
  let observed = 0;
  for (const feature of features) {
    try {
      const settings = marSettingsFrom(feature.settings);
      const signoff = await signoffStatusInTx(db, feature.hospitalId, settings);
      if (!signoff.current || signoff.count === 0) continue;
      const states = resolveModuleStates([{ moduleId: 'mar', state: feature.state, stage: feature.stage, rolloutScope: feature.rolloutScope, settings: feature.settings }]);

      const stays = await db
        .select({ admissionId: admissions.id, wardId: beds.wardId, inCharge: wards.inChargeUserId })
        .from(admissions)
        .innerJoin(bedAssignments, and(eq(bedAssignments.admissionId, admissions.id), isNull(bedAssignments.toAt)))
        .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
        .innerJoin(wards, eq(wards.id, beds.wardId))
        .where(and(eq(admissions.hospitalId, feature.hospitalId), inArray(admissions.status, ['admitted', 'discharge_ready'])));
      const inScope = stays.filter((s) => moduleAllows(states, 'mar', 'write', s.wardId));
      if (inScope.length === 0) continue;
      const stayOf = new Map(inScope.map((s) => [s.admissionId, s]));

      const from = new Date(now.getTime() - 24 * HOUR);
      const data = await loadDueData(db, { admissionIds: [...stayOf.keys()], from, to: now, settings, tcActive: true, onlyTimeCritical: true });
      if (data.lines.length === 0) continue;
      const payload = {
        timezone: (await db.select({ tz: hospitals.timezone }).from(hospitals).where(eq(hospitals.id, feature.hospitalId)))[0]?.tz ?? 'Asia/Kolkata',
        from: from.toISOString(),
        to: now.toISOString(),
        settings,
        lines: data.lines,
        records: data.records,
        snoozes: data.snoozes,
      } as unknown as BoardPayload;

      const onCall = await db
        .select({ branchId: onCallAssignments.branchId, userId: doctors.userId })
        .from(onCallAssignments)
        .innerJoin(doctors, eq(doctors.id, onCallAssignments.doctorId))
        .where(and(eq(onCallAssignments.hospitalId, feature.hospitalId), isNull(onCallAssignments.cancelledAt), lte(onCallAssignments.startsAt, now), gt(onCallAssignments.endsAt, now)));
      const onCallOf = new Map(onCall.filter((o) => o.userId).map((o) => [o.branchId, o.userId!]));

      for (const { line, instance } of boardInstances(payload, now)) {
        if (instance.escalation === 0) continue;
        const loaded = data.lines.find((l) => l.orderId === line.orderId)!;
        const stay = stayOf.get(line.admissionId)!;
        for (const level of [1, 2] as const) {
          if (instance.escalation < level) continue;
          const isLive = level === 1 ? feature.stage !== 'observe' : feature.stage === 'enforce';
          const target =
            level === 1
              ? { target: stay.inCharge ? ('ward_in_charge' as const) : ('ward' as const), userId: stay.inCharge }
              : onCallOf.get(loaded.branchId)
                ? { target: 'on_call' as const, userId: onCallOf.get(loaded.branchId)! }
                : { target: 'ordering_doctor' as const, userId: loaded.orderingDoctorUserId };
          const inserted = await db
            .insert(dueEscalations)
            .values({
              hospitalId: feature.hospitalId,
              branchId: loaded.branchId,
              admissionId: line.admissionId,
              wardId: stay.wardId,
              orderId: line.orderId,
              dueAt: instance.dueAt,
              level,
              mode: isLive ? 'live' : 'observe',
              target: target.target,
              targetUserId: target.userId,
              raisedAt: now,
            })
            .onConflictDoNothing()
            .returning({ id: dueEscalations.id });
          if (inserted.length > 0) {
            if (isLive) live += 1;
            else observed += 1;
          }
        }
      }
    } catch (error) {
      console.error('[due] escalation sweep failed for a hospital', feature.hospitalId, error);
    }
  }
  return { live, observed };
}

/**
 * The quality figures (§7.10 dashboard): per ward and chart day, due doses
 * and how they went, split time-critical or not, from the same engine. The
 * worker refreshes yesterday and today once an hour; pages read only these.
 */
export async function computeDueRollups(now: Date = new Date(), options: { hospitalId?: string } = {}): Promise<number> {
  const db = getAdminDb() as unknown as Db;
  const features = await db
    .select({ hospitalId: hospitalFeatures.hospitalId, settings: hospitalFeatures.settings, timezone: hospitals.timezone })
    .from(hospitalFeatures)
    .innerJoin(hospitals, eq(hospitals.id, hospitalFeatures.hospitalId))
    .where(and(eq(hospitalFeatures.moduleId, 'mar'), eq(hospitalFeatures.state, 'on'), options.hospitalId ? eq(hospitalFeatures.hospitalId, options.hospitalId) : undefined));
  let written = 0;
  for (const feature of features) {
    try {
      const settings = marSettingsFrom(feature.settings);
      const signoff = await signoffStatusInTx(db, feature.hospitalId, settings);
      const today = chartDayOf(now, feature.timezone);
      const yesterday = chartDayOf(new Date(now.getTime() - 24 * HOUR), feature.timezone);
      for (const day of [yesterday, today]) {
        const window = chartDayWindow(day, feature.timezone);
        const to = window.to < now ? window.to : now;
        // Every stay that had a bed in a ward during the day, with the ward it was in.
        const stays = await db
          .selectDistinctOn([bedAssignments.admissionId], { admissionId: bedAssignments.admissionId, wardId: beds.wardId })
          .from(bedAssignments)
          .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
          .innerJoin(admissions, eq(admissions.id, bedAssignments.admissionId))
          .where(
            and(
              eq(admissions.hospitalId, feature.hospitalId),
              lt(bedAssignments.fromAt, to),
              or(isNull(bedAssignments.toAt), gt(bedAssignments.toAt, window.from)),
            ),
          )
          .orderBy(bedAssignments.admissionId, desc(bedAssignments.fromAt));
        if (stays.length === 0) continue;
        const wardOf = new Map(stays.map((s) => [s.admissionId, s.wardId]));
        const data = await loadDueData(db, { admissionIds: [...wardOf.keys()], from: window.from, to, settings, tcActive: signoff.current });
        const payload = { timezone: feature.timezone, from: window.from.toISOString(), to: to.toISOString(), settings, lines: data.lines, records: data.records, snoozes: data.snoozes } as unknown as BoardPayload;
        const escalations = await db
          .select({ wardId: dueEscalations.wardId, mode: dueEscalations.mode, n: sql<number>`count(distinct (${dueEscalations.orderId}, ${dueEscalations.dueAt}))::int` })
          .from(dueEscalations)
          .where(and(eq(dueEscalations.hospitalId, feature.hospitalId), gte(dueEscalations.dueAt, window.from), lt(dueEscalations.dueAt, to)))
          .groupBy(dueEscalations.wardId, dueEscalations.mode);

        type Acc = { due: number; onTime: number; late: number; early: number; notGiven: number; missed: number; delays: number[] };
        const acc = new Map<string, Acc>();
        for (const { line, instance } of boardInstances(payload, now)) {
          if (instance.dueAt >= to || instance.status === 'upcoming' || instance.status === 'due_soon' || instance.status === 'due_now') continue;
          const wardId = wardOf.get(line.admissionId);
          if (!wardId) continue;
          const key = `${wardId}|${line.timeCritical}`;
          const a = acc.get(key) ?? { due: 0, onTime: 0, late: 0, early: 0, notGiven: 0, missed: 0, delays: [] };
          a.due += 1;
          if (instance.status === 'given_on_time') a.onTime += 1;
          if (instance.status === 'given_late') a.late += 1;
          if (instance.status === 'given_early') a.early += 1;
          if (instance.status === 'not_given') a.notGiven += 1;
          if (instance.status === 'overdue') a.missed += 1;
          if (instance.record?.state === 'given') a.delays.push(Math.round((instance.record.occurredAt.getTime() - instance.dueAt.getTime()) / MIN));
          acc.set(key, a);
        }
        for (const [key, a] of acc) {
          const [wardId, tc] = key.split('|');
          const timeCritical = tc === 'true';
          const sorted = [...a.delays].sort((x, y) => x - y);
          const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
          const esc = (mode: 'observe' | 'live') => (timeCritical ? (escalations.find((e) => e.wardId === wardId && e.mode === mode)?.n ?? 0) : 0);
          const values = {
            due: a.due,
            onTime: a.onTime,
            late: a.late,
            early: a.early,
            notGiven: a.notGiven,
            missed: a.missed,
            medianDelayMin: median,
            wouldEscalate: esc('observe') + esc('live'),
            escalated: esc('live'),
            computedAt: now,
          };
          await db
            .insert(dueRollupsDaily)
            .values({ hospitalId: feature.hospitalId, wardId, day, timeCritical, ...values })
            .onConflictDoUpdate({
              target: [dueRollupsDaily.hospitalId, dueRollupsDaily.wardId, dueRollupsDaily.day, dueRollupsDaily.timeCritical],
              set: values,
            });
          written += 1;
        }
      }
    } catch (error) {
      console.error('[due] roll-up failed for a hospital', feature.hospitalId, error);
    }
  }
  return written;
}

/** The quality page: the last two weeks per ward, from the roll-ups, and the shift ratings. */
export async function getDueQuality(hospitalId: string, days = 14, now: Date = new Date()) {
  const since = new Date(now.getTime() - days * 24 * HOUR).toISOString().slice(0, 10);
  return withTenant(hospitalId, async (tx) => {
    const [rollups, ratings] = await Promise.all([
      tx
        .select({
          wardId: dueRollupsDaily.wardId,
          wardName: wards.name,
          timeCritical: dueRollupsDaily.timeCritical,
          due: sql<number>`sum(${dueRollupsDaily.due})::int`,
          onTime: sql<number>`sum(${dueRollupsDaily.onTime})::int`,
          late: sql<number>`sum(${dueRollupsDaily.late})::int`,
          early: sql<number>`sum(${dueRollupsDaily.early})::int`,
          notGiven: sql<number>`sum(${dueRollupsDaily.notGiven})::int`,
          missed: sql<number>`sum(${dueRollupsDaily.missed})::int`,
          medianDelay: sql<number | null>`percentile_disc(0.5) within group (order by ${dueRollupsDaily.medianDelayMin})`,
          wouldEscalate: sql<number>`sum(${dueRollupsDaily.wouldEscalate})::int`,
          escalated: sql<number>`sum(${dueRollupsDaily.escalated})::int`,
        })
        .from(dueRollupsDaily)
        .innerJoin(wards, eq(wards.id, dueRollupsDaily.wardId))
        .where(gte(dueRollupsDaily.day, since))
        .groupBy(dueRollupsDaily.wardId, wards.name, dueRollupsDaily.timeCritical)
        .orderBy(asc(wards.name)),
      tx
        .select({ wardId: alertRatings.wardId, rating: alertRatings.rating, n: sql<number>`count(*)::int` })
        .from(alertRatings)
        .where(gte(alertRatings.shiftDay, since))
        .groupBy(alertRatings.wardId, alertRatings.rating),
    ]);
    return { rollups, ratings };
  });
}

export type AdmissionDue = {
  orderId: string;
  timeCritical: boolean;
  windowBefore: number;
  windowAfter: number;
  instances: { dueAt: string; status: string; overdueMin: number; recorded: boolean; escalation: number; closeToPrevious: boolean }[];
};

/** One stay's due times on a chart day, per line, for the Treatment tab (the same data as the board). */
export async function getAdmissionDue(args: { hospitalId: string; admissionId: string; day: string; timezone: string; now?: Date }): Promise<Map<string, AdmissionDue>> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const config = await configInTx(tx, args.hospitalId);
      const window = chartDayWindow(args.day, args.timezone);
      const data = await loadDueData(tx, { admissionIds: [args.admissionId], from: window.from, to: window.to, settings: config.settings, tcActive: config.tcActive });
      const payload = { timezone: args.timezone, from: window.from.toISOString(), to: window.to.toISOString(), settings: config.settings, lines: data.lines, records: data.records, snoozes: data.snoozes } as unknown as BoardPayload;
      const out = new Map<string, AdmissionDue>();
      for (const line of data.lines) out.set(line.orderId, { orderId: line.orderId, timeCritical: line.timeCritical, windowBefore: line.windowBefore, windowAfter: line.windowAfter, instances: [] });
      for (const { line, instance } of boardInstances(payload, now)) {
        out.get(line.orderId)!.instances.push({
          dueAt: instance.dueAt.toISOString(),
          status: instance.status,
          overdueMin: instance.overdueMin,
          recorded: Boolean(instance.record),
          escalation: instance.escalation,
          closeToPrevious: instance.closeToPrevious,
        });
      }
      return out;
    },
    clinical,
  );
}

/** Wards with their in-charge, for Settings. */
export async function listWardsInCharge(hospitalId: string) {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({ id: wards.id, name: wards.name, inChargeUserId: wards.inChargeUserId })
      .from(wards)
      .where(eq(wards.active, true))
      .orderBy(asc(wards.sortOrder), asc(wards.name)),
  );
}
