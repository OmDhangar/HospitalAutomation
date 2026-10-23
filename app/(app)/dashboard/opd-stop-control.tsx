'use client';

import { useState, useTransition } from 'react';
import { Button, Field, Input, cn } from '@/components/ui';
import { XIcon } from '@/components/icons';
import { useToast } from '@/components/toast';
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import {
  reopenOpdDynamic,
  stopAllOpdInBranchDynamic,
  stopOpdTodayDynamic,
} from './opd-actions';

export interface OpdStopControlStatus {
  stoppedAt: Date | string | null;
  isStopped: boolean;
  scheduled: boolean;
  canReopen?: boolean;
}

function parseStoppedAt(val: Date | string | null | undefined): Date | null {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

export function OpdStopControl({
  doctorId,
  status,
  timezone = 'Asia/Kolkata',
}: {
  doctorId: string;
  status?: OpdStopControlStatus | null;
  timezone?: string;
}) {
  const toast = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [stopMode, setStopMode] = useState<'now' | 'scheduled'>('now');
  const [scheduledTime, setScheduledTime] = useState('');
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();

  const stoppedAt = parseStoppedAt(status?.stoppedAt);
  const isStopped = Boolean(status?.isStopped);
  const scheduled = Boolean(status?.scheduled);
  const canReopen = Boolean(status?.canReopen);

  const handleStop = (e: React.FormEvent) => {
    e.preventDefault();

    let scheduledAtIso: string | null = null;
    if (stopMode === 'scheduled') {
      if (!scheduledTime) {
        toast.error('Please pick a stop time');
        return;
      }
      const today = serviceDateIn(timezone, new Date());
      // Combine today's date with the chosen HH:mm time
      const targetDate = new Date(`${today}T${scheduledTime}:00`);
      if (isNaN(targetDate.getTime())) {
        toast.error('Invalid scheduled time');
        return;
      }
      scheduledAtIso = targetDate.toISOString();
    }

    startTransition(async () => {
      const res = await stopOpdTodayDynamic({
        doctorId,
        scheduledAt: scheduledAtIso,
        reason: reason.trim() || undefined,
      });

      if (res.ok) {
        toast.info('OPD stopped');
        setIsOpen(false);
        setReason('');
        setStopMode('now');
        setScheduledTime('');
      } else {
        toast.error('Could not stop OPD', res.error);
      }
    });
  };

  const handleReopen = () => {
    startTransition(async () => {
      const res = await reopenOpdDynamic({ doctorId });
      if (res.ok) {
        toast.success('OPD reopened');
      } else {
        toast.error('Could not reopen OPD', res.error);
      }
    });
  };

  // State 1: Open (stoppedAt is null)
  if (!stoppedAt) {
    return (
      <>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setIsOpen(true)}
        >
          Stop OPD today
        </Button>

        {isOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-xs">
            <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl border border-ink-100">
              <div className="flex items-center justify-between pb-3 border-b border-ink-100">
                <h3 className="text-base font-bold text-ink-900">Stop OPD today</h3>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 cursor-pointer"
                >
                  <XIcon className="size-4" />
                </button>
              </div>

              <form onSubmit={handleStop} className="mt-4 space-y-4">
                <Field label="When">
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm text-ink-800 cursor-pointer">
                      <input
                        type="radio"
                        name="stopMode"
                        checked={stopMode === 'now'}
                        onChange={() => setStopMode('now')}
                        className="text-brand-600 focus:ring-brand-500"
                      />
                      <span>Now</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm text-ink-800 cursor-pointer">
                      <input
                        type="radio"
                        name="stopMode"
                        checked={stopMode === 'scheduled'}
                        onChange={() => setStopMode('scheduled')}
                        className="text-brand-600 focus:ring-brand-500"
                      />
                      <span>Scheduled</span>
                      {stopMode === 'scheduled' && (
                        <input
                          type="time"
                          value={scheduledTime}
                          onChange={(e) => setScheduledTime(e.target.value)}
                          required={stopMode === 'scheduled'}
                          className="ml-2 rounded-lg border border-ink-300 bg-white px-2 py-1 text-xs text-ink-900 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                        />
                      )}
                    </label>
                  </div>
                </Field>

                <Field label="Reason (optional)">
                  <Input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Doctor stepped out, emergency, clinic closing"
                  />
                </Field>

                <div className="flex justify-end gap-2 pt-3 border-t border-ink-100">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setIsOpen(false)}
                    disabled={isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    isLoading={isPending}
                    className="bg-red-600 hover:bg-red-700 focus-visible:outline-red-600"
                  >
                    Stop OPD
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </>
    );
  }

  const timeStr = formatTimeIn(timezone, stoppedAt);

  // State 2: Stopped (closed)
  if (isStopped) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 border border-rose-200 px-2.5 py-1 text-xs font-semibold text-rose-800">
        <span className="size-1.5 rounded-full bg-rose-600" />
        <span>OPD closed at {timeStr}</span>
        {canReopen && (
          <>
            <span className="text-rose-400">·</span>
            <button
              type="button"
              onClick={handleReopen}
              disabled={isPending}
              className="font-bold underline hover:text-rose-950 cursor-pointer disabled:opacity-50"
            >
              Reopen
            </button>
          </>
        )}
      </div>
    );
  }

  // State 3: Scheduled (future)
  if (scheduled) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs font-semibold text-amber-800">
        <span className="size-1.5 rounded-full bg-amber-600" />
        <span>OPD will stop at {timeStr}</span>
        <span className="text-amber-400">·</span>
        <button
          type="button"
          onClick={handleReopen}
          disabled={isPending}
          className="font-bold underline hover:text-amber-950 cursor-pointer disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    );
  }

  return null;
}

export function StopBranchOpdButton({
  branchId,
  timezone = 'Asia/Kolkata',
}: {
  branchId: string;
  timezone?: string;
}) {
  const toast = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [stopMode, setStopMode] = useState<'now' | 'scheduled'>('now');
  const [scheduledTime, setScheduledTime] = useState('');
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();

  const handleStop = (e: React.FormEvent) => {
    e.preventDefault();

    let scheduledAtIso: string | null = null;
    if (stopMode === 'scheduled') {
      if (!scheduledTime) {
        toast.error('Please pick a stop time');
        return;
      }
      const today = serviceDateIn(timezone, new Date());
      const targetDate = new Date(`${today}T${scheduledTime}:00`);
      if (isNaN(targetDate.getTime())) {
        toast.error('Invalid scheduled time');
        return;
      }
      scheduledAtIso = targetDate.toISOString();
    }

    startTransition(async () => {
      const res = await stopAllOpdInBranchDynamic({
        branchId,
        scheduledAt: scheduledAtIso,
        reason: reason.trim() || undefined,
      });

      if (res.ok) {
        toast.info(`OPD stopped for ${res.doctorCount} doctors`);
        setIsOpen(false);
        setReason('');
        setStopMode('now');
        setScheduledTime('');
      } else {
        toast.error('Could not stop branch OPD', res.error);
      }
    });
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setIsOpen(true)}
      >
        Stop all doctors&apos; OPD today
      </Button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl border border-ink-100">
            <div className="flex items-center justify-between pb-3 border-b border-ink-100">
              <h3 className="text-base font-bold text-ink-900">Stop all doctors&apos; OPD today</h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 cursor-pointer"
              >
                <XIcon className="size-4" />
              </button>
            </div>

            <form onSubmit={handleStop} className="mt-4 space-y-4">
              <Field label="When">
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm text-ink-800 cursor-pointer">
                    <input
                      type="radio"
                      name="branchStopMode"
                      checked={stopMode === 'now'}
                      onChange={() => setStopMode('now')}
                      className="text-brand-600 focus:ring-brand-500"
                    />
                    <span>Now</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink-800 cursor-pointer">
                    <input
                      type="radio"
                      name="branchStopMode"
                      checked={stopMode === 'scheduled'}
                      onChange={() => setStopMode('scheduled')}
                      className="text-brand-600 focus:ring-brand-500"
                    />
                    <span>Scheduled</span>
                    {stopMode === 'scheduled' && (
                      <input
                        type="time"
                        value={scheduledTime}
                        onChange={(e) => setScheduledTime(e.target.value)}
                        required={stopMode === 'scheduled'}
                        className="ml-2 rounded-lg border border-ink-300 bg-white px-2 py-1 text-xs text-ink-900 focus:ring-2 focus:ring-brand-600 focus:outline-none"
                      />
                    )}
                  </label>
                </div>
              </Field>

              <Field label="Reason (optional)">
                <Input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Hospital maintenance, power cut, emergency meeting"
                />
              </Field>

              <div className="flex justify-end gap-2 pt-3 border-t border-ink-100">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  isLoading={isPending}
                  className="bg-red-600 hover:bg-red-700 focus-visible:outline-red-600"
                >
                  Stop Branch OPD
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
