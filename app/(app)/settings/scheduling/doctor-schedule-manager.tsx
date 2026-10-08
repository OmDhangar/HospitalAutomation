'use client';

import React, { useEffect, useState, useTransition } from 'react';
import { Alert, Button, Card, CardHeader, Field, Input } from '@/components/ui';
import {
  LayersIcon,
  ActivityIcon,
  ClockIcon,
  ZapIcon,
  StethoscopeIcon,
  XIcon,
} from '@/components/icons';
import { useToast } from '@/components/toast';
import type { DoctorListItem } from '@/lib/services/hospital';
import type {
  DoctorScheduleSettings,
  GeneratedSlot,
  IntervalBlockItem,
  SlotOverrideItem,
} from '@/lib/services/scheduling';
import {
  addIntervalBlockApi,
  fetchDoctorScheduleData,
  previewIntervalApi,
  removeIntervalBlockApi,
  saveScheduleConfigApi,
  toggleSlotOverrideApi,
} from './actions';

/**
 * The three practice modes, as data.
 */
const SCHEDULE_MODE_OPTIONS = [
  {
    value: 'both',
    label: 'Hybrid',
    hint: 'Both (Queue + Slots)',
    selectedClass:
      'bg-amber-50 border-amber-500 text-amber-950 font-bold ring-2 ring-amber-500 shadow-xs',
  },
  {
    value: 'queue',
    label: 'Live Queue',
    hint: 'Tokens Only',
    selectedClass:
      'bg-blue-50 border-blue-600 text-blue-950 font-bold ring-2 ring-blue-600 shadow-xs',
  },
  {
    value: 'slot',
    label: 'Time Slots',
    hint: 'Slots Only',
    selectedClass:
      'bg-emerald-50 border-emerald-600 text-emerald-950 font-bold ring-2 ring-emerald-600 shadow-xs',
  },
] as const;

export function DoctorScheduleManager({
  doctors,
  initialDate,
}: {
  doctors: DoctorListItem[];
  initialDate: string;
}) {
  const toast = useToast();
  const [selectedDoctorId, setSelectedDoctorId] = useState<string>(doctors[0]?.id || '');
  const [selectedDate, setSelectedDate] = useState<string>(initialDate);

  const [loadingSchedule, setLoadingSchedule] = useState(true);
  const [scheduleData, setScheduleData] = useState<{
    config: DoctorScheduleSettings;
    slots: GeneratedSlot[];
    intervalBlocks: IntervalBlockItem[];
    overrides: SlotOverrideItem[];
    totalAvailable: number;
  } | null>(null);

  // Form states for Availability Config
  const [scheduleMode, setScheduleMode] = useState<'both' | 'queue' | 'slot'>('both');
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('17:00');
  const [slotMinutes, setSlotMinutes] = useState(15);
  const [breakStart, setBreakStart] = useState('13:00');
  const [breakEnd, setBreakEnd] = useState('14:00');
  // Optional second, slot-only session after the main one: the split day of a
  // live queue (e.g. 12-7pm) and then booked slots only (e.g. 8-10pm).
  const [eveningEnabled, setEveningEnabled] = useState(false);
  const [eveningStart, setEveningStart] = useState('20:00');
  const [eveningEnd, setEveningEnd] = useState('22:00');
  const [eveningSlotMinutes, setEveningSlotMinutes] = useState(10);
  const [isSavingConfig, startSaveConfigTransition] = useTransition();

  // Form states for Temporary Interval Block
  const [intervalStart, setIntervalStart] = useState('13:00');
  const [intervalEnd, setIntervalEnd] = useState('14:30');
  const [intervalReason, setIntervalReason] = useState('Emergency / Surgery');
  const [isAddingBlock, startAddBlockTransition] = useTransition();

  const loadSchedule = async (docId: string, dateStr: string) => {
    if (!docId) return;
    setLoadingSchedule(true);
    try {
      const data = await fetchDoctorScheduleData(docId, dateStr);
      setScheduleData(data);
      if (data?.config) {
        const sessions: DoctorScheduleSettings['sessions'] = data.config.sessions ?? [];
        // The main session is the live queue when there is one; a slot-only
        // session after it is the evening session.
        const main = sessions.find((x) => x.mode !== 'slot') ?? sessions[0] ?? data.config;
        const evening = sessions.find((x) => x !== main && x.mode === 'slot');
        setScheduleMode(main.mode);
        setStartTime(main.startTime);
        setEndTime(main.endTime);
        setSlotMinutes(main.slotMinutes);
        // A cleared break stays cleared rather than reappearing as 1-2pm.
        setBreakStart(main.breakStartTime ?? '');
        setBreakEnd(main.breakEndTime ?? '');
        setEveningEnabled(Boolean(evening));
        if (evening) {
          setEveningStart(evening.startTime);
          setEveningEnd(evening.endTime);
          setEveningSlotMinutes(evening.slotMinutes);
        }
      }
    } catch (e: unknown) {
      toast.error('Failed to load doctor schedule', (e as Error).message);
    } finally {
      setLoadingSchedule(false);
    }
  };

  useEffect(() => {
    if (selectedDoctorId && selectedDate) {
      loadSchedule(selectedDoctorId, selectedDate);
    }
  }, [selectedDoctorId, selectedDate]);

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    startSaveConfigTransition(async () => {
      try {
        await saveScheduleConfigApi({
          doctorId: selectedDoctorId,
          sessions: [
            {
              mode: scheduleMode,
              startTime,
              endTime,
              slotMinutes,
              breakStartTime: breakStart || null,
              breakEndTime: breakEnd || null,
            },
            ...(eveningEnabled
              ? [{ mode: 'slot' as const, startTime: eveningStart, endTime: eveningEnd, slotMinutes: eveningSlotMinutes }]
              : []),
          ],
        });
        toast.success('Schedule Updated', 'Doctor availability configuration saved.');
        loadSchedule(selectedDoctorId, selectedDate);
      } catch (err: unknown) {
        toast.error('Could not save schedule', (err as Error).message);
      }
    });
  };

  /** The split day doctors asked for: live queue 12-7pm, then booked slots from 8pm. */
  const applySplitDayPreset = () => {
    setScheduleMode('queue');
    setStartTime('12:00');
    setEndTime('19:00');
    setBreakStart('');
    setBreakEnd('');
    setEveningEnabled(true);
    setEveningStart('20:00');
    setEveningEnd('22:00');
    setEveningSlotMinutes(slotMinutes || 10);
  };

  const handleAddIntervalBlock = (e: React.FormEvent) => {
    e.preventDefault();
    startAddBlockTransition(async () => {
      try {
        const res = await addIntervalBlockApi({
          doctorId: selectedDoctorId,
          serviceDate: selectedDate,
          startTime: intervalStart,
          endTime: intervalEnd,
          reason: intervalReason,
        });
        toast.success(
          'Interval Blocked',
          res.message || `${intervalStart} – ${intervalEnd} blocked on ${selectedDate}.`,
        );
        loadSchedule(selectedDoctorId, selectedDate);
      } catch (err: unknown) {
        toast.error('Failed to block interval', (err as Error).message);
      }
    });
  };

  const handleRemoveIntervalBlock = async (blockId: string) => {
    try {
      await removeIntervalBlockApi({ doctorId: selectedDoctorId, blockId });
      toast.info('Interval block cleared');
      loadSchedule(selectedDoctorId, selectedDate);
    } catch (err: unknown) {
      toast.error('Failed to clear interval block', (err as Error).message);
    }
  };

  const handleToggleSlot = async (slotTime: string, currentlyAvailable: boolean) => {
    try {
      await toggleSlotOverrideApi({
        doctorId: selectedDoctorId,
        serviceDate: selectedDate,
        slotTime,
        isAvailable: !currentlyAvailable,
        reason: currentlyAvailable ? 'Manual Break' : undefined,
      });
      toast.info(`Slot ${slotTime} updated`);
      loadSchedule(selectedDoctorId, selectedDate);
    } catch (err: unknown) {
      toast.error('Could not update slot', (err as Error).message);
    }
  };

  const selectedDoc = doctors.find((d) => d.id === selectedDoctorId) || doctors[0];

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* 1. Doctor & Date Selection Ribbon */}
      <Card className="p-4 sm:p-5 bg-gradient-to-r from-ink-50/70 to-white">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
            <span className="text-xs sm:text-sm font-semibold text-ink-700 shrink-0">
              Select Doctor:
            </span>
            <select
              value={selectedDoctorId}
              onChange={(e) => setSelectedDoctorId(e.target.value)}
              className="rounded-lg border-0 bg-white py-1.5 px-3 text-xs sm:text-sm font-semibold text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 cursor-pointer max-w-[220px] truncate"
            >
              {doctors.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.name} {doc.specialty ? `(${doc.specialty})` : ''}
                </option>
              ))}
            </select>

            <div className="hidden sm:flex items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 sm:py-1 text-xs font-bold ${
                  scheduleMode === 'both'
                    ? 'bg-amber-100 text-amber-900 border border-amber-300'
                    : scheduleMode === 'queue'
                    ? 'bg-blue-100 text-blue-900 border border-blue-200'
                    : 'bg-emerald-100 text-emerald-900 border border-emerald-200'
                }`}
              >
                {scheduleMode === 'both' ? (
                  <>
                    <LayersIcon className="size-3 text-amber-700" />
                    <span>Hybrid (Queue + Slots)</span>
                  </>
                ) : scheduleMode === 'queue' ? (
                  <>
                    <ActivityIcon className="size-3 text-blue-700" />
                    <span>Live Queue Mode</span>
                  </>
                ) : (
                  <>
                    <ClockIcon className="size-3 text-emerald-700" />
                    <span>Time Slots Mode</span>
                  </>
                )}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 pt-2 sm:pt-0 border-t sm:border-t-0 border-ink-100">
            <label className="text-xs sm:text-sm font-semibold text-ink-700 shrink-0">Date:</label>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="py-1.5 px-3 text-xs sm:text-sm w-full sm:w-auto"
            />
          </div>
        </div>
      </Card>

      <div className="grid gap-5 sm:gap-6 lg:grid-cols-3">
        {/* Left 1 Column: Schedule Configuration & Emergency Interval Block */}
        <div className="space-y-5 sm:space-y-6 lg:col-span-1">
          {/* 3.1 Availability Config */}
          <Card>
            <CardHeader
              title="Practice & Schedule Settings"
              hint="Configure appointment slots, live OPD queue, or both"
            />
            <form onSubmit={handleSaveConfig} className="p-4 sm:p-5 space-y-4">
              <fieldset className="block">
                <legend className="mb-1.5 block text-sm font-medium text-ink-700">
                  Practice / Schedule Mode
                </legend>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {SCHEDULE_MODE_OPTIONS.map((option) => {
                    const selected = scheduleMode === option.value;
                    return (
                      <label
                        key={option.value}
                        className={`relative flex items-center sm:flex-col justify-start sm:justify-center p-3 rounded-xl border text-left sm:text-center transition-all cursor-pointer ${
                          selected
                            ? option.selectedClass
                            : 'bg-ink-50 border-ink-200 text-ink-700 hover:bg-ink-100 font-medium'
                        }`}
                      >
                        <input
                          type="radio"
                          name="scheduleMode"
                          value={option.value}
                          checked={selected}
                          onChange={() => setScheduleMode(option.value)}
                          className="peer sr-only"
                        />
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 rounded-xl peer-focus-visible:ring-2 peer-focus-visible:ring-brand-600 peer-focus-visible:ring-offset-2"
                        />
                        <div className="mb-1 sm:mb-1.5 mr-2 sm:mr-0">
                          {option.value === 'both' ? (
                            <LayersIcon className="size-5 text-amber-700" />
                          ) : option.value === 'queue' ? (
                            <ActivityIcon className="size-5 text-blue-700" />
                          ) : (
                            <ClockIcon className="size-5 text-emerald-700" />
                          )}
                        </div>
                        <div>
                          <span className="text-xs sm:text-sm font-bold block">{option.label}</span>
                          <span className="block text-xs text-ink-500">{option.hint}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
                <span className="mt-1 block text-xs text-ink-500">
                  Choose Hybrid (both) for regular OPD, or Live Queue for visiting specialists.
                </span>
              </fieldset>

              {scheduleMode === 'both' ? (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-950 leading-relaxed space-y-1">
                  <p className="font-bold flex items-center gap-1.5">
                    <LayersIcon className="size-4 text-amber-700" />
                    <span>Hybrid Mode (Both Active)</span>
                  </p>
                  <p>
                    Patients can walk-in / join today&apos;s live token queue without restriction, while advance bookings can select convenient time slots.
                  </p>
                </div>
              ) : scheduleMode === 'queue' ? (
                <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900 leading-relaxed space-y-1">
                  <p className="font-bold flex items-center gap-1.5">
                    <ActivityIcon className="size-4 text-blue-700" />
                    <span>Live Running Queue Mode (Visiting Doctors)</span>
                  </p>
                  <p>
                    All patients join a live dynamic token queue sequentially. Ideal for visiting doctors to cover all visiting patients arriving that day.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-950 leading-relaxed space-y-1">
                  <p className="font-bold flex items-center gap-1.5">
                    <ClockIcon className="size-4 text-emerald-700" />
                    <span>Time-based Appointment Slots Only</span>
                  </p>
                  <p>
                    Strict slot schedule. Consultations are strictly booked into fixed time slots.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Start Time">
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    required
                  />
                </Field>

                <Field label="End Time">
                  <Input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    required
                  />
                </Field>
              </div>

              <Field label="Estimated Consult Duration" hint="Used for queue ETAs & slot spacing">
                <select
                  value={slotMinutes}
                  onChange={(e) => setSlotMinutes(Number(e.target.value))}
                  className="w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 cursor-pointer"
                >
                  <option value={5}>5 minutes</option>
                  <option value={10}>10 minutes</option>
                  <option value={15}>15 minutes</option>
                  <option value={20}>20 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={45}>45 minutes</option>
                  <option value={60}>60 minutes (1 hour)</option>
                </select>
              </Field>

              <div className="border-t border-ink-100 pt-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs font-semibold text-ink-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={eveningEnabled}
                      onChange={(e) => setEveningEnabled(e.target.checked)}
                      className="size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-600"
                    />
                    <span>Evening slot session (booked slots only)</span>
                  </label>
                  <button
                    type="button"
                    onClick={applySplitDayPreset}
                    className="text-xs font-semibold text-brand-700 hover:text-brand-900 underline underline-offset-2 cursor-pointer"
                  >
                    Use: queue 12–7 PM, slots 8–10 PM
                  </button>
                </div>
                {eveningEnabled ? (
                  <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 space-y-3">
                    <p className="text-xs text-emerald-950 leading-relaxed">
                      After the session above ends, the live queue closes for the day. From the evening start,
                      patients can only book a slot; they are numbered S1, S2… by time, join the line when the
                      session starts, and are called in slot order. Switch individual slots on or off in the
                      grid to choose which ones patients may book.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <Field label="Evening Start">
                        <Input type="time" value={eveningStart} onChange={(e) => setEveningStart(e.target.value)} required />
                      </Field>
                      <Field label="Evening End">
                        <Input type="time" value={eveningEnd} onChange={(e) => setEveningEnd(e.target.value)} required />
                      </Field>
                      <Field label="Slot Length">
                        <select
                          value={eveningSlotMinutes}
                          onChange={(e) => setEveningSlotMinutes(Number(e.target.value))}
                          className="w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 cursor-pointer"
                        >
                          {[5, 10, 15, 20, 30, 45, 60].map((m) => (
                            <option key={m} value={m}>
                              {m} minutes
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="border-t border-ink-100 pt-3">
                <p className="text-xs font-semibold text-ink-700 mb-2">Default Lunch / Break</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Break Start">
                    <Input
                      type="time"
                      value={breakStart}
                      onChange={(e) => setBreakStart(e.target.value)}
                    />
                  </Field>
                  <Field label="Break End">
                    <Input
                      type="time"
                      value={breakEnd}
                      onChange={(e) => setBreakEnd(e.target.value)}
                    />
                  </Field>
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="md"
                className="w-full justify-center"
                isLoading={isSavingConfig}
              >
                {scheduleMode === 'both'
                  ? 'Save Hybrid (Queue & Slot) Schedule'
                  : scheduleMode === 'queue'
                  ? 'Save Running Queue Mode'
                  : 'Generate & Save Slot Schedule'}
              </Button>
            </form>
          </Card>

          {/* 3.4 Emergency / Temporary Unavailability Block */}
          <Card>
            <CardHeader
              title="Emergency Unavailability"
              hint="Block custom interval without altering whole schedule"
            />
            <form onSubmit={handleAddIntervalBlock} className="p-4 sm:p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Block Start">
                  <Input
                    type="time"
                    value={intervalStart}
                    onChange={(e) => setIntervalStart(e.target.value)}
                    required
                  />
                </Field>

                <Field label="Block End">
                  <Input
                    type="time"
                    value={intervalEnd}
                    onChange={(e) => setIntervalEnd(e.target.value)}
                    required
                  />
                </Field>
              </div>

              <Field label="Reason / Notes">
                <Input
                  type="text"
                  value={intervalReason}
                  onChange={(e) => setIntervalReason(e.target.value)}
                  placeholder="e.g. Emergency, Surgery, Hospital Meeting"
                />
              </Field>

              <Button
                type="submit"
                variant="danger"
                size="md"
                className="w-full justify-center"
                isLoading={isAddingBlock}
              >
                Block Interval For Today
              </Button>
            </form>

            {scheduleData?.intervalBlocks && scheduleData.intervalBlocks.length > 0 ? (
              <div className="border-t border-ink-200 p-4 space-y-2">
                <p className="text-xs font-bold text-ink-800 uppercase tracking-wider">
                  Active Emergency Blocks:
                </p>
                <div className="space-y-2">
                  {scheduleData.intervalBlocks.map((block) => (
                    <div
                      key={block.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-900"
                    >
                      <div>
                        <span className="font-bold">
                          {block.startTime} – {block.endTime}
                        </span>
                        {block.reason ? (
                          <span className="block text-xs text-ink-500">{block.reason}</span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveIntervalBlock(block.id)}
                        className="text-rose-700 hover:text-rose-900 font-bold px-2 py-1 rounded-md bg-rose-100 hover:bg-rose-200 cursor-pointer inline-flex items-center gap-1"
                        title="Clear block"
                      >
                        <span>Clear</span>
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </Card>
        </div>

        {/* Right 2 Columns: Interactive Slot Grid or Live Queue Info */}
        <div className="lg:col-span-2">
          {scheduleMode === 'queue' && !eveningEnabled ? (
            <Card className="p-4 sm:p-6 bg-gradient-to-br from-blue-50/50 via-white to-indigo-50/30 border-blue-200">
              <div className="flex flex-col sm:flex-row items-start gap-4">
                <div className="size-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-xs shrink-0">
                  <ActivityIcon className="size-6 text-white" />
                </div>
                <div className="space-y-3 flex-1">
                  <div>
                    <h3 className="text-base font-bold text-ink-900">
                      Live Running Queue Mode (Active for {selectedDoc?.name})
                    </h3>
                    <p className="text-xs text-ink-600 mt-0.5">
                      Visiting Doctor / High Capacity Walk-in & Token Management
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 pt-2">
                    <div className="p-3.5 rounded-xl bg-white border border-blue-100 shadow-xs">
                      <p className="text-xs font-semibold text-blue-900 flex items-center gap-1.5">
                        <ZapIcon className="size-3.5 text-blue-700" />
                        <span>Dynamic First-Come Tokens</span>
                      </p>
                      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
                        Patients do not have to compete for limited time slots. They get sequential tokens (Token #1, #2...) and live wait-time estimates on WhatsApp.
                      </p>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-blue-100 shadow-xs">
                      <p className="text-xs font-semibold text-blue-900 flex items-center gap-1.5">
                        <StethoscopeIcon className="size-3.5 text-blue-700" />
                        <span>Covers All Visiting Patients</span>
                      </p>
                      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
                        Ideal for specialists visiting specific days. The doctor can consult everyone who arrives, without hard slot cutoffs.
                      </p>
                    </div>
                  </div>

                  <div className="rounded-xl bg-blue-100/60 p-4 border border-blue-200/80 text-xs text-blue-950 space-y-1.5">
                    <p className="font-semibold">How Receptionists & WhatsApp Handle This:</p>
                    <ul className="list-disc list-inside space-y-1 text-blue-900">
                      <li>Walk-in registrations on the <strong>Dashboard</strong> insert directly into the active token queue.</li>
                      <li>WhatsApp bookings register patients into the live line and send them their live tracking link.</li>
                      <li>Consultations are managed sequentially from the <strong>Dashboard</strong> (Next, Recall, Park, Priority).</li>
                    </ul>
                  </div>
                </div>
              </div>
            </Card>
          ) : (
            <Card>
              <div className="border-b border-ink-200 px-4 py-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-bold text-ink-900">
                    Slot Schedule: {selectedDoc?.name}
                  </h2>
                  <p className="text-xs text-ink-500 mt-0.5">
                    {selectedDate} · {scheduleData?.totalAvailable ?? 0} slots available for online / reception booking
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex items-center gap-1">
                    <span className="size-2.5 rounded-sm bg-emerald-500" /> Available
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2.5 rounded-sm bg-rose-400" /> Blocked
                  </span>
                </div>
              </div>

              <div className="p-4 sm:p-5">
                {loadingSchedule ? (
                  <div className="py-16 text-center text-sm text-ink-400 animate-pulse">
                    Loading slot schedule...
                  </div>
                ) : !scheduleData?.slots || scheduleData.slots.length === 0 ? (
                  <div className="py-12 text-center">
                    <p className="text-sm font-semibold text-ink-700">No slots generated for this day.</p>
                    <p className="text-xs text-ink-500 mt-1">
                      Check your start and end times or ensure the doctor is active.
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2.5">
                    {scheduleData.slots.map((slot) => {
                      const isAvailable = slot.available;
                      return (
                        <div
                          key={slot.time24}
                          className={`relative rounded-xl border p-2.5 text-center transition-all ${
                            isAvailable
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-950 hover:border-emerald-400 hover:shadow-xs'
                              : 'bg-rose-50 border-rose-200 text-rose-800 opacity-80'
                          }`}
                        >
                          <p className="text-sm font-bold tracking-tight">
                            {slot.timeStr || slot.time24}
                            {slot.slotNumber !== null ? (
                              <span className="ml-1 text-[10px] font-semibold text-ink-500">S{slot.slotNumber}</span>
                            ) : null}
                          </p>
                          <span
                            className={`text-[10px] font-bold uppercase tracking-wider block mt-0.5 ${
                              isAvailable ? 'text-emerald-700' : 'text-rose-700'
                            }`}
                          >
                            {isAvailable ? 'Available' : slot.reason || 'Blocked'}
                          </span>

                          <button
                            type="button"
                            onClick={() => handleToggleSlot(slot.time24, isAvailable)}
                            className={`mt-1.5 w-full rounded-md py-0.5 text-[10px] font-bold transition-colors cursor-pointer ${
                              isAvailable
                                ? 'bg-rose-200/80 hover:bg-rose-300 text-rose-900'
                                : 'bg-emerald-200/80 hover:bg-emerald-300 text-emerald-900'
                            }`}
                          >
                            {isAvailable ? 'Block Slot' : 'Enable Slot'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
