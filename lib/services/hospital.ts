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

  const whereConditions = [];
  if (!includeInactive) {
    whereConditions.push(eq(doctors.active, true));
  }
  if (args.branchId) {
    whereConditions.push(eq(doctors.branchId, args.branchId));
  }

  const rawDoctors = await tx
    .select({
      id: doctors.id,
      name: doctors.name,
      specialty: doctors.specialty,
      branchId: doctors.branchId,
      branchName: branches.name,
      defaultConsultMinutes: doctors.defaultConsultMinutes,
      active: doctors.active,
    })
    .from(doctors)
    .innerJoin(branches, eq(branches.id, doctors.branchId))
    .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
    .orderBy(asc(doctors.name));

  if (rawDoctors.length === 0) {
    return [];
  }

  const docIds = rawDoctors.map((d) => d.id);

  // Batch fetch day-states and schedules in parallel — they're independent
  const [dayStates, schedules] = await Promise.all([
    tx
      .select({ doctorId: doctorDayStates.doctorId, mode: doctorDayStates.mode })
      .from(doctorDayStates)
      .where(
        and(
          inArray(doctorDayStates.doctorId, docIds),
          eq(doctorDayStates.serviceDate, serviceDate),
        ),
      ),
    tx
      .select({ doctorId: doctorSchedules.doctorId, mode: doctorSchedules.mode })
      .from(doctorSchedules)
      .where(
        and(
          inArray(doctorSchedules.doctorId, docIds),
          sql`weekday = extract(dow from ${serviceDate}::date)`,
          sql`effective_from <= ${serviceDate}::date`,
          sql`(effective_to is null or effective_to >= ${serviceDate}::date)`,
        ),
      ),
  ]);

  const dayStateMap = new Map(
    dayStates
      .filter((d): d is { doctorId: string; mode: DoctorScheduleMode } => Boolean(d.mode))
      .map((d) => [d.doctorId, d.mode]),
  );
  const schedMap = new Map(schedules.map((s) => [s.doctorId, s.mode]));

  return rawDoctors.map((doc) => ({
    ...doc,
    mode: dayStateMap.get(doc.id) ?? schedMap.get(doc.id) ?? 'queue',
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
