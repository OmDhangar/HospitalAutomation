/**
 * PRN (As-Needed) medication limits and cooldown domain calculator.
 * Enforces inter-dose cooldown, chart day count ceilings, and cumulative substance amount limits across order versions.
 */

export interface PrnOrderConstraints {
  prnMinIntervalHours?: number | null;
  prnMaxDailyDoses?: number | null;
  prnMaxDailyQuantity?: number | null;
  prnMaxDailyUnit?: string | null;
}

export interface AdministrationHistoryEntry {
  actualTime?: Date | null;
  doseAmountNumeric?: number | null;
  voidedAt?: Date | null;
}

export interface PrnEligibilityResult {
  eligible: boolean;
  reason?: string;
  remainingCooldownMinutes?: number;
  currentChartDayDoseCount?: number;
  currentChartDayQuantity?: number;
}

/**
 * Returns the stable transactional concurrency lock key for an order chain.
 */
export function getPrnChainLockKey(orderChainId: string): string {
  return `ipd_prn_chain:${orderChainId}`;
}

/**
 * Computes the Medication Chart Day window [08:00, 08:00 next day] for a given timestamp.
 * Standard Indian nursing shift chart day runs from 08:00 AM to 08:00 AM the following morning.
 */
export function getChartDayWindow(date: Date, timezone: string = 'Asia/Kolkata'): { start: Date; end: Date } {
  // Format local date components in Asia/Kolkata (or target timezone)
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';

  const year = parseInt(getPart('year'), 10);
  const month = parseInt(getPart('month'), 10);
  const day = parseInt(getPart('day'), 10);
  const hour = parseInt(getPart('hour'), 10);

  // If local time is before 08:00, chart day started yesterday at 08:00
  let startYear = year;
  let startMonth = month;
  let startDay = day;

  if (hour < 8) {
    const yesterday = new Date(date);
    yesterday.setDate(yesterday.getDate() - 1);
    const yParts = formatter.formatToParts(yesterday);
    const getYPart = (type: string) => yParts.find((p) => p.type === type)?.value ?? '00';
    startYear = parseInt(getYPart('year'), 10);
    startMonth = parseInt(getYPart('month'), 10);
    startDay = parseInt(getYPart('day'), 10);
  }

  const sm = String(startMonth).padStart(2, '0');
  const sd = String(startDay).padStart(2, '0');

  // Start is 08:00 on startDay
  const start = new Date(`${startYear}-${sm}-${sd}T08:00:00+05:30`);
  // End is exactly 24 hours later
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { start, end };
}

export interface CheckPrnEligibilityArgs {
  order: PrnOrderConstraints;
  history: AdministrationHistoryEntry[];
  requestedAt: Date;
  proposedDoseAmount?: number | null;
  timezone?: string;
}

/**
 * Validates PRN dose eligibility against minimum cooldown interval, daily dose count limit,
 * and daily cumulative substance quantity limit.
 * Excludes voided administrations.
 */
export function checkPrnEligibility(args: CheckPrnEligibilityArgs): PrnEligibilityResult {
  const { order, history, requestedAt, proposedDoseAmount, timezone = 'Asia/Kolkata' } = args;

  // Filter valid, non-voided administrations with an actual administration time
  const validHistory = (history ?? []).filter(
    (h) => h.voidedAt == null && h.actualTime != null,
  );

  // 1. Check Cooldown Interval
  if (order.prnMinIntervalHours != null && order.prnMinIntervalHours > 0) {
    let latestAdminTime: Date | null = null;
    for (const h of validHistory) {
      if (h.actualTime && h.actualTime <= requestedAt) {
        if (!latestAdminTime || h.actualTime > latestAdminTime) {
          latestAdminTime = h.actualTime;
        }
      }
    }

    if (latestAdminTime) {
      const elapsedMs = requestedAt.getTime() - latestAdminTime.getTime();
      const minIntervalMs = order.prnMinIntervalHours * 60 * 60 * 1000;

      if (elapsedMs < minIntervalMs) {
        const remainingMs = minIntervalMs - elapsedMs;
        const remainingCooldownMinutes = Math.ceil(remainingMs / (60 * 1000));
        return {
          eligible: false,
          reason: `Cooldown interval has not elapsed. Minimum spacing is ${order.prnMinIntervalHours}h.`,
          remainingCooldownMinutes,
        };
      }
    }
  }

  // 2. Chart Day Calculations
  const chartDay = getChartDayWindow(requestedAt, timezone);
  const chartDayDoses = validHistory.filter(
    (h) => h.actualTime && h.actualTime >= chartDay.start && h.actualTime < chartDay.end,
  );

  const currentCount = chartDayDoses.length;
  const currentQuantity = chartDayDoses.reduce(
    (sum, d) => sum + (typeof d.doseAmountNumeric === 'number' ? d.doseAmountNumeric : 0),
    0,
  );

  // 3. Daily Dose Count Ceiling
  if (order.prnMaxDailyDoses != null && order.prnMaxDailyDoses > 0) {
    if (currentCount >= order.prnMaxDailyDoses) {
      return {
        eligible: false,
        reason: `Daily limit reached (maximum ${order.prnMaxDailyDoses} doses per chart day).`,
        currentChartDayDoseCount: currentCount,
        currentChartDayQuantity: currentQuantity,
      };
    }
  }

  // 4. Daily Cumulative Substance Quantity Ceiling
  if (order.prnMaxDailyQuantity != null && order.prnMaxDailyQuantity > 0) {
    const proposed = proposedDoseAmount ?? 0;
    if (currentQuantity + proposed > order.prnMaxDailyQuantity) {
      const unit = order.prnMaxDailyUnit ? ` ${order.prnMaxDailyUnit}` : '';
      return {
        eligible: false,
        reason: `Cumulative quantity limit exceeded (maximum ${order.prnMaxDailyQuantity}${unit} per chart day).`,
        currentChartDayDoseCount: currentCount,
        currentChartDayQuantity: currentQuantity,
      };
    }
  }

  return {
    eligible: true,
    currentChartDayDoseCount: currentCount,
    currentChartDayQuantity: currentQuantity,
  };
}
