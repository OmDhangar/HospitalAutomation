'use client';

import React, { useEffect, useState, useTransition } from 'react';
import { Alert, Button, Card, CardHeader, Field, Input } from '@/components/ui';
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
  removeIntervalBlockApi,
  saveScheduleConfigApi,
  toggleSlotOverrideApi,
} from './actions';

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
  const [isSavingConfig, startSaveConfigTransition] = useTransition();

  // Form states for Temporary Interval Block
  const [intervalStart, setIntervalStart] = useState('13:00');
  const [intervalEnd, setIntervalEnd] = useState('14:30');
  const [intervalReason, setIntervalReason] = useState('Emergency / Surgery');
  const [isAddingBlock, startAddBlockTransition] = useTransition();

  // Active slot override being edited
  const [activeSlotTime, setActiveSlotTime] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('Lunch');

  const loadSchedule = async (docId: string, dateStr: string) => {
    if (!docId) return;
    setLoadingSchedule(true);
    try {
      const res = await fetchDoctorScheduleData(docId, dateStr);
      if (res.ok && res.data) {
        setScheduleData(res.data);
        const cfg = res.data.config;
        setScheduleMode(cfg.mode || 'both');
        setStartTime(cfg.startTime);
        setEndTime(cfg.endTime);
        setSlotMinutes(cfg.slotMinutes);
        setBreakStart(cfg.breakStartTime || '13:00');
        setBreakEnd(cfg.breakEndTime || '14:00');
      }
    } catch (err: unknown) {
      toast.error('Failed to load schedule', err instanceof Error ? err.message : '');
    } finally {
      setLoadingSchedule(false);
    }
  };

  useEffect(() => {
    if (selectedDoctorId) {
      loadSchedule(selectedDoctorId, selectedDate);
    }
  }, [selectedDoctorId, selectedDate]);

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    startSaveConfigTransition(async () => {
      try {
        await saveScheduleConfigApi({
          doctorId: selectedDoctorId,
          mode: scheduleMode,
          startTime,
          endTime,
          slotMinutes: Number(slotMinutes),
          breakStartTime: breakStart || null,
          breakEndTime: breakEnd || null,
        });
        toast.success(
          scheduleMode === 'both'
            ? 'Saved in Hybrid Mode (Live Queue + Time Slots)!'
            : scheduleMode === 'queue'
            ? 'Saved in Live Running Queue Mode!'
            : 'Doctor Availability & Slots Saved!',
          scheduleMode === 'both'
            ? 'Patients can join the live queue today or book advance time slots.'
            : scheduleMode === 'queue'
            ? 'Patients will receive sequential queue tokens on booking.'
            : 'Appointment slots have been generated.',
        );
        await loadSchedule(selectedDoctorId, selectedDate);
      } catch (err: unknown) {
        toast.error('Save failed', err instanceof Error ? err.message : '');
      }
    });
  };

  const handleToggleSlotStatus = (slot: GeneratedSlot) => {
    const nextAvailable = !slot.available;
    const defaultReason = nextAvailable ? '' : 'Lunch';

    startSaveConfigTransition(async () => {
      try {
        await toggleSlotOverrideApi({
          doctorId: selectedDoctorId,
          serviceDate: selectedDate,
          slotTime: slot.time24,
          isAvailable: nextAvailable,
          reason: nextAvailable ? undefined : defaultReason,
        });
        toast.success(
          nextAvailable ? `Slot ${slot.timeStr} Activated` : `Slot ${slot.timeStr} Deactivated`,
        );
        await loadSchedule(selectedDoctorId, selectedDate);
      } catch (err: unknown) {
        toast.error('Slot update failed', err instanceof Error ? err.message : '');
      }
    });
  };

  const handleAddIntervalBlock = (e: React.FormEvent) => {
    e.preventDefault();
    if (!intervalStart || !intervalEnd) {
      toast.error('Please enter both start and end time');
      return;
    }

    startAddBlockTransition(async () => {
      try {
        await addIntervalBlockApi({
          doctorId: selectedDoctorId,
          serviceDate: selectedDate,
          startTime: intervalStart,
          endTime: intervalEnd,
          reason: intervalReason.trim() || 'Emergency / Temporary Unavailability',
        });
        toast.success('Emergency Interval Blocked!', `Time between ${intervalStart} and ${intervalEnd} is now unavailable.`);
        await loadSchedule(selectedDoctorId, selectedDate);
      } catch (err: unknown) {
        toast.error('Failed to add block', err instanceof Error ? err.message : '');
      }
    });
  };

  const handleRemoveIntervalBlock = async (blockId: string) => {
    try {
      await removeIntervalBlockApi({ doctorId: selectedDoctorId, blockId });
      toast.info('Interval block removed');
      await loadSchedule(selectedDoctorId, selectedDate);
    } catch (err: unknown) {
      toast.error('Failed to remove block', err instanceof Error ? err.message : '');
    }
  };

  if (doctors.length === 0) {
    return null;
  }

  const selectedDoc = doctors.find((d) => d.id === selectedDoctorId);

  return (
    <div className="space-y-6">
      {/* Doctor & Date Header Bar */}
      <Card className="p-4 bg-white border-ink-200 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <label className="text-sm font-bold text-ink-900 shrink-0">Doctor:</label>
            <select
              value={selectedDoctorId}
              onChange={(e) => setSelectedDoctorId(e.target.value)}
              className="rounded-lg border-0 bg-ink-50 px-3 py-2 text-sm font-semibold text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600"
            >
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} {d.specialty ? `(${d.specialty})` : ''} {!d.active ? ' [Inactive]' : ''}
                </option>
              ))}
            </select>

            <span
              className={`rounded-full px-2.5 py-1 text-xs font-bold shrink-0 ${
                scheduleMode === 'both'
                  ? 'bg-amber-100 text-amber-900 border border-amber-300'
                  : scheduleMode === 'queue'
                  ? 'bg-blue-100 text-blue-900 border border-blue-200'
                  : 'bg-emerald-100 text-emerald-900 border border-emerald-200'
              }`}
            >
              {scheduleMode === 'both'
                ? '🌟 Hybrid (Live Queue + Time Slots)'
                : scheduleMode === 'queue'
                ? '🎫 Live Running Queue Mode'
                : '🕒 Time Slots Mode'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-ink-700">Date:</label>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="py-1.5 px-3 text-sm w-auto"
            />
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left 1 Column: Schedule Configuration & Emergency Interval Block */}
        <div className="space-y-6 lg:col-span-1">
          {/* 3.1 Availability Config */}
          <Card>
            <CardHeader
              title="Practice & Schedule Settings"
              hint="Configure appointment slots, live OPD queue, or both"
            />
            <form onSubmit={handleSaveConfig} className="p-5 space-y-4">
              <Field
                label="Practice / Schedule Mode"
                hint="Choose Hybrid (both) for regular OPD, or Live Queue for visiting specialists."
              >
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setScheduleMode('both')}
                    className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-center transition-all cursor-pointer ${
                      scheduleMode === 'both'
                        ? 'bg-amber-50 border-amber-500 text-amber-950 font-bold ring-2 ring-amber-500 shadow-sm'
                        : 'bg-ink-50 border-ink-200 text-ink-700 hover:bg-ink-100 font-medium'
                    }`}
                  >
                    <span className="text-xs sm:text-sm">🌟 Hybrid</span>
                    <span className="text-[10px] mt-0.5 opacity-80">Both (Queue+Slots)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleMode('queue')}
                    className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-center transition-all cursor-pointer ${
                      scheduleMode === 'queue'
                        ? 'bg-blue-50 border-blue-600 text-blue-950 font-bold ring-2 ring-blue-600 shadow-sm'
                        : 'bg-ink-50 border-ink-200 text-ink-700 hover:bg-ink-100 font-medium'
                    }`}
                  >
                    <span className="text-xs sm:text-sm">🎫 Live Queue</span>
                    <span className="text-[10px] mt-0.5 opacity-80">Tokens Only</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleMode('slot')}
                    className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-center transition-all cursor-pointer ${
                      scheduleMode === 'slot'
                        ? 'bg-emerald-50 border-emerald-600 text-emerald-950 font-bold ring-2 ring-emerald-600 shadow-sm'
                        : 'bg-ink-50 border-ink-200 text-ink-700 hover:bg-ink-100 font-medium'
                    }`}
                  >
                    <span className="text-xs sm:text-sm">🕒 Slots</span>
                    <span className="text-[10px] mt-0.5 opacity-80">Slots Only</span>
                  </button>
                </div>
              </Field>

              {scheduleMode === 'both' ? (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-950 leading-relaxed space-y-1">
                  <p className="font-bold">🌟 Hybrid Mode (Both Active)</p>
                  <p>
                    Patients can walk-in / join today&apos;s live token queue without restriction, while advance bookings can select convenient time slots.
                  </p>
                </div>
              ) : scheduleMode === 'queue' ? (
                <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900 leading-relaxed space-y-1">
                  <p className="font-bold">🎫 Live Running Queue Mode (Visiting Doctors)</p>
                  <p>
                    All patients join a live dynamic token queue sequentially. Ideal for visiting doctors to cover all visiting patients arriving that day.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-950 leading-relaxed space-y-1">
                  <p className="font-bold">🕒 Time-based Appointment Slots Only</p>
                  <p>
                    Strict slot schedule. Consultations are strictly booked into fixed time slots.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
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
                  className="w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600"
                >
                  <option value={10}>10 minutes</option>
                  <option value={15}>15 minutes</option>
                  <option value={20}>20 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={45}>45 minutes</option>
                  <option value={60}>60 minutes (1 hour)</option>
                </select>
              </Field>

              <div className="border-t border-ink-100 pt-3">
                <p className="text-xs font-semibold text-ink-700 mb-2">Default Lunch / Break</p>
                <div className="grid grid-cols-2 gap-3">
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
                className="w-full"
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
            <form onSubmit={handleAddIntervalBlock} className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
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
                className="w-full"
                isLoading={isAddingBlock}
              >
                🚫 Block Interval For Today
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
                          <span className="block text-[11px] opacity-80">{block.reason}</span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveIntervalBlock(block.id)}
                        className="text-rose-700 hover:text-rose-900 font-bold px-1.5 py-0.5 rounded bg-rose-100 hover:bg-rose-200"
                        title="Clear block"
                      >
                        Clear ✕
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
          {scheduleMode === 'queue' ? (
            <Card className="p-6 bg-gradient-to-br from-blue-50/50 via-white to-indigo-50/30 border-blue-200">
              <div className="flex items-start gap-4">
                <div className="size-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center text-2xl shadow-sm shrink-0">
                  🎫
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
                      <p className="text-xs font-semibold text-blue-900">⚡ Dynamic First-Come Tokens</p>
                      <p className="text-xs text-ink-600 mt-1 leading-relaxed">
                        Patients do not have to compete for limited time slots. They get sequential tokens (Token #1, #2...) and live wait-time estimates on WhatsApp.
                      </p>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-blue-100 shadow-xs">
                      <p className="text-xs font-semibold text-blue-900">🩺 Covers All Visiting Patients</p>
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
              <CardHeader
                title={`Generated Appointment Slots (${scheduleData?.slots.length || 0} Total)`}
                hint={`${scheduleData?.totalAvailable || 0} available for booking · Duration: ${slotMinutes} mins`}
                action={
                  <div className="flex items-center gap-2 text-xs">
                    <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                      <span className="size-2 rounded-full bg-emerald-500 inline-block" /> Available
                    </span>
                    <span className="inline-flex items-center gap-1 text-rose-700 font-medium">
                      <span className="size-2 rounded-full bg-rose-500 inline-block" /> Blocked / Skip
                    </span>
                  </div>
                }
              />

              <div className="p-5">
                {loadingSchedule ? (
                  <div className="py-16 text-center">
                    <div className="inline-block animate-spin size-8 border-4 border-brand-600 border-t-transparent rounded-full mb-3" />
                    <p className="text-sm font-medium text-ink-600">Generating slots...</p>
                  </div>
                ) : !scheduleData || scheduleData.slots.length === 0 ? (
                  <div className="py-12 text-center text-ink-500">
                    <p className="text-sm">No slots generated for this date.</p>
                    <p className="text-xs mt-1">Check working hours configuration on the left.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {scheduleMode === 'both' ? (
                      <div className="rounded-xl bg-amber-50/80 p-3.5 text-xs text-amber-950 leading-relaxed border border-amber-200 shadow-xs flex items-start gap-2.5">
                        <span className="text-base leading-none">🌟</span>
                        <div>
                          <strong className="font-semibold">Hybrid Practice Mode Active:</strong> Patients booking for future dates will book from the time slots below. Patients arriving today can also walk in or join the live token queue without restriction.
                        </div>
                      </div>
                    ) : null}

                    <div className="rounded-lg bg-ink-50 p-3 text-xs text-ink-600 leading-relaxed border border-ink-200">
                      💡 <strong>Interactive Slot Management:</strong> Click any slot to immediately toggle
                      its availability (e.g. mark a slot as Lunch or Emergency). Patients on the web booking page will only see available slots.
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                      {scheduleData.slots.map((slot) => {
                        return (
                          <button
                            key={slot.time24}
                            type="button"
                            onClick={() => handleToggleSlotStatus(slot)}
                            className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all cursor-pointer ${
                              slot.available
                                ? 'bg-emerald-50/60 hover:bg-emerald-100 border-emerald-300 text-emerald-950 shadow-sm'
                                : 'bg-rose-50/60 hover:bg-rose-100 border-rose-300 text-rose-950 opacity-90'
                            }`}
                          >
                            <span className="text-sm font-bold">{slot.timeStr}</span>
                            <span
                              className={`mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                slot.available
                                  ? 'bg-emerald-200 text-emerald-900'
                                  : 'bg-rose-200 text-rose-900'
                              }`}
                            >
                              {slot.available ? '✅ Available' : `❌ ${slot.reason || 'Disabled'}`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
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
