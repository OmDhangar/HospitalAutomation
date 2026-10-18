import { desc, eq, and, gte } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  vitalsReadings,
  intakeOutput,
} from '@/lib/db/schema';
import { getAdmissionSummary, type AdmissionSummary } from '@/lib/services/ipd-census';
import { getBedsideEmar, type BedsideEmarView } from '@/lib/services/ipd-emar';
import type { DailyMedicationItem, DailyMedSlot } from '@/components/ipd/summary/daily-medication-matrix';
import type { TprReading } from '@/components/ipd/summary/tpr-flowsheet';

export interface FluidBalanceSummary {
  totalInMl: number;
  totalOutMl: number;
  netBalanceMl: number;
  breakdown: {
    oralMl: number;
    ivMl: number;
    urineMl: number;
    drainMl: number;
  };
}

export interface DoctorSummaryCockpitData {
  admission: AdmissionSummary | null;
  medications: DailyMedicationItem[];
  vitals: TprReading[];
  fluidBalance: FluidBalanceSummary;
  attentionItems: {
    key: string;
    label: string;
    tone: 'warning' | 'danger' | 'info';
    actionText?: string;
    actionHref?: string;
  }[];
  recentHistory: any[];
}

export async function getDoctorSummaryCockpitData(args: {
  hospitalId: string;
  admissionId: string;
}): Promise<DoctorSummaryCockpitData> {
  const { hospitalId, admissionId } = args;

  const [admission, emarData] = await Promise.all([
    getAdmissionSummary(hospitalId, admissionId),
    getBedsideEmar({ hospitalId, admissionId }),
  ]);

  // Fetch vitals and intake/output via withTenant
  const { recentVitals, fluidItems } = await withTenant(
    hospitalId,
    async (tx: Tx) => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const vitals = await tx
        .select()
        .from(vitalsReadings)
        .where(
          and(
            eq(vitalsReadings.hospitalId, hospitalId),
            eq(vitalsReadings.admissionId, admissionId),
          ),
        )
        .orderBy(desc(vitalsReadings.recordedAt))
        .limit(8);

      const fluids = await tx
        .select()
        .from(intakeOutput)
        .where(
          and(
            eq(intakeOutput.hospitalId, hospitalId),
            eq(intakeOutput.admissionId, admissionId),
            gte(intakeOutput.recordedAt, yesterday),
          ),
        );

      return { recentVitals: vitals, fluidItems: fluids };
    },
    { clinical: true },
  );

  // 1. Transform active orders into DailyMedicationItem matrix
  const now = new Date();
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const nowMinutesTotal = currentHours * 60 + currentMinutes;

  const administeredOrderSlotMap = new Map<string, { givenAt: string; nurse?: string }>();
  for (const item of emarData.recentHistory) {
    if (item.scheduledTime && !item.voidedAt) {
      const d = new Date(item.scheduledTime);
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const rec = new Date(item.recordedAt);
      const recStr = `${String(rec.getHours()).padStart(2, '0')}:${String(rec.getMinutes()).padStart(2, '0')}`;
      administeredOrderSlotMap.set(`${item.orderId}:${timeStr}`, {
        givenAt: recStr,
        nurse: item.nurseUserId ? 'Staff Nurse' : undefined,
      });
    }
  }

  // Combine dueNow and upcoming to gather active orders
  const allOrdersMap = new Map<string, any>();
  for (const item of [...emarData.overdue, ...emarData.dueNow, ...emarData.upcoming]) {
    if (!allOrdersMap.has(item.orderId)) {
      allOrdersMap.set(item.orderId, item);
    }
  }

  const medications: DailyMedicationItem[] = [];

  allOrdersMap.forEach((item, orderId) => {
    const rawTimes: string[] = Array.isArray(item.scheduleTimes) && item.scheduleTimes.length > 0
      ? item.scheduleTimes
      : ['08:00'];

    const slots: DailyMedSlot[] = rawTimes.map((time) => {
      const [hStr, mStr] = time.split(':');
      const h = parseInt(hStr || '8', 10);
      const m = parseInt(mStr || '0', 10);
      const slotMinutesTotal = h * 60 + m;

      const adminRecord = administeredOrderSlotMap.get(`${orderId}:${time}`);
      if (adminRecord) {
        return {
          time,
          status: 'GIVEN',
          givenAt: adminRecord.givenAt,
          nurseName: adminRecord.nurse,
        };
      }

      // If past scheduled slot by more than 60 mins without admin
      if (nowMinutesTotal > slotMinutesTotal + 60) {
        return {
          time,
          status: 'OVERDUE',
        };
      }

      return {
        time,
        status: 'DUE',
      };
    });

    medications.push({
      orderId,
      medicineName: item.medicineName,
      strength: item.strength,
      form: item.form,
      route: item.route,
      frequency: item.frequencyCode,
      specialInstructions: item.specialInstructions,
      slots,
    });
  });

  // 2. Transform vitals readings
  const formattedVitals: TprReading[] = recentVitals.map((v) => {
    const d = new Date(v.recordedAt);
    const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    const bpStr = v.bpSystolic && v.bpDiastolic ? `${v.bpSystolic}/${v.bpDiastolic}` : null;

    return {
      time: `${dateStr} ${timeStr}`,
      tempF: v.temperatureF ? String(v.temperatureF) : null,
      pulse: v.pulseBpm,
      bp: bpStr,
      resp: v.respiratoryRate,
      spo2: v.spo2Percent,
      news2: v.news2Score,
      pain: v.painScore,
    };
  });

  // 3. Calculate 24h Fluid Balance
  let oralMl = 0;
  let ivMl = 0;
  let urineMl = 0;
  let drainMl = 0;

  for (const f of fluidItems) {
    if (f.kind === 'ORAL') oralMl += f.ml;
    else if (f.kind === 'IV') ivMl += f.ml;
    else if (f.kind === 'URINE') urineMl += f.ml;
    else if (f.kind === 'DRAIN') drainMl += f.ml;
  }

  const totalInMl = oralMl + ivMl;
  const totalOutMl = urineMl + drainMl;
  const netBalanceMl = totalInMl - totalOutMl;

  // 4. Clinical attention alerts
  const attentionItems: DoctorSummaryCockpitData['attentionItems'] = [];

  if (emarData.overdue.length > 0) {
    attentionItems.push({
      key: 'overdue_meds',
      label: `${emarData.overdue.length} overdue medication doses require nurse action`,
      tone: 'danger',
      actionText: 'Open eMAR →',
      actionHref: `/ipd/patients/${admissionId}/emar`,
    });
  }

  if (recentVitals.length === 0) {
    attentionItems.push({
      key: 'missing_vitals',
      label: 'No vitals recorded today. Nurse routine check needed.',
      tone: 'warning',
      actionText: 'Record Vitals →',
      actionHref: `/ipd/patients/${admissionId}/vitals`,
    });
  }

  return {
    admission,
    medications,
    vitals: formattedVitals,
    fluidBalance: {
      totalInMl,
      totalOutMl,
      netBalanceMl,
      breakdown: { oralMl, ivMl, urineMl, drainMl },
    },
    attentionItems,
    recentHistory: emarData.recentHistory,
  };
}
