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

export type RoomType = 'General Ward' | 'Private Ward' | 'Semi-Private Bed';

export interface BeddingInfo {
  roomType: RoomType;
  bedNumber: string | null;
  display: string;
  categoryTitle: string;
}

export function classifyRoomType(input?: string | null): RoomType {
  if (!input) return 'General Ward';
  const text = input.toLowerCase();
  if (text.includes('semi')) {
    return 'Semi-Private Bed';
  }
  if (
    text.includes('private') ||
    text.includes('special') ||
    text.includes('deluxe') ||
    text.includes('single')
  ) {
    return 'Private Ward';
  }
  return 'General Ward';
}

export function formatBeddingInfo(args?: {
  wardName?: string | null;
  bedLabel?: string | null;
  rawDescription?: string | null;
}): BeddingInfo {
  const sourceText = `${args?.wardName ?? ''} ${args?.rawDescription ?? ''}`.trim();
  const roomType = classifyRoomType(sourceText);

  let bed = args?.bedLabel ?? null;
  if (!bed && args?.rawDescription) {
    const match = args.rawDescription.match(/bed\s+([A-Za-z0-9-]+)/i);
    if (match) bed = match[1];
  }
  if (bed) {
    bed = bed.replace(/^bed\s+/i, '').trim();
  }

  const bedDisplay = bed ? `Bed ${bed}` : null;
  const display = bedDisplay ? `${roomType} · ${bedDisplay}` : roomType;

  let categoryTitle = 'ROOM & CLINICAL CHARGES';
  const hasSpecificRoom = args?.wardName || (args?.rawDescription && /semi|private|special|deluxe|general|ward/i.test(args.rawDescription));

  if (hasSpecificRoom) {
    if (roomType === 'Semi-Private Bed') {
      categoryTitle = 'SEMI (SPECIAL ROOM)';
    } else if (roomType === 'Private Ward') {
      categoryTitle = 'PRIVATE WARD';
    } else if (roomType === 'General Ward') {
      categoryTitle = 'GENERAL WARD';
    }
  }

  return {
    roomType,
    bedNumber: bed,
    display,
    categoryTitle,
  };
}

export function categorizeBillLines(
  lines: readonly BillLine[],
  timezone: string = 'Asia/Kolkata',
  beddingContext?: BeddingInfo | { wardName?: string | null; bedLabel?: string | null } | null,
): CategorizedBillGroup[] {
  const activeLines = lines.filter((l) => !l.voidedAt);

  const resolvedBedding =
    beddingContext && 'roomType' in beddingContext
      ? (beddingContext as BeddingInfo)
      : beddingContext
        ? formatBeddingInfo(beddingContext)
        : null;

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

  let roomCategoryTitle = resolvedBedding?.categoryTitle ?? 'ROOM & CLINICAL CHARGES';

  for (const line of activeLines) {
    const isRoomItem = line.itemType.toLowerCase() === 'room';
    const isServiceItem = line.itemType.toLowerCase() === 'service';

    const matched = CATEGORY_MAP[line.itemType.toLowerCase()] ?? {
      key: 'HOSPITAL_CHARGES' as ReceiptCategoryKey,
      title: 'HOSPITAL CHARGES',
    };

    if (matched.key === 'ROOM_CLINICAL' && isRoomItem && !resolvedBedding) {
      const lineBedding = formatBeddingInfo({ rawDescription: line.description });
      roomCategoryTitle = lineBedding.categoryTitle;
    }

    let group = map.get(matched.key);
    if (!group) {
      group = {
        title: matched.key === 'ROOM_CLINICAL' ? roomCategoryTitle : matched.title,
        lines: [],
        subtotalPaise: 0,
      };
      map.set(matched.key, group);
    } else if (matched.key === 'ROOM_CLINICAL') {
      group.title = roomCategoryTitle;
    }

    const sNo = group.lines.length + 1;
    const formattedDate = formatDate(line.at, line.day);

    let particulars = line.description;
    let descriptionText = line.quantity > 1 ? `${line.quantity} UNITS` : '1 UNIT';

    if (isRoomItem) {
      const lineBedding = resolvedBedding ?? formatBeddingInfo({ rawDescription: line.description });
      particulars = lineBedding.bedNumber
        ? `BED CHARGES (Bed ${lineBedding.bedNumber})`
        : 'BED CHARGES';
      descriptionText = line.quantity > 1 ? `${line.quantity} DAYS` : '1 DAY';
    } else if (isServiceItem && line.description.toLowerCase().includes('visit')) {
      descriptionText = line.quantity > 1 ? `${line.quantity} DAYS` : '1 DAY';
    }

    group.lines.push({
      id: line.id,
      sNo,
      date: formattedDate,
      particulars,
      description: descriptionText,
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
