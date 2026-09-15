import { withTenant } from '@/lib/db';
import { listBranchesInTx } from '@/lib/services/auth';
import { listDoctorsInTx, type DoctorListItem } from '@/lib/services/hospital';
import { getQueueSnapshotInTx, type QueueSnapshot } from '@/lib/services/queue';
import { getCurrentSubscriptionInTx, listActiveTiers, type Tier } from '@/lib/services/subscriptions';
import { getHospitalUsageInTx, type HospitalUsage } from '@/lib/services/usage';
import { serviceDateIn } from '@/lib/domain/time';

export type DashboardData = {
  branches: { id: string; name: string }[];
  doctors: DoctorListItem[];
  snapshot: QueueSnapshot | null;
  usage: HospitalUsage | null;
  tiers: Tier[];
};


let requestCounter = 0;

/**
 * Loads all data the dashboard page needs in a **single** withTenant
 * transaction, with independent queries running in parallel.
 *
 * Before this, the page opened 6–7 separate transactions sequentially,
 * each with its own BEGIN / set_config / COMMIT overhead. This collapses
 * them into one transaction with ~14 queries parallelized where possible.
 */
export async function loadDashboardData(args: {
  hospitalId: string;
  branchId: string | null;
  selectedDoctorId: string | null;
  timezone: string;
  isOwner: boolean;
  now?: Date;
  requestId?: string;
}): Promise<DashboardData> {
  const reqId = args.requestId ?? `dash_${Date.now().toString(36)}_${++requestCounter}`;
  const tStart = performance.now();
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  console.log(`[PERF:dashboard] req=${reqId} START loader at ${now.toISOString()} (hospitalId=${args.hospitalId})`);

  // Tier list is on a separate admin DB, so it stays outside the tenant TX
  const tiersPromise = args.isOwner
    ? (async () => {
        const s = performance.now();
        const res = await listActiveTiers();
        const duration = performance.now() - s;
        console.log(`[PERF:dashboard] req=${reqId} fetchTiers: ${duration.toFixed(1)}ms`);
        return { data: res, duration };
      })()
    : Promise.resolve({ data: [] as Tier[], duration: 0 });

  const tenantData = await withTenant(args.hospitalId, async (tx) => {
    const t0 = performance.now();
    // Phase 1: branches + doctors + subscription — all independent
    const [
      { data: branches, duration: tBranches },
      { data: doctors, duration: tDoctors },
      { data: subscription, duration: tSub },
    ] = await Promise.all([
      (async () => {
        const s = performance.now();
        const res = await listBranchesInTx(tx);
        const duration = performance.now() - s;
        console.log(`[PERF:dashboard] req=${reqId} fetchBranches: ${duration.toFixed(1)}ms`);
        return { data: res, duration };
      })(),
      (async () => {
        const s = performance.now();
        const res = await listDoctorsInTx(tx, {
          branchId: args.branchId,
          serviceDate,
        });
        const duration = performance.now() - s;
        console.log(`[PERF:dashboard] req=${reqId} fetchDoctors: ${duration.toFixed(1)}ms`);
        return { data: res, duration };
      })(),
      (async () => {
        const s = performance.now();
        const res = args.isOwner ? await getCurrentSubscriptionInTx(tx, args.hospitalId) : null;
        const duration = performance.now() - s;
        console.log(`[PERF:dashboard] req=${reqId} fetchSubscription: ${duration.toFixed(1)}ms`);
        return { data: res, duration };
      })(),
    ]);
    const tPhase1 = performance.now();

    // Phase 2: snapshot + usage — can run in parallel, both depend on Phase 1
    //          only for the selectedDoctorId (which we already have from args)
    const selectedId = args.selectedDoctorId ?? doctors[0]?.id ?? null;

    const [
      { data: snapshot, duration: tSnapshot },
      { data: usage, duration: tUsage },
    ] = await Promise.all([
      (async () => {
        if (!selectedId) return { data: null, duration: 0 };
        const s = performance.now();
        const res = await getQueueSnapshotInTx(tx, {
          doctorId: selectedId,
          serviceDate,
          now,
        });
        const duration = performance.now() - s;
        console.log(`[PERF:dashboard] req=${reqId} fetchSnapshot: ${duration.toFixed(1)}ms`);
        return { data: res, duration };
      })(),
      (async () => {
        if (!args.isOwner || !subscription) return { data: null, duration: 0 };
        const s = performance.now();
        const res = await getHospitalUsageInTx(tx, { timezone: args.timezone, now, subscription });
        const duration = performance.now() - s;
        console.log(`[PERF:dashboard] req=${reqId} fetchUsage: ${duration.toFixed(1)}ms`);
        return { data: res, duration };
      })(),
    ]);
    const tPhase2 = performance.now();

    console.log(
      `[PERF:dashboard:inTx] req=${reqId} ` +
      `Phase1(branches=${tBranches.toFixed(1)}ms, docs=${tDoctors.toFixed(1)}ms, sub=${tSub.toFixed(1)}ms -> wall=${(tPhase1 - t0).toFixed(1)}ms) | ` +
      `Phase2(snapshot=${tSnapshot.toFixed(1)}ms, usage=${tUsage.toFixed(1)}ms -> wall=${(tPhase2 - tPhase1).toFixed(1)}ms) | ` +
      `totalInTx: ${(tPhase2 - t0).toFixed(1)}ms`
    );

    return { branches, doctors, snapshot, usage };
  });

  const tBeforeTiers = performance.now();
  const tiersResult = await tiersPromise;
  const tEnd = performance.now();

  console.log(
    `[PERF:dashboard] req=${reqId} withTenant: ${(tBeforeTiers - tStart).toFixed(1)}ms | ` +
    `tiers: ${(tEnd - tBeforeTiers).toFixed(1)}ms (fetch: ${tiersResult.duration.toFixed(1)}ms) | ` +
    `totalLoader: ${(tEnd - tStart).toFixed(1)}ms`
  );

  return {
    ...tenantData,
    tiers: tiersResult.data,
  };
}
