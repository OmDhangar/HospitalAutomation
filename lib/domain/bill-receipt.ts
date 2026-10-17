import type { BillLine, PaymentRow } from '@/lib/services/discharge-billing';

export type ReceiptCategoryKey =
  | 'HOSPITAL_CHARGES'
  | 'INVESTIGATION'
  | 'PHARMACY_CONSUMABLES'
  | 'ROOM_CLINICAL';

export interface ReceiptLineItem {
  id: string;
  sNo: number;
  date: string;
  particulars: string;
  description: string;
  ratePaise: number;
  quantity: number;
  discountPaise: number;
  discountReason: string | null;
  amountPaise: number;
}

export interface CategorizedBillGroup {
  categoryKey: ReceiptCategoryKey;
  categoryTitle: string;
  lines: ReceiptLineItem[];
  subtotalPaise: number;
}

const CATEGORY_MAP: Record<string, { key: ReceiptCategoryKey; title: string }> = {
  room: { key: 'ROOM_CLINICAL', title: 'ROOM & CLINICAL CHARGES' },
  service: { key: 'ROOM_CLINICAL', title: 'ROOM & CLINICAL CHARGES' },
  investigation: { key: 'INVESTIGATION', title: 'INVESTIGATION' },
  medicine: { key: 'PHARMACY_CONSUMABLES', title: 'PHARMACY & CONSUMABLES' },
  consumable: { key: 'PHARMACY_CONSUMABLES', title: 'PHARMACY & CONSUMABLES' },
  procedure: { key: 'HOSPITAL_CHARGES', title: 'HOSPITAL CHARGES' },
};

const CATEGORY_ORDER: ReceiptCategoryKey[] = [
  'HOSPITAL_CHARGES',
  'INVESTIGATION',
  'PHARMACY_CONSUMABLES',
  'ROOM_CLINICAL',
];

export function categorizeBillLines(
  lines: readonly BillLine[],
  timezone: string = 'Asia/Kolkata',
): CategorizedBillGroup[] {
  const activeLines = lines.filter((l) => !l.voidedAt);

  const formatDate = (at: Date | null, day: string) => {
    if (at) {
      return at.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        timeZone: timezone,
      });
    }
    if (day) {
      try {
        const d = new Date(`${day}T00:00:00Z`);
        return d.toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        });
      } catch {
        return day;
      }
    }
    return '—';
  };

  const map = new Map<ReceiptCategoryKey, { title: string; lines: ReceiptLineItem[]; subtotalPaise: number }>();

  for (const line of activeLines) {
    const matched = CATEGORY_MAP[line.itemType.toLowerCase()] ?? {
      key: 'HOSPITAL_CHARGES' as ReceiptCategoryKey,
      title: 'HOSPITAL CHARGES',
    };

    let group = map.get(matched.key);
    if (!group) {
      group = { title: matched.title, lines: [], subtotalPaise: 0 };
      map.set(matched.key, group);
    }

    const sNo = group.lines.length + 1;
    const formattedDate = formatDate(line.at, line.day);

    group.lines.push({
      id: line.id,
      sNo,
      date: formattedDate,
      particulars: line.description,
      description: line.quantity > 1 ? `${line.quantity} UNITS` : '1 UNIT',
      ratePaise: line.unitPricePaise,
      quantity: line.quantity,
      discountPaise: line.discountPaise,
      discountReason: line.discountReason,
      amountPaise: line.totalPaise,
    });
    group.subtotalPaise += line.totalPaise;
  }

  // Return categories in the defined standard order
  const result: CategorizedBillGroup[] = [];
  for (const key of CATEGORY_ORDER) {
    const group = map.get(key);
    if (group && group.lines.length > 0) {
      result.push({
        categoryKey: key,
        categoryTitle: group.title,
        lines: group.lines,
        subtotalPaise: group.subtotalPaise,
      });
    }
  }

  return result;
}

export function computeReceiptSummary(
  totals: { totalPaise: number; subtotalPaise: number; discountPaise?: number; taxPaise?: number },
  payments: readonly PaymentRow[],
): {
  totalBillAmountPaise: number;
  netPaymentsPaise: number;
  balanceDuePaise: number;
  netAmountPaise: number;
} {
  const activePayments = payments.filter((p) => !p.voidedAt);
  const netPaymentsPaise = activePayments.reduce(
    (sum, p) => sum + (p.kind === 'refund' ? -p.amountPaise : p.amountPaise),
    0,
  );

  const totalBillAmountPaise = totals.totalPaise;
  const balanceDuePaise = Math.max(0, totalBillAmountPaise - netPaymentsPaise);
  const netAmountPaise = totalBillAmountPaise;

  return {
    totalBillAmountPaise,
    netPaymentsPaise,
    balanceDuePaise,
    netAmountPaise,
  };
}
