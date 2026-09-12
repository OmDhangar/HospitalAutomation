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
}): Promise<DashboardData> {
  const tStart = performance.now();
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  // Tier list is on a separate admin DB, so it stays outside the tenant TX
  const tiersPromise = args.isOwner ? listActiveTiers() : Promise.resolve([]);

  const tenantData = await withTenant(args.hospitalId, async (tx) => {
    const t0 = performance.now();
    // Phase 1: branches + doctors + subscription — all independent
    const [branches, doctors, subscription] = await Promise.all([
      listBranchesInTx(tx),
      listDoctorsInTx(tx, {
        branchId: args.branchId,
        serviceDate,
      }),
      args.isOwner ? getCurrentSubscriptionInTx(tx, args.hospitalId) : null,
    ]);
    const tPhase1 = performance.now();

    // Phase 2: snapshot + usage — can run in parallel, both depend on Phase 1
    //          only for the selectedDoctorId (which we already have from args)
    const selectedId = args.selectedDoctorId ?? doctors[0]?.id ?? null;

    const [snapshot, usage] = await Promise.all([
      selectedId
        ? getQueueSnapshotInTx(tx, {
            doctorId: selectedId,
            serviceDate,
            now,
          })
        : null,
      args.isOwner && subscription
        ? getHospitalUsageInTx(tx, { timezone: args.timezone, now, subscription })
        : null,
    ]);
    const tPhase2 = performance.now();

    console.log(
      `[PERF:loadDashboardData:inTx] Phase1(branches+docs+sub): ${(tPhase1 - t0).toFixed(1)}ms | ` +
      `Phase2(snapshot+usage): ${(tPhase2 - tPhase1).toFixed(1)}ms | ` +
      `totalInTx: ${(tPhase2 - t0).toFixed(1)}ms`
    );

    return { branches, doctors, snapshot, usage };
  });

  const tBeforeTiers = performance.now();
  const tiers = await tiersPromise;
  const tEnd = performance.now();

  console.log(
    `[PERF:loadDashboardData] withTenant: ${(tBeforeTiers - tStart).toFixed(1)}ms | ` +
    `tiers: ${(tEnd - tBeforeTiers).toFixed(1)}ms | ` +
    `totalLoader: ${(tEnd - tStart).toFixed(1)}ms`
  );

  return {
    ...tenantData,
    tiers,
  };
}
