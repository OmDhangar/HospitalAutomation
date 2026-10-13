export const OrderType = {
  MEDICATION: 'MEDICATION',
  IV_FLUID: 'IV_FLUID',
  INVESTIGATION: 'INVESTIGATION',
  NURSING: 'NURSING',
  DIET: 'DIET',
  VITALS_FREQ: 'VITALS_FREQ',
} as const;

export type OrderTypeValue = (typeof OrderType)[keyof typeof OrderType];

export const OrderStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  ON_HOLD: 'ON_HOLD',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatusValue = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PriorityTag = {
  ROUTINE: 'ROUTINE',
  STAT: 'STAT',
  PRN: 'PRN',
  EMERGENCY: 'EMERGENCY',
} as const;

export type PriorityTagValue = (typeof PriorityTag)[keyof typeof PriorityTag];

export const TaskStatus = {
  DUE: 'DUE',
  OVERDUE: 'OVERDUE', // derived if > 60 min past slot
  GIVEN: 'GIVEN',
  HELD: 'HELD',
  REFUSED: 'REFUSED',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  MISSED: 'MISSED',
} as const;

export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];

export const HoldReasons = [
  'NPO',
  'Vomiting',
  'Patient asleep',
  'Awaiting doctor review',
  'Abnormal vitals',
  'Other',
] as const;

export type HoldReason = (typeof HoldReasons)[number];

export const RefusedReasons = [
  'Patient refused',
  'Patient unwell',
  'Other',
] as const;

export type RefusedReason = (typeof RefusedReasons)[number];

export const NotAvailableReasons = [
  'Out of stock',
  'Awaiting pharmacy',
  'Other',
] as const;

export type NotAvailableReason = (typeof NotAvailableReasons)[number];

export const LateReasons = [
  'Patient away from ward',
  'Procedure',
  'Staff delay',
  'Other',
] as const;

export type LateReason = (typeof LateReasons)[number];

export const StopReasons = [
  'Course complete',
  'Adverse reaction',
  'Changed therapy',
  'Patient discharged',
  'Other',
] as const;

export type StopReason = (typeof StopReasons)[number];

export const OverrideReasons = [
  'Benefit outweighs risk',
  'Patient previously tolerated',
  'Confirmed with clinical specialist',
  'Emergency life-saving indication',
  'Other clinical rationale',
] as const;

export type OverrideReason = (typeof OverrideReasons)[number];

export const AdmissionStatus = {
  ADMITTED: 'Admitted',
  DISCHARGE_PLANNED: 'Discharge planned',
  READY_FOR_DISCHARGE: 'Ready for discharge',
  DISCHARGED: 'Discharged',
} as const;

export type AdmissionStatusValue = (typeof AdmissionStatus)[keyof typeof AdmissionStatus];

export const BadgeColors = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  blue: 'bg-sky-50 text-sky-800 ring-sky-300',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  amber: 'bg-amber-50 text-amber-900 ring-amber-300',
  red: 'bg-rose-50 text-rose-900 ring-rose-300',
  grey: 'bg-ink-100 text-ink-500 ring-ink-200',
} as const;

export type BadgeColorKey = keyof typeof BadgeColors;
