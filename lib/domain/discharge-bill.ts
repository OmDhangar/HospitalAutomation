import { DUPLICATE_WINDOW_MS, isLateRecording } from './care-entry';
import { serviceDateIn } from './time';

/**
 * Discharge billing, as pure rules (IPD plan §T2.1–T2.4).
 */

/** The Indian financial year an instant falls in, in the hospital's timezone: "2026-27". */
export function fiscalYearOf(at: Date, timezone: string): string {
  const [year, month] = serviceDateIn(timezone, at).split('-').map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** "IPD/2026-27/0007": readable, sortable, restarting each financial year. */
export const formatBillNumber = (prefix: string, fiscalYear: string, n: number): string =>
  `${prefix}/${fiscalYear}/${String(n).padStart(4, '0')}`;

export type FlagEntry = {
  id: string;
  itemKey: string;
  description: string;
  occurredAt: Date;
  recordedAt: Date;
  unpriced: boolean;
};

export type DischargeFlags = {
  /** Live entries with no bill line because the item has no price: these block Finalise. */
  unpriced: FlagEntry[];
  /** Same item, same patient, within 15 minutes: perhaps recorded twice. */
  possibleDuplicates: FlagEntry[];
  /** Recorded more than six hours after it was given. */
  lateRecordings: FlagEntry[];
};

/** What the desk should look at before finalising, most important first. */
export function dischargeFlags(entries: readonly FlagEntry[]): DischargeFlags {
  const sorted = [...entries].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const duplicates = new Set<string>();
  const lastByItem = new Map<string, FlagEntry>();
  for (const entry of sorted) {
    const previous = lastByItem.get(entry.itemKey);
    if (previous && entry.occurredAt.getTime() - previous.occurredAt.getTime() <= DUPLICATE_WINDOW_MS) {
      duplicates.add(entry.id);
    }
    lastByItem.set(entry.itemKey, entry);
  }
  return {
    unpriced: sorted.filter((entry) => entry.unpriced),
    possibleDuplicates: sorted.filter((entry) => duplicates.has(entry.id)),
    lateRecordings: sorted.filter((entry) => isLateRecording(entry.occurredAt, entry.recordedAt)),
  };
}

export type PayerSplit = {
  totalPaise: number;
  /** What the insurer / TPA / company has approved, capped at the bill. */
  payerSharePaise: number;
  patientSharePaise: number;
  paidPaise: number;
  /** Positive: the patient owes this. Negative: refund this much. */
  balancePaise: number;
};

/**
 * Who owes what. The payer pays up to its approved amount; the patient pays
 * the rest, less what they have already paid (deposits included).
 */
export function payerSplit(args: {
  totalPaise: number;
  paidPaise: number;
  approvedAmountPaise: number | null;
}): PayerSplit {
  const payerSharePaise = Math.min(Math.max(args.approvedAmountPaise ?? 0, 0), args.totalPaise);
  const patientSharePaise = args.totalPaise - payerSharePaise;
  return {
    totalPaise: args.totalPaise,
    payerSharePaise,
    patientSharePaise,
    paidPaise: args.paidPaise,
    balancePaise: patientSharePaise - args.paidPaise,
  };
}

/** The family's link stays usable for a week after discharge. */
export const BILL_LINK_AFTER_DISCHARGE_MS = 7 * 86_400_000;

/**
 * The running-bill link token: the hospital id (32 hex, not secret) followed
 * by a 128-bit random part. Carrying the hospital lets the bill be found
 * under row-level security without a privileged lookup; only the random
 * part's hash is stored.
 */
export function buildBillLinkToken(hospitalId: string, random: string): string {
  return `${hospitalId.replace(/-/g, '')}${random}`;
}

export function parseBillLinkToken(token: string): { hospitalId: string; random: string } | null {
  const match = /^([0-9a-f]{32})([A-Za-z0-9_-]{22,})$/.exec(token);
  if (!match) return null;
  const hex = match[1];
  const hospitalId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { hospitalId, random: match[2] };
}

export const isBillLinkLive = (args: {
  expiresAt: Date | null;
  revokedAt: Date | null;
  now: Date;
}): boolean => !args.revokedAt && (args.expiresAt === null || args.expiresAt.getTime() > args.now.getTime());

/* ---------------------------------------------------------------- deposit alerts (B2) */

/** D-DEP: alert when the charges reach 80% of what was paid, or more than ₹5,000 is owed. Hospital settings. */
export type DepositAlertSettings = { usedPct: number; balancePaise: number };
export const DEFAULT_DEPOSIT_ALERT: DepositAlertSettings = { usedPct: 80, balancePaise: 500_000 };

export function depositAlertSettingsFrom(raw: Record<string, unknown> | null | undefined): DepositAlertSettings {
  const pct = raw?.usedPct;
  const rupees = raw?.balanceRupees;
  return {
    usedPct: typeof pct === 'number' && Number.isInteger(pct) && pct >= 50 && pct <= 100 ? pct : DEFAULT_DEPOSIT_ALERT.usedPct,
    balancePaise:
      typeof rupees === 'number' && Number.isInteger(rupees) && rupees >= 0 && rupees <= 10_00_000 ? rupees * 100 : DEFAULT_DEPOSIT_ALERT.balancePaise,
  };
}

export type DepositAlert = {
  /** 'used': the deposit is mostly used up; 'owed': the patient owes more than the limit. */
  reason: 'used' | 'owed';
  usedPct: number | null;
  balancePaise: number;
};

/**
 * Should the desk ask for more deposit? Owed beyond the limit wins (it is
 * already money at risk); otherwise the deposit used up past the percentage.
 * Nothing charged yet, or nothing at all: no alert.
 */
export function depositAlert(args: { totalPaise: number; paidPaise: number; settings: DepositAlertSettings }): DepositAlert | null {
  const { totalPaise, paidPaise, settings } = args;
  if (totalPaise <= 0) return null;
  const balancePaise = totalPaise - paidPaise;
  const usedPct = paidPaise > 0 ? Math.floor((totalPaise * 100) / paidPaise) : null;
  if (balancePaise > settings.balancePaise) return { reason: 'owed', usedPct, balancePaise };
  if (usedPct !== null && usedPct >= settings.usedPct) return { reason: 'used', usedPct, balancePaise };
  return null;
}
