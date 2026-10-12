'use client';

import { useState, useTransition, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui';
import { SearchIcon } from '@/components/icons';
import {
  EmarBucketTabs,
  type EmarBucketKey,
  type EmarBucketCounts,
} from './emar-bucket-tabs';
import { EmarTaskCard } from './emar-task-card';
import { EmarRecentHistory } from './emar-recent-history';
import { AdministerModal } from './administer-modal';
import { ExceptionModal } from './exception-modal';
import { PrnAdminModal } from './prn-admin-modal';
import { voidAdministrationAction } from '@/app/(app)/ipd/actions';
import type {
  BedsideDueItem,
  BedsidePrnItem,
  BedsideEmarView,
} from '@/lib/services/ipd-emar';
import type { SelectIpdMedicationOrder } from '@/lib/db/schema';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';

export type { AllergenItem };

export interface BedsideEmarProps {
  admissionId: string;
  patientName: string;
  ipdNumber?: string | null;
  bedLabel?: string | null;
  wardName?: string | null;
  data: BedsideEmarView;
  allergyStatus?: 'unreviewed' | 'nkda' | 'allergies_documented';
  allergies?: AllergenItem[];
  canAdminister?: boolean;
  className?: string;
}

export function BedsideEmar({
  admissionId,
  patientName,
  ipdNumber,
  bedLabel,
  wardName,
  data,
  allergyStatus = 'unreviewed',
  allergies = [],
  canAdminister = true,
  className,
}: BedsideEmarProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Active bucket tab (default to 'dueNow', or 'overdue' if dueNow is empty and overdue has items)
  const [activeBucket, setActiveBucket] = useState<EmarBucketKey>(() => {
    if (data.dueNow.length > 0) return 'dueNow';
    if (data.overdue.length > 0) return 'overdue';
    if (data.upcoming.length > 0) return 'upcoming';
    if (data.prn.length > 0) return 'prn';
    return 'dueNow';
  });

  // Filter input
  const [filterQuery, setFilterQuery] = useState('');

  // Modal interaction states
  const [administerItem, setAdministerItem] = useState<BedsideDueItem | null>(null);
  const [exceptionItem, setExceptionItem] = useState<BedsideDueItem | null>(null);
  const [prnItem, setPrnItem] = useState<BedsidePrnItem | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  // Compute bucket counts
  const counts: EmarBucketCounts = useMemo(
    () => ({
      dueNow: data.dueNow.length,
      overdue: data.overdue.length,
      upcoming: data.upcoming.length,
      prn: data.prn.length,
      onHold: data.onHold.length,
      recentHistory: data.recentHistory.length,
    }),
    [data],
  );

  // Normalized filter query
  const q = filterQuery.trim().toLowerCase();

  const filteredDueNow = useMemo(
    () =>
      data.dueNow.filter(
        (item) =>
          !q ||
          item.medicineName.toLowerCase().includes(q) ||
          item.route.toLowerCase().includes(q),
      ),
    [data.dueNow, q],
  );

  const filteredOverdue = useMemo(
    () =>
      data.overdue.filter(
        (item) =>
          !q ||
          item.medicineName.toLowerCase().includes(q) ||
          item.route.toLowerCase().includes(q),
      ),
    [data.overdue, q],
  );

  const filteredUpcoming = useMemo(
    () =>
      data.upcoming.filter(
        (item) =>
          !q ||
          item.medicineName.toLowerCase().includes(q) ||
          item.route.toLowerCase().includes(q),
      ),
    [data.upcoming, q],
  );

  const filteredPrn = useMemo(
    () =>
      data.prn.filter(
        (item) =>
          !q ||
          item.medicineName.toLowerCase().includes(q) ||
          item.route.toLowerCase().includes(q) ||
          (item.prnIndication && item.prnIndication.toLowerCase().includes(q)),
      ),
    [data.prn, q],
  );

  const filteredOnHold = useMemo(
    () =>
      data.onHold.filter(
        (item) =>
          !q ||
          item.medicineName.toLowerCase().includes(q) ||
          item.route.toLowerCase().includes(q),
      ),
    [data.onHold, q],
  );

  const filteredHistory = useMemo(
    () =>
      data.recentHistory.filter(
        (item) =>
          !q ||
          (item.doseGiven && item.doseGiven.toLowerCase().includes(q)) ||
          (item.routeGiven && item.routeGiven.toLowerCase().includes(q)) ||
          item.outcome.toLowerCase().includes(q),
      ),
    [data.recentHistory, q],
  );

  const handleRefresh = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  const handleVoid = async (administrationId: string, reason: string) => {
    try {
      const res = await voidAdministrationAction({
        admissionId,
        administrationId,
        reason,
      });
      if (res.ok) {
        setActionNotice({ tone: 'success', text: 'Administration entry voided.' });
        startTransition(() => {
          router.refresh();
        });
      }
    } catch (err) {
      setActionNotice({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Failed to void administration.',
      });
    }
  };

  return (
    <div className={cn('space-y-4', className)}>
      {/* Patient & Bedside Header Banner */}
      <div className="flex flex-col gap-3 rounded-2xl border border-ink-200 bg-white p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-ink-900">{patientName}</h2>
              {ipdNumber && (
                <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-xs font-semibold text-ink-600">
                  {ipdNumber}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-500">
              {bedLabel && (
                <span className="font-semibold text-brand-700">
                  Bed {bedLabel} {wardName ? `· ${wardName}` : ''}
                </span>
              )}
              <span>•</span>
              <span>Bedside Nursing eMAR</span>
            </div>
          </div>

          {/* Allergy Badges */}
          <div className="flex flex-wrap items-center gap-1.5 pl-2 sm:border-l sm:border-ink-200">
            {allergyStatus === 'unreviewed' && (
              <span className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900">
                ⚠️ Allergies Unreviewed
              </span>
            )}
            {allergyStatus === 'nkda' && (
              <span className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                ✓ No allergies
              </span>
            )}
            {allergyStatus === 'allergies_documented' && (
              <>
                {allergies.length > 0 ? (
                  allergies.map((all, i) => (
                    <span
                      key={i}
                      className="rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-900"
                      title={all.reaction ? `Reaction: ${all.reaction}` : undefined}
                    >
                      ⚠️ {all.substance} {all.severity ? `(${all.severity})` : ''}
                    </span>
                  ))
                ) : (
                  <span className="rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-900">
                    ⚠️ Allergies Documented
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Quick Search & Reload Bar */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-400" />
            <input
              type="text"
              placeholder="Filter medications…"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="h-8 w-44 rounded-lg border border-ink-200 bg-ink-50/60 pl-8 pr-2.5 text-xs text-ink-900 placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-500 sm:w-56"
            />
            {filterQuery && (
              <button
                type="button"
                onClick={() => setFilterQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-400 hover:text-ink-600"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 text-xs font-semibold text-ink-700 shadow-2xs hover:bg-ink-50 disabled:opacity-50"
            title="Refresh eMAR data"
          >
            {isPending ? 'Syncing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Action Notice Banner */}
      {actionNotice && (
        <div
          className={cn(
            'flex items-center justify-between rounded-xl p-3 text-xs font-medium',
            actionNotice.tone === 'success'
              ? 'border border-emerald-300 bg-emerald-50 text-emerald-900'
              : 'border border-rose-300 bg-rose-50 text-rose-900',
          )}
        >
          <span>{actionNotice.text}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="text-xs font-bold underline hover:opacity-75"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Bucket Timeline Navigation */}
      <EmarBucketTabs
        activeBucket={activeBucket}
        onChangeBucket={setActiveBucket}
        counts={counts}
      />

      {/* Bucket Content Area */}
      <div className="space-y-3">
        {activeBucket === 'dueNow' && (
          <>
            {filteredDueNow.length === 0 ? (
              <div className="rounded-xl border border-dashed border-ink-200 bg-white p-8 text-center">
                <p className="text-sm font-medium text-ink-600">
                  {filterQuery
                    ? 'No due medications match your filter.'
                    : 'No medications due right now.'}
                </p>
                <p className="mt-1 text-xs text-ink-400">
                  Check upcoming or PRN medications for this patient.
                </p>
              </div>
            ) : (
              filteredDueNow.map((item) => (
                <EmarTaskCard
                  key={`${item.orderId}-${new Date(item.scheduledTime).getTime()}`}
                  kind="scheduled"
                  dueItem={item}
                  onAdminister={(itm) => setAdministerItem(itm as BedsideDueItem)}
                  onException={(itm) => setExceptionItem(itm)}
                />
              ))
            )}
          </>
        )}

        {activeBucket === 'overdue' && (
          <>
            {filteredOverdue.length === 0 ? (
              <div className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50/40 p-8 text-center">
                <p className="text-sm font-semibold text-emerald-900">
                  ✓ No overdue medications!
                </p>
                <p className="mt-1 text-xs text-emerald-700">
                  All scheduled doses are on schedule.
                </p>
              </div>
            ) : (
              filteredOverdue.map((item) => (
                <EmarTaskCard
                  key={`${item.orderId}-${new Date(item.scheduledTime).getTime()}`}
                  kind="scheduled"
                  dueItem={item}
                  onAdminister={(itm) => setAdministerItem(itm as BedsideDueItem)}
                  onException={(itm) => setExceptionItem(itm)}
                />
              ))
            )}
          </>
        )}

        {activeBucket === 'upcoming' && (
          <>
            {filteredUpcoming.length === 0 ? (
              <div className="rounded-xl border border-dashed border-ink-200 bg-white p-8 text-center">
                <p className="text-sm font-medium text-ink-600">
                  {filterQuery
                    ? 'No upcoming medications match your filter.'
                    : 'No upcoming scheduled doses within the current window.'}
                </p>
              </div>
            ) : (
              filteredUpcoming.map((item) => (
                <EmarTaskCard
                  key={`${item.orderId}-${new Date(item.scheduledTime).getTime()}`}
                  kind="scheduled"
                  dueItem={item}
                  onAdminister={(itm) => setAdministerItem(itm as BedsideDueItem)}
                  onException={(itm) => setExceptionItem(itm)}
                />
              ))
            )}
          </>
        )}

        {activeBucket === 'prn' && (
          <>
            {filteredPrn.length === 0 ? (
              <div className="rounded-xl border border-dashed border-ink-200 bg-white p-8 text-center">
                <p className="text-sm font-medium text-ink-600">
                  {filterQuery
                    ? 'No PRN medications match your filter.'
                    : 'No PRN / SOS medications ordered for this patient.'}
                </p>
              </div>
            ) : (
              filteredPrn.map((item) => (
                <EmarTaskCard
                  key={item.orderId}
                  kind="prn"
                  prnItem={item}
                  onAdminister={(itm) => setPrnItem(itm as BedsidePrnItem)}
                />
              ))
            )}
          </>
        )}

        {activeBucket === 'onHold' && (
          <>
            {filteredOnHold.length === 0 ? (
              <div className="rounded-xl border border-dashed border-ink-200 bg-white p-8 text-center">
                <p className="text-sm font-medium text-ink-600">
                  {filterQuery
                    ? 'No on-hold medications match your filter.'
                    : 'No medication orders currently on clinical hold.'}
                </p>
              </div>
            ) : (
              filteredOnHold.map((item) => (
                <EmarTaskCard
                  key={item.id}
                  kind="onHold"
                  holdItem={item}
                />
              ))
            )}
          </>
        )}

        {activeBucket === 'recentHistory' && (
          <EmarRecentHistory
            history={filteredHistory}
            onVoid={canAdminister ? handleVoid : undefined}
            canVoid={canAdminister}
          />
        )}
      </div>

      {/* Dose Administration Modal */}
      {administerItem && (
        <AdministerModal
          isOpen={true}
          onClose={() => setAdministerItem(null)}
          admissionId={admissionId}
          dueItem={administerItem}
          patientName={patientName}
          bedLabel={bedLabel ?? undefined}
          activeAllergies={allergies}
          onSuccess={() => {
            setActionNotice({
              tone: 'success',
              text: `Administered ${administerItem.medicineName} successfully.`,
            });
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      )}

      {/* Exception Recording Modal */}
      {exceptionItem && (
        <ExceptionModal
          isOpen={true}
          onClose={() => setExceptionItem(null)}
          admissionId={admissionId}
          dueItem={exceptionItem}
          onSuccess={() => {
            setActionNotice({
              tone: 'success',
              text: `Recorded exception for ${exceptionItem.medicineName}.`,
            });
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      )}

      {/* PRN Administration Modal */}
      {prnItem && (
        <PrnAdminModal
          isOpen={true}
          onClose={() => setPrnItem(null)}
          admissionId={admissionId}
          prnItem={prnItem}
          patientName={patientName}
          onSuccess={() => {
            setActionNotice({
              tone: 'success',
              text: `Administered PRN dose of ${prnItem.medicineName}.`,
            });
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      )}
    </div>
  );
}
