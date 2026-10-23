'use client';

import React, { useEffect, useState, useTransition } from 'react';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input } from '@/components/ui';
import { useToast } from '@/components/toast';
import {
  CalendarIcon,
  ClockIcon,
  AlertTriangleIcon,
  XIcon,
  CheckIcon,
  StethoscopeIcon,
  MapPinIcon,
} from '@/components/icons';
import type { BlackoutDisruptionPreview, BlackoutPeriodItem } from '@/lib/services/blackout';
import {
  createBlackoutAction,
  listBlackoutPeriodsAction,
  previewBlackoutAction,
  revokeBlackoutAction,
} from './blackout-actions';

export interface HolidaysAndBlackoutsManagerProps {
  doctors: Array<{ id: string; name: string; branchId: string; branchName?: string }>;
  branches?: Array<{ id: string; name: string }>;
  initialBlackouts?: BlackoutPeriodItem[];
}

export function HolidaysAndBlackoutsManager({
  doctors,
  branches = [],
  initialBlackouts = [],
}: HolidaysAndBlackoutsManagerProps) {
  const toast = useToast();
  const [blackouts, setBlackouts] = useState<BlackoutPeriodItem[]>(initialBlackouts);
  const [isLoading, setIsLoading] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Create Modal State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [scopeType, setScopeType] = useState<'all' | 'doctor' | 'branch'>('all');
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>('');
  const [selectedBranchId, setSelectedBranchId] = useState<string>('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reopenDate, setReopenDate] = useState('');
  const [reason, setReason] = useState('');
  const [publicReason, setPublicReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Preview State
  const [preview, setPreview] = useState<BlackoutDisruptionPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  // Revoke Modal State
  const [revokeTarget, setRevokeTarget] = useState<BlackoutPeriodItem | null>(null);

  const fetchBlackouts = async () => {
    setIsLoading(true);
    const res = await listBlackoutPeriodsAction();
    setIsLoading(false);
    if (res.ok && res.data) {
      setBlackouts(res.data);
    }
  };

  useEffect(() => {
    fetchBlackouts();
  }, []);

  const resetForm = () => {
    setScopeType('all');
    setSelectedDoctorId('');
    setSelectedBranchId('');
    setStartDate('');
    setEndDate('');
    setReopenDate('');
    setReason('');
    setPublicReason('');
    setPreview(null);
    setFormError(null);
  };

  const handleStartDateChange = (val: string) => {
    setStartDate(val);
    setPreview(null);
    if (!endDate || endDate < val) {
      setEndDate(val);
    }
    // Automatically suggest next day as reopen date
    if (val) {
      const parts = (endDate || val).split('-').map(Number);
      const nextDay = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
      setReopenDate(nextDay.toISOString().slice(0, 10));
    }
  };

  const handleEndDateChange = (val: string) => {
    setEndDate(val);
    setPreview(null);
    if (val) {
      const parts = val.split('-').map(Number);
      const nextDay = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
      setReopenDate(nextDay.toISOString().slice(0, 10));
    }
  };

  const handleCheckImpact = async () => {
    setFormError(null);
    if (!startDate || !endDate) {
      setFormError('Please select both start date and end date.');
      return;
    }
    if (startDate > endDate) {
      setFormError('Start date cannot be after end date.');
      return;
    }
    if (scopeType === 'doctor' && !selectedDoctorId) {
      setFormError('Please select a doctor.');
      return;
    }
    if (scopeType === 'branch' && !selectedBranchId) {
      setFormError('Please select a branch.');
      return;
    }

    setIsPreviewing(true);
    const res = await previewBlackoutAction({
      doctorId: scopeType === 'doctor' ? selectedDoctorId : null,
      branchId: scopeType === 'branch' ? selectedBranchId : null,
      startDate,
      endDate,
    });
    setIsPreviewing(false);

    if (!res.ok || !res.data) {
      setFormError(res.error || 'Failed to check impact preview');
      return;
    }
    setPreview(res.data);
  };

  const handleCreateConfirm = () => {
    setFormError(null);
    if (!startDate || !endDate || !reopenDate) {
      setFormError('Please fill in all date fields.');
      return;
    }
    if (reopenDate <= endDate) {
      setFormError('Reopen date must be strictly after the end date.');
      return;
    }
    if (!reason.trim()) {
      setFormError('Please enter an internal reason for administrative records.');
      return;
    }

    startTransition(async () => {
      const res = await createBlackoutAction({
        doctorId: scopeType === 'doctor' ? selectedDoctorId : null,
        branchId: scopeType === 'branch' ? selectedBranchId : null,
        startDate,
        endDate,
        reopenDate,
        reason: reason.trim(),
        publicReason: publicReason.trim() || reason.trim(),
      });

      if (!res.ok) {
        setFormError(res.error || 'Failed to schedule blackout period');
        return;
      }

      toast.success(
        `Holiday/blackout scheduled. ${res.result?.cancelledCount ?? 0} appointments cancelled, ${res.result?.notifiedCount ?? 0} WhatsApp notices queued.`,
      );
      setIsCreateOpen(false);
      resetForm();
      fetchBlackouts();
    });
  };

  const handleRevokeConfirm = () => {
    if (!revokeTarget) return;

    startTransition(async () => {
      const res = await revokeBlackoutAction({ blackoutId: revokeTarget.id });
      if (!res.ok) {
        toast.error(res.error || 'Failed to revoke blackout period');
        return;
      }
      toast.success('Blackout period revoked. OPD intake and slot booking re-enabled.');
      setRevokeTarget(null);
      fetchBlackouts();
    });
  };

  const activeBlackouts = blackouts.filter((b) => !b.cancelledAt);
  const cancelledBlackouts = blackouts.filter((b) => Boolean(b.cancelledAt));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-rose-50 text-rose-700">
                <CalendarIcon className="size-4" />
              </span>
              <span>Holiday Shutdowns & Multi-Day Blackouts</span>
            </div>
          }
          hint="Schedule planned multi-day clinic holidays, maintenance closures, or hospital-wide shutdowns with automatic booking gating and patient cancellation notices."
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                resetForm();
                setIsCreateOpen(true);
              }}
            >
              Add Holiday / Blackout
            </Button>
          }
        />

        <div className="p-5">
          {isLoading ? (
            <div className="py-8 text-center text-xs text-ink-500">Loading blackout records...</div>
          ) : activeBlackouts.length === 0 ? (
            <EmptyState
              title="No active blackout periods"
              hint="When a multi-day holiday or hospital shutdown is active, live queues and slot bookings are suspended and patients are given contextual reopen notices."
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-ink-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-ink-200 bg-ink-50 text-ink-700 font-medium">
                  <tr>
                    <th className="px-4 py-3">Closure Dates</th>
                    <th className="px-4 py-3">Reopen Date</th>
                    <th className="px-4 py-3">Scope</th>
                    <th className="px-4 py-3">Public Reason</th>
                    <th className="px-4 py-3">Internal Note</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100 bg-white">
                  {activeBlackouts.map((b) => (
                    <tr key={b.id} className="hover:bg-ink-50/50">
                      <td className="px-4 py-3 font-semibold text-ink-900 whitespace-nowrap">
                        {b.startDate} to {b.endDate}
                      </td>
                      <td className="px-4 py-3 font-medium text-emerald-700 whitespace-nowrap">
                        {b.reopenDate}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {b.doctorName ? (
                          <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-blue-700 font-medium">
                            <StethoscopeIcon className="size-3" /> Dr. {b.doctorName}
                          </span>
                        ) : b.branchName ? (
                          <span className="inline-flex items-center gap-1 rounded bg-purple-50 px-2 py-0.5 text-purple-700 font-medium">
                            <MapPinIcon className="size-3" /> Branch: {b.branchName}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-rose-700 font-medium">
                            Hospital-wide (All Doctors)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-700 font-medium max-w-[200px] truncate">
                        {b.publicReason || b.reason}
                      </td>
                      <td className="px-4 py-3 text-ink-500 max-w-[150px] truncate">
                        {b.reason}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setRevokeTarget(b)}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Past / Revoked History */}
          {cancelledBlackouts.length > 0 ? (
            <div className="mt-8 pt-6 border-t border-ink-100">
              <h4 className="text-xs font-semibold text-ink-500 uppercase tracking-wider mb-3">
                Revoked / Past Blackout History
              </h4>
              <div className="overflow-x-auto rounded-xl border border-ink-100 bg-ink-50/40 opacity-75">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-ink-100 text-ink-500 font-normal">
                    <tr>
                      <th className="px-4 py-2">Dates</th>
                      <th className="px-4 py-2">Scope</th>
                      <th className="px-4 py-2">Reason</th>
                      <th className="px-4 py-2">Revoked Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100 text-ink-600">
                    {cancelledBlackouts.map((b) => (
                      <tr key={b.id}>
                        <td className="px-4 py-2">
                          {b.startDate} to {b.endDate}
                        </td>
                        <td className="px-4 py-2">
                          {b.doctorName ? `Dr. ${b.doctorName}` : b.branchName ? b.branchName : 'All Doctors'}
                        </td>
                        <td className="px-4 py-2">{b.publicReason || b.reason}</td>
                        <td className="px-4 py-2 text-rose-600 font-medium">
                          {b.cancelledAt ? new Date(b.cancelledAt).toLocaleDateString() : 'Revoked'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      {/* -------------------- Add Blackout Modal -------------------- */}
      {isCreateOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-ink-200 overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-ink-200 px-6 py-4 bg-ink-50/50">
              <div>
                <h3 className="text-base font-bold text-ink-900">Schedule Holiday / Blackout</h3>
                <p className="text-xs text-ink-500">
                  Suspends intake, cancels bookings, and queues patient WhatsApp alerts
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsCreateOpen(false);
                  resetForm();
                }}
                className="rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700 transition-colors"
              >
                <XIcon className="size-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              {formError ? <Alert tone="error">{formError}</Alert> : null}

              {/* Scope Selection */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-ink-700">Closure Scope</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setScopeType('all');
                      setPreview(null);
                    }}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium text-center transition-all ${
                      scopeType === 'all'
                        ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-600'
                        : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'
                    }`}
                  >
                    All Doctors (Hospital-wide)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScopeType('doctor');
                      setPreview(null);
                    }}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium text-center transition-all ${
                      scopeType === 'doctor'
                        ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-600'
                        : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'
                    }`}
                  >
                    Specific Doctor
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setScopeType('branch');
                      setPreview(null);
                    }}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium text-center transition-all ${
                      scopeType === 'branch'
                        ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-600'
                        : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'
                    }`}
                  >
                    Specific Branch
                  </button>
                </div>
              </div>

              {scopeType === 'doctor' ? (
                <Field label="Doctor">
                  <select
                    value={selectedDoctorId}
                    onChange={(e) => {
                      setSelectedDoctorId(e.target.value);
                      setPreview(null);
                    }}
                    className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 focus:outline-none text-sm"
                  >
                    <option value="">Select doctor...</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        Dr. {d.name} {d.branchName ? `(${d.branchName})` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}

              {scopeType === 'branch' ? (
                <Field label="Branch">
                  <select
                    value={selectedBranchId}
                    onChange={(e) => {
                      setSelectedBranchId(e.target.value);
                      setPreview(null);
                    }}
                    className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 focus:outline-none text-sm"
                  >
                    <option value="">Select branch...</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}

              {/* Date Ranges */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start Date" hint="First day of closure">
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => handleStartDateChange(e.target.value)}
                  />
                </Field>
                <Field label="End Date" hint="Last day of closure">
                  <Input
                    type="date"
                    value={endDate}
                    min={startDate}
                    onChange={(e) => handleEndDateChange(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="Reopen Date" hint="Day OPD and clinic services resume">
                <Input
                  type="date"
                  value={reopenDate}
                  min={endDate || startDate}
                  onChange={(e) => setReopenDate(e.target.value)}
                />
              </Field>

              {/* Reasons */}
              <Field
                label="Public Reason (Patient-facing)"
                hint="Included in WhatsApp bot replies and closure banners (e.g., 'Diwali Holidays', 'Maintenance')"
              >
                <Input
                  placeholder="e.g. Diwali Holidays / Renovation"
                  value={publicReason}
                  onChange={(e) => setPublicReason(e.target.value)}
                />
              </Field>

              <Field
                label="Internal Reason / Administrative Note"
                hint="For staff and audit logs"
              >
                <Input
                  placeholder="e.g. Annual electrical wiring maintenance"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>

              {/* Impact Preview Section */}
              <div className="rounded-xl border border-ink-200 bg-ink-50/60 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-ink-700">
                    Disruption Impact
                  </h4>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    isLoading={isPreviewing}
                    onClick={handleCheckImpact}
                  >
                    Check Affected Patients
                  </Button>
                </div>

                {preview ? (
                  <div className="space-y-2 animate-in fade-in duration-150">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-lg bg-white p-2 border border-ink-200">
                        <div className="text-lg font-bold text-rose-600">{preview.willCancel}</div>
                        <div className="text-[10px] text-ink-500 font-medium">To Cancel</div>
                      </div>
                      <div className="rounded-lg bg-white p-2 border border-ink-200">
                        <div className="text-lg font-bold text-blue-600">{preview.messageCount}</div>
                        <div className="text-[10px] text-ink-500 font-medium">WhatsApp Alerts</div>
                      </div>
                      <div className="rounded-lg bg-white p-2 border border-ink-200">
                        <div className="text-lg font-bold text-ink-600">
                          {preview.inConsultationOrDone}
                        </div>
                        <div className="text-[10px] text-ink-500 font-medium">In Consult / Done</div>
                      </div>
                    </div>

                    {preview.willCancel > 0 ? (
                      <Alert tone="warn">
                        <div className="flex gap-2 text-xs">
                          <AlertTriangleIcon className="size-4 shrink-0 text-amber-600" />
                          <span>
                            Creating this blackout will immediately cancel{' '}
                            <strong>{preview.willCancel}</strong> scheduled appointments and queue{' '}
                            <strong>{preview.messageCount}</strong> WhatsApp cancellation notices.
                          </span>
                        </div>
                      </Alert>
                    ) : (
                      <p className="text-xs text-emerald-700 font-medium flex items-center gap-1">
                        <CheckIcon className="size-3.5" /> No existing bookings affected in this date range.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-ink-500">
                    Click &ldquo;Check Affected Patients&rdquo; to preview how many bookings will be cancelled
                    and how many WhatsApp messages will be sent.
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4 bg-ink-50/50">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setIsCreateOpen(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                isLoading={isPending}
                onClick={handleCreateConfirm}
              >
                Confirm & Schedule Blackout
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* -------------------- Revoke Confirmation Modal -------------------- */}
      {revokeTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-ink-200 overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="p-6 space-y-4">
              <div className="flex size-10 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <AlertTriangleIcon className="size-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-ink-900">Revoke Blackout Period?</h3>
                <p className="mt-1 text-xs text-ink-600">
                  Are you sure you want to revoke the closure scheduled from{' '}
                  <strong>{revokeTarget.startDate}</strong> to <strong>{revokeTarget.endDate}</strong>?
                </p>
              </div>

              <Alert tone="warn">
                <span className="text-xs">
                  Revoking this blackout immediately restores online slot booking and walk-in intake.
                  Appointments cancelled during creation will <strong>not</strong> be resurrected.
                </span>
              </Alert>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4 bg-ink-50/50">
              <Button variant="secondary" size="sm" onClick={() => setRevokeTarget(null)}>
                Keep Blackout
              </Button>
              <Button
                variant="danger"
                size="sm"
                isLoading={isPending}
                onClick={handleRevokeConfirm}
              >
                Revoke Blackout
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
