/**
 * Inpatient medication order state machine and transition rules.
 * Enforces valid lifecycle state transitions, structured clinical reasons, and runtime order actionability.
 */

export const IPD_ORDER_STATUSES = [
  'draft',
  'active',
  'on_hold',
  'discontinued',
  'completed',
  'superseded',
  'voided',
] as const;

export type IpdMedicationOrderStatus = (typeof IPD_ORDER_STATUSES)[number];

export const IPD_ORDER_ACTIONS = [
  'sign',
  'hold',
  'resume',
  'discontinue',
  'modify',
  'renew',
  'expire',
  'void',
] as const;

export type IpdOrderAction = (typeof IPD_ORDER_ACTIONS)[number];

export interface OrderActionableCheck {
  status: string;
  endsAt?: Date | null;
}

/**
 * Returns whether an order is actionable on the bedside eMAR at a given timestamp.
 * Invariant: status must be 'active' AND (endsAt is null OR endsAt > now).
 */
export function isOrderActionable(order: OrderActionableCheck, now: Date): boolean {
  if (order.status !== 'active') return false;
  if (order.endsAt && order.endsAt <= now) return false;
  return true;
}

export interface ValidateOrderTransitionArgs {
  currentStatus: string;
  action: string;
  reason?: string | null;
  doctorId?: string | null;
  successorOrderId?: string | null;
  endsAt?: Date | null;
  now: Date;
}

export interface TransitionValidationResult {
  valid: boolean;
  nextStatus?: IpdMedicationOrderStatus;
  error?: string;
}

/**
 * Validates a requested order state transition and returns the resulting state or error.
 */
export function validateOrderTransition(args: ValidateOrderTransitionArgs): TransitionValidationResult {
  const { currentStatus, action, reason, doctorId, successorOrderId, endsAt, now } = args;

  // Actions requiring mandatory structured reason (minimum 3 characters)
  const requiresReason = ['hold', 'resume', 'discontinue', 'modify', 'renew', 'void'];
  if (requiresReason.includes(action)) {
    if (!reason || reason.trim().length < 3) {
      return {
        valid: false,
        error: `Action '${action}' requires a structured reason of at least 3 characters.`,
      };
    }
  }

  switch (action) {
    case 'sign': {
      if (currentStatus !== 'draft') {
        return { valid: false, error: `Cannot sign order with status '${currentStatus}'.` };
      }
      if (!doctorId) {
        return { valid: false, error: 'Signing an order requires an authorized prescribing doctor.' };
      }
      return { valid: true, nextStatus: 'active' };
    }

    case 'hold': {
      if (currentStatus !== 'active') {
        return { valid: false, error: `Cannot hold order with status '${currentStatus}'.` };
      }
      return { valid: true, nextStatus: 'on_hold' };
    }

    case 'resume': {
      if (currentStatus !== 'on_hold') {
        return { valid: false, error: `Cannot resume order with status '${currentStatus}'.` };
      }
      return { valid: true, nextStatus: 'active' };
    }

    case 'discontinue': {
      if (currentStatus !== 'active' && currentStatus !== 'on_hold') {
        return { valid: false, error: `Cannot discontinue order with status '${currentStatus}'.` };
      }
      return { valid: true, nextStatus: 'discontinued' };
    }

    case 'modify': {
      if (currentStatus !== 'active') {
        return { valid: false, error: `Cannot modify order with status '${currentStatus}'.` };
      }
      return { valid: true, nextStatus: 'superseded' };
    }

    case 'renew': {
      if (currentStatus !== 'active') {
        return { valid: false, error: `Cannot renew order with status '${currentStatus}'.` };
      }
      return { valid: true, nextStatus: 'superseded' };
    }

    case 'expire': {
      if (currentStatus !== 'active') {
        return { valid: false, error: `Cannot expire order with status '${currentStatus}'.` };
      }
      if (!endsAt || now < endsAt) {
        return { valid: false, error: 'Cannot expire order before course ends_at timestamp.' };
      }
      return { valid: true, nextStatus: 'completed' };
    }

    case 'void': {
      if (currentStatus === 'voided' || currentStatus === 'completed' || currentStatus === 'superseded') {
        return { valid: false, error: `Cannot void order with terminal status '${currentStatus}'.` };
      }
      return { valid: true, nextStatus: 'voided' };
    }

    default:
      return { valid: false, error: `Unknown order action: '${action}'.` };
  }
}
