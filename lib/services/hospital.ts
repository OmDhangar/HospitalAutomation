import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  branches,
  doctorDayStates,
  doctors,
  doctorSchedules,
  hospitals,
  staffMemberships,
} from '@/lib/db/schema';
import type { DoctorScheduleMode } from '@/lib/domain/booking';
import { effectiveMode, toDaySessions, type SessionConfig } from '@/lib/domain/sessions';
import { assertCanAdd } from './entitlements';

export type DoctorListItem = {
  id: string;
  name: string;
  specialty: string | null;
  branchId: string;
  branchName: string;
  userId: string | null;
  defaultConsultMinutes: number;
  mode: DoctorScheduleMode;
  active: boolean;
  /** Daily token quota; null when the doctor runs without one. */
  dailyTokenQuota: number | null;
  walkInReserved: number;
  onlineOpensMinutesBefore: number;
  walkInReleaseMinutes: number | null;
};

// In-memory cache for doctor lists per hospital (60s TTL)
type CacheEntry = { data: DoctorListItem[]; expiresAt: number };
const doctorCache = new Map<string, CacheEntry>();

export function clearDoctorCache(hospitalId?: string) {
  if (hospitalId) {
    doctorCache.delete(hospitalId);
  } else {
    doctorCache.clear();
  }
}

export async function listDoctorsInTx(
  tx: Tx,
  args: {
    branchId?: string | null;
    serviceDate?: string;
    includeInactive?: boolean;
  },
): Promise<DoctorListItem[]> {
  const serviceDate = args.serviceDate ?? new Date().toISOString().slice(0, 10);
  const includeInactive = args.includeInactive ?? false;

  const branchFilter = args.branchId ? sql`and d.branch_id = ${args.branchId}::uuid` : sql``;
  const activeFilter = !includeInactive ? sql`and d.active = true` : sql``;

  const rows = await tx.execute<{
    id: string;
    name: string;
    specialty: string | null;
    branch_id: string;
    branch_name: string;
    user_id: string | null;
    default_consult_minutes: number;
    active: boolean;
    mode: DoctorScheduleMode;
    daily_token_quota: number | null;
    walk_in_reserved: number;
    online_opens_minutes_before: number;
    walk_in_release_minutes: number | null;
    timezone: string | null;
    day_mode: DoctorScheduleMode | null;
    sessions: Array<{ mode: SessionConfig['mode']; start: string; end: string; slot: number }> | null;
  }>(sql`
    select 
      d.id,
      d.name,
      d.specialty,
      d.branch_id,
      b.name as branch_name,
      d.user_id,
      d.default_consult_minutes,
      d.active,
      d.daily_token_quota,
      d.walk_in_reserved,
      d.online_opens_minutes_before,
      d.walk_in_release_minutes,
      h.timezone,
      dds.mode::text as day_mode,
      ds.sessions,
      coalesce(
        dds.mode,
        ds.first_mode,
        'queue'
      )::text as mode
    from doctors d
    inner join branches b on b.id = d.branch_id
    inner join hospitals h on h.id = d.hospital_id
    left join doctor_day_states dds on dds.doctor_id = d.id and dds.service_date = ${serviceDate}
    left join lateral (
      -- Every session of the day: a split day (queue, then slots) answers
      -- "queue or slot?" differently before and after its queue closes.
      select
        (array_agg(s.mode order by s.start_time))[1] as first_mode,
        json_agg(json_build_object(
          'mode', s.mode, 'start', s.start_time, 'end', s.end_time, 'slot', s.slot_minutes
        ) order by s.start_time) as sessions
      from doctor_schedules s
      where s.doctor_id = d.id
        and s.weekday = extract(dow from ${serviceDate}::date)
        and s.effective_from <= ${serviceDate}::date
        and (s.effective_to is null or s.effective_to >= ${serviceDate}::date)
    ) ds on true
    where 1=1 ${activeFilter} ${branchFilter}
    order by d.name asc
  `);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    specialty: r.specialty,
    branchId: r.branch_id,
    branchName: r.branch_name,
    userId: r.user_id ?? null,
    defaultConsultMinutes: r.default_consult_minutes,
    active: r.active,
    mode: modeNow(r, serviceDate),
    dailyTokenQuota: r.daily_token_quota,
    walkInReserved: r.walk_in_reserved ?? 0,
    onlineOpensMinutesBefore: r.online_opens_minutes_before ?? 120,
    walkInReleaseMinutes: r.walk_in_release_minutes,
  }));
}

/**
 * What a patient can book with this doctor right now. A single-session day is
 * its mode, as it always was; a split day offers the queue and slots until its
 * live queue closes, then slots only. A day-level override still wins.
 */
function modeNow(
  r: {
    mode: DoctorScheduleMode | null;
    timezone: string | null;
    day_mode: DoctorScheduleMode | null;
    sessions: Array<{ mode: SessionConfig['mode']; start: string; end: string; slot: number }> | null;
  },
  serviceDate: string,
): DoctorScheduleMode {
  const fallback = r.mode ?? 'queue';
  if (r.day_mode || !r.sessions || r.sessions.length < 2) return fallback;
  const sessions = toDaySessions(
    r.sessions.map((x) => ({ mode: x.mode, startTime: x.start, endTime: x.end, slotMinutes: x.slot })),
    serviceDate,
    r.timezone ?? 'Asia/Kolkata',
  );
  return effectiveMode(sessions, new Date()) ?? fallback;
}

export async function listDoctors(args: {
  hospitalId: string;
  branchId?: string | null;
  serviceDate?: string;
  includeInactive?: boolean;
}): Promise<DoctorListItem[]> {
  const serviceDate = args.serviceDate ?? new Date().toISOString().slice(0, 10);
  const includeInactive = args.includeInactive ?? false;
  const cacheKey = `${args.hospitalId}:${args.branchId ?? 'all'}:${serviceDate}:${includeInactive}`;
  const cached = doctorCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const result = await withTenant(args.hospitalId, (tx) =>
    listDoctorsInTx(tx, args),
  );

  doctorCache.set(cacheKey, { data: result, expiresAt: Date.now() + 60_000 });
  return result;
}

export async function getHospital(hospitalId: string) {
  return withTenant(hospitalId, async (tx) => {
    const [row] = await tx.select().from(hospitals).where(eq(hospitals.id, hospitalId));
    return row ?? null;
  });
}

export async function createBranch(args: {
  hospitalId: string;
  name: string;
  address?: string;
}) {
  await assertCanAdd({ hospitalId: args.hospitalId, kind: 'branches' });

  const result = await withTenant(args.hospitalId, async (tx) => {
    const [row] = await tx
      .insert(branches)
      .values({ hospitalId: args.hospitalId, name: args.name, address: args.address })
      .returning();
    return row;
  });
  clearDoctorCache(args.hospitalId);
  return result;
}

export async function createDoctor(args: {
  hospitalId: string;
  branchId: string;
  name: string;
  specialty?: string;
  defaultConsultMinutes?: number;
  mode?: DoctorScheduleMode;
}) {
  await assertCanAdd({ hospitalId: args.hospitalId, kind: 'doctors' });

  const result = await withTenant(args.hospitalId, async (tx) => {
    const [row] = await tx
      .insert(doctors)
      .values({
        hospitalId: args.hospitalId,
        branchId: args.branchId,
        name: args.name,
        specialty: args.specialty,
        defaultConsultMinutes: args.defaultConsultMinutes ?? 10,
      })
      .returning();

    if (args.mode) {
      const today = new Date().toISOString().slice(0, 10);
      const dow = new Date().getDay();
      await tx.insert(doctorSchedules).values({
        hospitalId: args.hospitalId,
        doctorId: row.id,
        weekday: dow,
        mode: args.mode,
        startTime: '09:00',
        endTime: '17:00',
        effectiveFrom: today,
      });
    }

    return row;
  });
  clearDoctorCache(args.hospitalId);
  return result;
}

export async function updateWhatsAppSettings(args: {
  hospitalId: string;
  ownerPhoneE164: string | null;
}) {
  return withTenant(args.hospitalId, (tx) =>
    tx
      .update(hospitals)
      .set({ ownerPhoneE164: args.ownerPhoneE164, updatedAt: new Date() })
      .where(eq(hospitals.id, args.hospitalId)),
  );
}

/**
 * Links a doctor profile to the login that belongs to that doctor.
 *
 * This is how the system knows who wrote a prescription, and it is the check
 * that lets a doctor write their own patients' consultations and nobody
 * else's. Null unlinks. The login must belong to this hospital — read under
 * row-level security — and a unique index stops one login being two doctors.
 */
export async function setDoctorUser(args: {
  hospitalId: string;
  doctorId: string;
  userId: string | null;
}) {
  await withTenant(args.hospitalId, async (tx) => {
    if (args.userId) {
      const [member] = await tx
        .select({ id: staffMemberships.id })
        .from(staffMemberships)
        .where(
          and(
            eq(staffMemberships.userId, args.userId),
            eq(staffMemberships.hospitalId, args.hospitalId),
            eq(staffMemberships.active, true),
          ),
        );
      if (!member) throw new Error('That login is not an active member of this hospital');

      const [taken] = await tx
        .select({ name: doctors.name })
        .from(doctors)
        .where(and(eq(doctors.userId, args.userId), sql`${doctors.id} <> ${args.doctorId}`));
      if (taken) throw new Error(`That login is already linked to ${taken.name}`);
    }

    const [updated] = await tx
      .update(doctors)
      .set({ userId: args.userId })
      .where(eq(doctors.id, args.doctorId))
      .returning({ id: doctors.id });
    if (!updated) throw new Error('Doctor not found');
  });
  clearDoctorCache(args.hospitalId);
}

export async function setDoctorActive(args: {
  hospitalId: string;
  doctorId: string;
  active: boolean;
}) {
  const result = await withTenant(args.hospitalId, (tx) =>
    tx.update(doctors).set({ active: args.active }).where(eq(doctors.id, args.doctorId)),
  );
  clearDoctorCache(args.hospitalId);
  return result;
}
