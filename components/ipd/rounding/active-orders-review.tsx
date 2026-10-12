'use client';

import { useState } from 'react';
import { cn } from '@/components/ui';
import type { SelectIpdMedicationOrder } from '@/lib/db/schema';
import type {
  DraftOrderInput,
  OrderResolution,
} from '@/lib/services/ipd-medication-orders';
import type { RoundingCockpitData } from '@/lib/services/ipd-rounding-cockpit';

export interface ActiveOrdersReviewProps {
  activeOrders: SelectIpdMedicationOrder[];
  recentAdministrations: RoundingCockpitData['recentAdministrations'];
  resolutions: Record<string, OrderResolution>;
  onChangeResolution: (orderId: string, resolution: OrderResolution) => void;
  className?: string;
}

const COMMON_ROUTES: Array<{ id: DraftOrderInput['route']; label: string }> = [
  { id: 'oral', label: 'Oral' },
  { id: 'iv_push', label: 'IV Push' },
  { id: 'iv_piggyback', label: 'IV Piggyback' },
  { id: 'im', label: 'IM' },
  { id: 'sc', label: 'SC' },
  { id: 'nebulization', label: 'Nebulization' },
  { id: 'topical', label: 'Topical' },
  { id: 'inhalation', label: 'Inhalation' },
  { id: 'sublingual', label: 'Sublingual' },
];

const COMMON_FREQUENCIES: Record<string, { label: string; times: string[] }> = {
  OD: { label: 'OD (Once daily)', times: ['08:00'] },
  BD: { label: 'BD (Twice daily)', times: ['08:00', '20:00'] },
  TDS: { label: 'TDS (Thrice daily)', times: ['08:00', '14:00', '20:00'] },
  QID: { label: 'QID (Four times daily)', times: ['06:00', '12:00', '18:00', '22:00'] },
  Stat: { label: 'Stat (Immediate once)', times: ['Immediate'] },
  PRN: { label: 'PRN (As needed / SOS)', times: [] },
};

function formatAdminTime(date: Date | null): string {
  if (!date) return '—';
  const mins = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function ActiveOrdersReview({
  activeOrders,
  recentAdministrations,
  resolutions,
  onChangeResolution,
  className,
}: ActiveOrdersReviewProps) {
  // Track open edit panels per order
  const [expandedModifyId, setExpandedModifyId] = useState<string | null>(null);

  // Helper to find latest administration for an order
  const getLatestAdmin = (order: SelectIpdMedicationOrder) => {
    const matched = recentAdministrations.filter(
      (a) => a.orderChainId === order.orderChainId || a.orderId === order.id,
    );
    if (matched.length === 0) return null;
    return matched.sort(
      (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
    )[0];
  };

  const handleActionSelect = (
    order: SelectIpdMedicationOrder,
    actionType: 'continue' | 'renew' | 'modify' | 'hold' | 'discontinue',
  ) => {
    if (actionType === 'continue') {
      setExpandedModifyId(null);
      onChangeResolution(order.id, { type: 'continue', orderId: order.id });
    } else if (actionType === 'renew') {
      setExpandedModifyId(null);
      // Default extend by 3 days
      const currentEnds = order.endsAt ? new Date(order.endsAt).getTime() : Date.now();
      const baseTime = Math.max(currentEnds, Date.now());
      const newEndsAt = new Date(baseTime + 3 * 86400000);
      onChangeResolution(order.id, {
        type: 'renew',
        orderId: order.id,
        newEndsAt,
        reason: 'Course renewed for 3 days',
      });
    } else if (actionType === 'modify') {
      setExpandedModifyId(order.id);
      onChangeResolution(order.id, {
        type: 'modify',
        orderId: order.id,
        modifiedOrder: {
          doseAmount: order.doseAmount,
          doseUnit: order.doseUnit,
          route: order.route,
          frequencyCode: order.frequencyCode,
          scheduleTimes: order.scheduleTimes || [],
        },
        reason: '',
      });
    } else if (actionType === 'hold') {
      setExpandedModifyId(null);
      onChangeResolution(order.id, {
        type: 'hold',
        orderId: order.id,
        reason: 'Hold medication pending clinical review',
      });
    } else if (actionType === 'discontinue') {
      setExpandedModifyId(null);
      onChangeResolution(order.id, {
        type: 'discontinue',
        orderId: order.id,
        reason: 'Discontinued during daily round',
      });
    }
  };

  const currentAction = (orderId: string) => {
    const res = resolutions[orderId];
    return res ? res.type : 'continue';
  };

  const counts = {
    total: activeOrders.length,
    continue: 0,
    renew: 0,
    modify: 0,
    hold: 0,
    discontinue: 0,
  };

  for (const order of activeOrders) {
    const act = currentAction(order.id);
    if (act in counts) {
      counts[act as keyof typeof counts]++;
    }
  }

  if (activeOrders.length === 0) {
    return (
      <div
        className={cn(
          'rounded-xl border border-dashed border-ink-300 bg-ink-50/50 p-8 text-center text-ink-600',
          className,
        )}
      >
        <p className="text-sm font-semibold text-ink-800">No active medication orders</p>
        <p className="mt-1 text-xs text-ink-500">
          This patient does not currently have any active inpatient prescriptions. Prescribe below to initiate therapy.
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* Header and status counts */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            Active Medication Orders ({activeOrders.length})
          </h3>
          <p className="text-xs text-ink-500">
            Review and declare rounding decisions for each active therapy.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
            {counts.continue} Continue
          </span>
          {counts.renew > 0 && (
            <span className="rounded-md bg-sky-50 px-2 py-0.5 font-medium text-sky-800 ring-1 ring-inset ring-sky-200">
              {counts.renew} Renew
            </span>
          )}
          {counts.modify > 0 && (
            <span className="rounded-md bg-violet-50 px-2 py-0.5 font-medium text-violet-800 ring-1 ring-inset ring-violet-200">
              {counts.modify} Modify
            </span>
          )}
          {counts.hold > 0 && (
            <span className="rounded-md bg-amber-50 px-2 py-0.5 font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
              {counts.hold} Hold
            </span>
          )}
          {counts.discontinue > 0 && (
            <span className="rounded-md bg-rose-50 px-2 py-0.5 font-medium text-rose-800 ring-1 ring-inset ring-rose-200">
              {counts.discontinue} Discontinue
            </span>
          )}
        </div>
      </div>

      {/* Orders List */}
      <div className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white shadow-xs">
        {activeOrders.map((order) => {
          const act = currentAction(order.id);
          const resolution = resolutions[order.id];
          const latestAdmin = getLatestAdmin(order);
          const isHeld = order.status === 'on_hold';

          return (
            <div
              key={order.id}
              className={cn(
                'p-4 transition',
                act === 'discontinue' && 'bg-rose-50/40',
                act === 'hold' && 'bg-amber-50/40',
                act === 'modify' && 'bg-violet-50/30',
                act === 'renew' && 'bg-sky-50/30',
              )}
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                {/* Medication Details */}
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-ink-900">
                      {order.medicineName}
                    </span>
                    {order.strength && (
                      <span className="text-xs text-ink-500">({order.strength})</span>
                    )}
                    <span className="rounded-md bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-700">
                      {order.doseAmount} {order.doseUnit}
                    </span>
                    <span className="rounded-md bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-700 uppercase">
                      {order.route.replace('_', ' ')}
                    </span>
                    {isHeld && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                        Currently On Hold
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-600">
                    <div>
                      <span className="font-semibold text-ink-700">Freq:</span>{' '}
                      {order.frequencyCode || (order.isPrn ? 'PRN / SOS' : 'Custom')}
                      {order.scheduleTimes && order.scheduleTimes.length > 0 && (
                        <span className="ml-1 text-ink-500">
                          [{order.scheduleTimes.join(', ')}]
                        </span>
                      )}
                    </div>
                    {order.isPrn && order.prnIndication && (
                      <div>
                        <span className="font-semibold text-ink-700">Indication:</span>{' '}
                        {order.prnIndication}
                      </div>
                    )}
                    {order.endsAt && (
                      <div>
                        <span className="font-semibold text-ink-700">Ends:</span>{' '}
                        {new Date(order.endsAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </div>
                    )}
                    {latestAdmin && (
                      <div className="text-ink-500">
                        <span className="font-semibold text-ink-700">Last given:</span>{' '}
                        {formatAdminTime(latestAdmin.actualTime || latestAdmin.recordedAt)} ({latestAdmin.outcome})
                      </div>
                    )}
                  </div>

                  {order.specialInstructions && (
                    <p className="text-xs italic text-ink-500">
                      Note: {order.specialInstructions}
                    </p>
                  )}
                </div>

                {/* Rounding Action Controls */}
                <div className="flex shrink-0 flex-wrap items-center gap-1 rounded-lg border border-ink-200 bg-ink-50/80 p-1">
                  <button
                    type="button"
                    onClick={() => handleActionSelect(order, 'continue')}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-semibold transition',
                      act === 'continue'
                        ? 'bg-white text-emerald-700 shadow-xs'
                        : 'text-ink-600 hover:text-ink-900',
                    )}
                  >
                    Continue
                  </button>
                  <button
                    type="button"
                    onClick={() => handleActionSelect(order, 'renew')}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-semibold transition',
                      act === 'renew'
                        ? 'bg-sky-600 text-white shadow-xs'
                        : 'text-ink-600 hover:text-ink-900',
                    )}
                  >
                    Renew
                  </button>
                  <button
                    type="button"
                    onClick={() => handleActionSelect(order, 'modify')}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-semibold transition',
                      act === 'modify'
                        ? 'bg-violet-600 text-white shadow-xs'
                        : 'text-ink-600 hover:text-ink-900',
                    )}
                  >
                    Modify
                  </button>
                  <button
                    type="button"
                    onClick={() => handleActionSelect(order, 'hold')}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-semibold transition',
                      act === 'hold'
                        ? 'bg-amber-600 text-white shadow-xs'
                        : 'text-ink-600 hover:text-ink-900',
                    )}
                  >
                    Hold
                  </button>
                  <button
                    type="button"
                    onClick={() => handleActionSelect(order, 'discontinue')}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-semibold transition',
                      act === 'discontinue'
                        ? 'bg-rose-600 text-white shadow-xs'
                        : 'text-ink-600 hover:text-ink-900',
                    )}
                  >
                    Discontinue
                  </button>
                </div>
              </div>

              {/* Action-specific expander: Renew */}
              {act === 'renew' && resolution?.type === 'renew' && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-sky-200 bg-sky-50/60 p-2.5 text-xs text-sky-950">
                  <span className="font-semibold text-sky-900">Extend Course:</span>
                  <div className="flex gap-1.5">
                    {[1, 3, 5, 7, 14].map((days) => {
                      const curEnds = order.endsAt ? new Date(order.endsAt).getTime() : Date.now();
                      const target = new Date(Math.max(curEnds, Date.now()) + days * 86400000);
                      const isSelected =
                        resolution.newEndsAt &&
                        Math.abs(resolution.newEndsAt.getTime() - target.getTime()) < 60000;

                      return (
                        <button
                          key={days}
                          type="button"
                          onClick={() =>
                            onChangeResolution(order.id, {
                              type: 'renew',
                              orderId: order.id,
                              newEndsAt: target,
                              reason: `Course extended +${days} days`,
                            })
                          }
                          className={cn(
                            'rounded-md border px-2 py-1 font-semibold transition',
                            isSelected
                              ? 'border-sky-600 bg-sky-600 text-white'
                              : 'border-sky-300 bg-white text-sky-900 hover:bg-sky-100',
                          )}
                        >
                          +{days} Days
                        </button>
                      );
                    })}
                  </div>
                  <span className="text-sky-700">
                    New end date: {new Date(resolution.newEndsAt).toLocaleDateString()}
                  </span>
                </div>
              )}

              {/* Action-specific expander: Modify */}
              {act === 'modify' && resolution?.type === 'modify' && (
                <div className="mt-3 space-y-2 rounded-lg border border-violet-200 bg-violet-50/50 p-3 text-xs text-violet-950">
                  <div className="font-semibold text-violet-900">
                    Modify Clinical Prescription (Creates successor order on sign):
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div>
                      <label className="block text-[11px] font-medium text-ink-600">Dose</label>
                      <input
                        type="text"
                        value={resolution.modifiedOrder.doseAmount || ''}
                        onChange={(e) =>
                          onChangeResolution(order.id, {
                            ...resolution,
                            modifiedOrder: {
                              ...resolution.modifiedOrder,
                              doseAmount: e.target.value,
                            },
                          })
                        }
                        className="mt-0.5 w-full rounded border border-ink-200 bg-white px-2 py-1 text-xs text-ink-900"
                        placeholder="e.g. 500"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-ink-600">Unit</label>
                      <input
                        type="text"
                        value={resolution.modifiedOrder.doseUnit || ''}
                        onChange={(e) =>
                          onChangeResolution(order.id, {
                            ...resolution,
                            modifiedOrder: {
                              ...resolution.modifiedOrder,
                              doseUnit: e.target.value,
                            },
                          })
                        }
                        className="mt-0.5 w-full rounded border border-ink-200 bg-white px-2 py-1 text-xs text-ink-900"
                        placeholder="e.g. mg"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-ink-600">Route</label>
                      <select
                        value={resolution.modifiedOrder.route || order.route}
                        onChange={(e) =>
                          onChangeResolution(order.id, {
                            ...resolution,
                            modifiedOrder: {
                              ...resolution.modifiedOrder,
                              route: e.target.value as DraftOrderInput['route'],
                            },
                          })
                        }
                        className="mt-0.5 w-full rounded border border-ink-200 bg-white px-2 py-1 text-xs text-ink-900"
                      >
                        {COMMON_ROUTES.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-ink-600">Frequency</label>
                      <select
                        value={resolution.modifiedOrder.frequencyCode || order.frequencyCode || 'OD'}
                        onChange={(e) => {
                          const freq = e.target.value;
                          const preset = COMMON_FREQUENCIES[freq];
                          onChangeResolution(order.id, {
                            ...resolution,
                            modifiedOrder: {
                              ...resolution.modifiedOrder,
                              frequencyCode: freq,
                              scheduleTimes: preset ? preset.times : resolution.modifiedOrder.scheduleTimes,
                            },
                          });
                        }}
                        className="mt-0.5 w-full rounded border border-ink-200 bg-white px-2 py-1 text-xs text-ink-900"
                      >
                        {Object.keys(COMMON_FREQUENCIES).map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-ink-600">
                      Reason for Modification <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Dose titration based on clinical response, stepped down to oral"
                      value={resolution.reason || ''}
                      onChange={(e) =>
                        onChangeResolution(order.id, {
                          ...resolution,
                          reason: e.target.value,
                        })
                      }
                      className="mt-0.5 w-full rounded border border-ink-200 bg-white px-2 py-1 text-xs text-ink-900 placeholder:text-ink-400"
                    />
                  </div>
                </div>
              )}

              {/* Action-specific expander: Hold */}
              {act === 'hold' && resolution?.type === 'hold' && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950">
                  <span className="font-semibold text-amber-900">Hold Reason:</span>
                  <input
                    type="text"
                    value={resolution.reason}
                    onChange={(e) =>
                      onChangeResolution(order.id, {
                        ...resolution,
                        reason: e.target.value,
                      })
                    }
                    placeholder="Enter reason for temporary hold (e.g. Pre-op fasting, hypotension)"
                    className="flex-1 rounded border border-amber-300 bg-white px-2 py-1 text-xs text-amber-950 placeholder:text-amber-600"
                  />
                </div>
              )}

              {/* Action-specific expander: Discontinue */}
              {act === 'discontinue' && resolution?.type === 'discontinue' && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-xs text-rose-950">
                  <span className="font-semibold text-rose-900">Discontinuation Reason:</span>
                  <input
                    type="text"
                    value={resolution.reason}
                    onChange={(e) =>
                      onChangeResolution(order.id, {
                        ...resolution,
                        reason: e.target.value,
                      })
                    }
                    placeholder="Enter clinical reason (e.g. Treatment complete, side effect observed)"
                    className="flex-1 rounded border border-rose-300 bg-white px-2 py-1 text-xs text-rose-950 placeholder:text-rose-600"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
