import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { branches, doctorDayStates, doctors, doctorSchedules, hospitals } from '@/lib/db/schema';
import type { DoctorScheduleMode } from '@/lib/domain/booking';

export type DoctorListItem = {
  id: string;
  name: string;
  specialty: string | null;
  branchId: string;
  branchName: string;
  defaultConsultMinutes: number;
  mode: DoctorScheduleMode;
  active: boolean;
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
    default_consult_minutes: number;
    active: boolean;
    mode: DoctorScheduleMode;
  }>(sql`
    select 
      d.id,
      d.name,
      d.specialty,
      d.branch_id,
      b.name as branch_name,
      d.default_consult_minutes,
      d.active,
      coalesce(
        dds.mode,
        ds.mode,
        'queue'
      )::text as mode
    from doctors d
    inner join branches b on b.id = d.branch_id
    left join doctor_day_states dds on dds.doctor_id = d.id and dds.service_date = ${serviceDate}
    left join lateral (
      select s.mode
      from doctor_schedules s
      where s.doctor_id = d.id
        and s.weekday = extract(dow from ${serviceDate}::date)
        and s.effective_from <= ${serviceDate}::date
        and (s.effective_to is null or s.effective_to >= ${serviceDate}::date)
      order by s.created_at desc
      limit 1
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
    defaultConsultMinutes: r.default_consult_minutes,
    active: r.active,
    mode: r.mode ?? 'queue',
  }));
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
