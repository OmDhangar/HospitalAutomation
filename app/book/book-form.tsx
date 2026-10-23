'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Alert, Button, Card, Field, Input, cn } from '@/components/ui';
import { CheckIcon, ClockIcon } from '@/components/icons';
import type { Locale } from '@/lib/i18n/patient';
import type { DoctorBookingDetails, TimeSlot } from '@/lib/services/web-booking';
import { submitSlotBooking, type BookSlotResult } from './actions';

export const EMERGENCY_REASONS = [
  { id: 'heart_pain', label: 'Heart Attack / Severe Chest Pain', icon: '🫀' },
  { id: 'head_pain', label: 'Extreme Head Pain', icon: '🧠' },
  { id: 'accident_bleed', label: 'Accident / Severe Bleeding', icon: '🩸' },
  { id: 'breathing_distress', label: 'Breathing Difficulty', icon: '🫁' },
  { id: 'seizure_fever', label: 'High Fever with Seizures', icon: '🤒' },
  { id: 'other', label: 'Other Medical Emergency', icon: '⚠️' },
] as const;

export function BookSlotForm({
  details,
  initialPhone = '',
  locale = 'en',
}: {
  details: DoctorBookingDetails;
  initialPhone?: string;
  locale?: Locale;
}) {
  const router = useRouter();
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(
    details.slots.find((s) => s.available) ?? null,
  );
  const [patientName, setPatientName] = useState('');
  const [patientAge, setPatientAge] = useState('');
  const [phone, setPhone] = useState(initialPhone);
  const [isEmergency, setIsEmergency] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState<string>('Heart Attack / Severe Chest Pain');
  const [emergencyNotes, setEmergencyNotes] = useState('');
  const [raceClosedAt, setRaceClosedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<Extract<BookSlotResult, { ok: true }> | null>(null);
  const [isPending, startTransition] = useTransition();

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const dayAfter = new Date(today);
  dayAfter.setDate(dayAfter.getDate() + 2);
  const dayAfterStr = dayAfter.toISOString().slice(0, 10);

  const formatTabLabel = (dateStr: string) => {
    if (dateStr === todayStr) return 'Today';
    if (dateStr === tomorrowStr) return 'Tomorrow';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const handleDateChange = (newDate: string) => {
    setSelectedSlot(null);
    startTransition(() => {
      const url = `/book?hospital=${details.hospital.id}&doctor=${
        details.doctor.id
      }&phone=${encodeURIComponent(phone)}&locale=${locale}&date=${newDate}`;
      router.push(url);
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlot) {
      setError('Please select a convenient appointment time slot');
      return;
    }
    if (!patientName.trim()) {
      setError('Please enter your full name');
      return;
    }
    if (!phone.trim()) {
      setError('Please enter your mobile phone number');
      return;
    }

    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('hospitalId', details.hospital.id);
      formData.set('doctorId', details.doctor.id);
      formData.set('patientName', patientName);
      if (patientAge.trim()) {
        formData.set('patientAge', patientAge.trim());
      }
      formData.set('phone', phone);
      formData.set('slotDatetimeIso', selectedSlot.datetimeIso);
      formData.set('locale', locale);

      if (isEmergency) {
        formData.set('isEmergency', 'true');
        formData.set('emergencyReason', emergencyReason || 'Other Medical Emergency');
        if (emergencyNotes.trim()) {
          formData.set('emergencyNotes', emergencyNotes.trim());
        }
      }

      const res = await submitSlotBooking(formData);
      if (res.ok) {
        setSuccess(res);
      } else {
        if (res.opdClosedAt) {
          setRaceClosedAt(res.opdClosedAt);
          setSelectedSlot(null);
        }
        setError(res.error);
      }
    });
  };

  if (success) {
    return (
      <div className="mx-auto max-w-lg">
        <Card className={cn(
          'bg-white shadow-[var(--shadow-raised)] overflow-hidden',
          success.isEmergency ? 'border-2 border-red-500 ring-2 ring-red-200' : 'border-brand-200'
        )}>
          <div className={cn(
            'px-6 py-5 border-b text-center',
            success.isEmergency ? 'bg-red-600 text-white border-red-700' : 'bg-brand-50 border-brand-100'
          )}>
            <span className={cn(
              'inline-flex items-center justify-center size-12 rounded-full font-bold text-xl mb-2 shadow-xs',
              success.isEmergency ? 'bg-white text-red-600 text-2xl' : 'bg-brand-600 text-white'
            )}>
              {success.isEmergency ? '🚨' : <CheckIcon className="size-6" />}
            </span>
            <h2 className={cn('text-xl font-bold', success.isEmergency ? 'text-white' : 'text-ink-900')}>
              {success.isEmergency ? 'Emergency Appointment Alerted!' : 'Appointment Confirmed!'}
            </h2>
            <p className={cn('text-xs mt-1', success.isEmergency ? 'text-red-100 font-medium' : 'text-brand-800')}>
              {success.isEmergency
                ? 'Your emergency visit has been flagged directly to clinic reception and Dr. ' + success.doctorName
                : 'Your appointment slot has been successfully scheduled'}
            </p>
          </div>

          <div className="p-6 space-y-5">
            <div className={cn(
              'rounded-xl p-4 text-center border',
              success.isEmergency ? 'bg-red-50/70 border-red-200' : 'bg-ink-50 border-ink-200'
            )}>
              <div className="flex items-center justify-center gap-2 mb-1">
                {success.isEmergency ? (
                  <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-black uppercase text-white shadow-xs">
                    🚨 Emergency Priority
                  </span>
                ) : (
                  <p className="text-xs font-medium text-ink-500 uppercase tracking-wider">
                    Your Token Number
                  </p>
                )}
              </div>
              <p className={cn(
                'numeric text-5xl font-bold mt-1',
                success.isEmergency ? 'text-red-600' : 'text-brand-700'
              )}>
                {success.tokenNumber}
              </p>
              <div className={cn(
                'mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
                success.isEmergency ? 'bg-red-100 text-red-900 border border-red-200' : 'bg-brand-100 text-brand-900'
              )}>
                <ClockIcon className="size-3.5" />
                <span>
                  Date: {details.serviceDate} · Time: {success.slotTimeFormatted}
                </span>
              </div>
            </div>

            {success.isEmergency && success.emergencyReason ? (
              <div className="rounded-xl border border-red-300 bg-red-50 p-3.5 text-xs text-red-950 flex items-start gap-2.5">
                <span className="text-xl shrink-0 mt-0.5">🚨</span>
                <div>
                  <p className="font-bold text-red-900">Emergency Reason Registered:</p>
                  <p className="text-red-800 mt-0.5 font-medium">{success.emergencyReason}</p>
                  <p className="text-[11px] text-red-700 mt-1">
                    Please proceed directly to the clinic reception upon arrival and show this token.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="space-y-3 text-sm border-t border-ink-100 pt-4">
              <div className="flex justify-between py-1 border-b border-ink-100/60">
                <span className="text-ink-500">Patient:</span>
                <span className="font-semibold text-ink-900">
                  {success.patientName}
                  {success.patientAge ? ` (${success.patientAge} yrs)` : ''}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-ink-100/60">
                <span className="text-ink-500">Doctor:</span>
                <span className="font-semibold text-ink-900">Dr. {success.doctorName}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-ink-500">Location:</span>
                <span className="font-semibold text-ink-900 text-right">
                  {details.branch.name}
                  {details.branch.address ? `, ${details.branch.address}` : ''}
                </span>
              </div>
            </div>

            <div className={cn(
              'rounded-lg p-3 text-xs leading-relaxed border',
              success.isEmergency ? 'bg-red-50 border-red-200 text-red-900' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
            )}>
              <p className="font-medium">
                {success.isEmergency ? '⚠️ Emergency Instructions:' : 'Notification Sent to Clinic:'}
              </p>
              <p className="mt-0.5">
                {success.isEmergency
                  ? 'Clinic staff will receive you with priority. If symptoms worsen immediately en route, call 108 or proceed to the Casualty room immediately.'
                  : `Dr. ${success.doctorName} and hospital staff have been informed of your appointment slot for ${details.serviceDate}.`}
              </p>
            </div>

            <div className="pt-2">
              <Link href={`/q/${success.publicToken}`} className="w-full block">
                <Button variant="primary" size="lg" className="w-full">
                  Track Live Queue Status
                </Button>
              </Link>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const availableSlotsCount = details.slots.filter((s) => s.available).length;
  const isToday = details.serviceDate === todayStr;
  const isClosedToday = Boolean(details.isClosed && isToday);
  const isClosed = isClosedToday || Boolean(raceClosedAt && isToday);
  const effectiveClosedAt = details.closedAt || raceClosedAt;
  const closedAtFormatted = effectiveClosedAt
    ? new Date(effectiveClosedAt).toLocaleTimeString('en-US', {
        timeZone: details.hospital.timezone || 'Asia/Kolkata',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : '';

  return (
    <div className="mx-auto max-w-xl">
      <Card className="shadow-[var(--shadow-raised)]">
        <div className="border-b border-ink-100 bg-ink-50/70 p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-brand-700">
                {details.hospital.name}
              </p>
              <h1 className="text-xl font-bold text-ink-900 mt-0.5">{details.doctor.name}</h1>
              {details.doctor.specialty ? (
                <p className="text-xs font-medium text-ink-500 mt-0.5">
                  {details.doctor.specialty} • {details.branch.name}
                </p>
              ) : (
                <p className="text-xs font-medium text-ink-500 mt-0.5">{details.branch.name}</p>
              )}
            </div>
            <span className="rounded-full bg-brand-100 px-2.5 py-1 text-[11px] font-semibold text-brand-800">
              {formatTabLabel(details.serviceDate)}
            </span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-6">
          {isClosed ? (
            <Alert tone="warn">
              <div className="space-y-2">
                <p>
                  The hospital has closed OPD for today{closedAtFormatted ? ` at ${closedAtFormatted}` : ''}. Please book a slot for tomorrow or later.
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => handleDateChange(tomorrowStr)}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 shadow-xs"
                  >
                    Book tomorrow →
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDateChange(dayAfterStr)}
                    className="rounded-lg bg-white border border-ink-300 px-3 py-1.5 text-xs font-semibold text-ink-800 hover:bg-ink-50 shadow-xs"
                  >
                    Book day after →
                  </button>
                </div>
              </div>
            </Alert>
          ) : error ? (
            <Alert tone="error">{error}</Alert>
          ) : null}

          {/* Date Selector Tabs */}
          <div className="space-y-2 border-b border-ink-100 pb-5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-bold text-ink-900">
                Select Appointment Date
              </label>
              <span className="text-xs text-ink-500 font-medium">
                📅 {details.serviceDate}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {[todayStr, tomorrowStr, dayAfterStr].map((dStr) => {
                const isTabToday = dStr === todayStr;
                const isTodayClosed = isTabToday && (details.isClosed || Boolean(raceClosedAt));

                if (isTodayClosed) {
                  return (
                    <button
                      key={dStr}
                      type="button"
                      disabled
                      title="OPD closed for today"
                      className="rounded-lg px-3 py-2 text-xs font-semibold bg-ink-100 text-ink-400 border border-ink-200 cursor-not-allowed flex items-center gap-1.5"
                    >
                      <span>Today</span>
                      <span className="rounded bg-ink-200 px-1.5 py-0.5 text-[10px] font-bold text-ink-600 uppercase">Closed</span>
                    </button>
                  );
                }

                return (
                  <button
                    key={dStr}
                    type="button"
                    onClick={() => handleDateChange(dStr)}
                    className={`rounded-lg px-3.5 py-2 text-xs font-bold transition-all ${
                      details.serviceDate === dStr
                        ? 'bg-brand-600 text-white shadow-sm ring-2 ring-brand-600'
                        : 'bg-white text-ink-800 border border-ink-200 hover:bg-brand-50/50 hover:border-brand-300'
                    }`}
                  >
                    {formatTabLabel(dStr)}
                  </button>
                );
              })}

              <div className="flex items-center gap-1.5 ml-auto">
                <span className="text-xs text-ink-400 font-medium">More dates:</span>
                <input
                  type="date"
                  value={details.serviceDate}
                  min={todayStr}
                  onChange={(e) => e.target.value && handleDateChange(e.target.value)}
                  className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-600"
                />
              </div>
            </div>
          </div>

          {/* Time Slot Selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-semibold text-ink-900">
                Select Available Time Slot
              </label>
              <span className="text-xs text-ink-500">
                {availableSlotsCount} {availableSlotsCount === 1 ? 'slot' : 'slots'} available
              </span>
            </div>

            {isClosed ? (
              <div className="rounded-lg bg-ink-50 p-4 text-center border border-ink-200">
                <p className="text-xs font-medium text-ink-600">
                  OPD intake for today is closed. Slots are no longer available.
                </p>
                <button
                  type="button"
                  onClick={() => handleDateChange(tomorrowStr)}
                  className="mt-2 text-xs font-bold text-brand-600 hover:underline inline-block"
                >
                  Check Tomorrow&apos;s Slots →
                </button>
              </div>
            ) : isToday && details.isOnlineOpen === false && details.onlineOpensAt ? (
              <div className="mb-3 rounded-xl bg-amber-50 border border-amber-200 p-3.5 text-xs text-amber-800 flex items-start gap-2.5">
                <ClockIcon className="size-4 text-amber-700 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-amber-900">Online Booking Not Open Yet</p>
                  <p className="mt-0.5">
                    Online appointments for today open at <strong>{details.onlineOpensAt}</strong>. You can book ahead for tomorrow or check other dates.
                  </p>
                </div>
              </div>
            ) : details.slots.length === 0 || availableSlotsCount === 0 ? (
              <div className="rounded-lg bg-ink-50 p-4 text-center border border-ink-200">
                <p className="text-xs font-medium text-ink-600">
                  {isToday && details.isOnlineOpen === false && details.onlineOpensAt
                    ? `Online booking for today opens at ${details.onlineOpensAt}.`
                    : `No available slots for ${formatTabLabel(details.serviceDate)}.`}
                </p>
                <button
                  type="button"
                  onClick={() => handleDateChange(tomorrowStr)}
                  className="mt-2 text-xs font-bold text-brand-600 hover:underline"
                >
                  Check Tomorrow&apos;s Slots →
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-56 overflow-y-auto p-1">
                {details.slots.map((slot) => {
                  const isSelected = selectedSlot?.datetimeIso === slot.datetimeIso;
                  return (
                    <button
                      key={slot.datetimeIso}
                      type="button"
                      disabled={!slot.available}
                      onClick={() => setSelectedSlot(slot)}
                      className={`rounded-lg px-2.5 py-2 text-xs font-semibold transition-all ${
                        isSelected
                          ? 'bg-brand-600 text-white shadow-sm ring-2 ring-brand-600 ring-offset-1'
                          : slot.available
                            ? 'bg-white text-ink-800 border border-ink-200 hover:border-brand-500 hover:bg-brand-50/40'
                            : 'bg-ink-100 text-ink-400 border border-transparent cursor-not-allowed line-through opacity-60'
                      }`}
                    >
                      {slot.timeStr}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedSlot ? (
              <p className="mt-2 text-xs text-brand-700 font-medium">
                ✓ Selected time: {selectedSlot.timeStr} ({formatTabLabel(details.serviceDate)})
              </p>
            ) : null}
          </div>

          {/* Emergency Mode Selector */}
          <div className={cn(
            'rounded-xl border p-4 transition-all',
            isEmergency ? 'border-2 border-red-500 bg-red-50/70 shadow-sm' : 'border-red-200 bg-red-50/40 hover:bg-red-50/70'
          )}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl shrink-0">🚨</span>
                <div>
                  <p className="text-sm font-bold text-red-950">Is this a Medical Emergency?</p>
                  <p className="text-xs text-red-800">
                    Flagged directly to clinic reception as high-priority emergency.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsEmergency(!isEmergency)}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden',
                  isEmergency ? 'bg-red-600' : 'bg-ink-300'
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out',
                    isEmergency ? 'translate-x-5' : 'translate-x-0'
                  )}
                />
              </button>
            </div>

            {isEmergency ? (
              <div className="mt-4 space-y-3 pt-3 border-t border-red-200 animate-in fade-in duration-200">
                <p className="text-xs font-bold text-red-900 uppercase tracking-wider">
                  Select Primary Reason (1-Tap):
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {EMERGENCY_REASONS.map((r) => {
                    const isSelected = emergencyReason === r.label;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setEmergencyReason(r.label)}
                        className={cn(
                          'flex items-center gap-2 rounded-lg p-2.5 text-left text-xs font-medium transition-all cursor-pointer',
                          isSelected
                            ? 'bg-red-600 text-white font-bold shadow-xs ring-2 ring-red-600'
                            : 'bg-white text-red-950 border border-red-200 hover:bg-red-100/60'
                        )}
                      >
                        <span className="text-base shrink-0">{r.icon}</span>
                        <span className="truncate">{r.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-2">
                  <label className="block text-xs font-medium text-red-900 mb-1">
                    Describe condition or symptoms (optional):
                  </label>
                  <textarea
                    rows={2}
                    className="w-full rounded-lg border border-red-200 bg-white p-2.5 text-xs text-ink-900 placeholder:text-ink-400 focus:border-red-600 focus:outline-hidden focus:ring-1 focus:ring-red-600"
                    placeholder="e.g. Severe chest pain spreading to left arm since 20 mins"
                    value={emergencyNotes}
                    onChange={(e) => setEmergencyNotes(e.target.value)}
                    maxLength={500}
                  />
                </div>

                <div className="rounded-lg bg-red-100/80 border border-red-300 p-2.5 text-[11px] text-red-900 leading-snug">
                  ⚠️ <strong>Critical Advisory:</strong> If the patient is unresponsive, bleeding severely, or in acute distress, call 108 or proceed straight to Casualty/ICU immediately.
                </div>
              </div>
            ) : null}
          </div>

          {/* Patient Details */}
          <div className="space-y-4 border-t border-ink-100 pt-5">
            <h3 className="text-sm font-semibold text-ink-900">Patient Details</h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <Field label="Full Name">
                  <Input
                    type="text"
                    value={patientName}
                    onChange={(e) => setPatientName(e.target.value)}
                    placeholder="e.g. Ramesh Patil"
                    required
                  />
                </Field>
              </div>
              <div>
                <Field label="Age (years)">
                  <Input
                    type="number"
                    min="0"
                    max="125"
                    value={patientAge}
                    onChange={(e) => setPatientAge(e.target.value)}
                    placeholder="e.g. 35"
                  />
                </Field>
              </div>
            </div>

            <Field label="WhatsApp / Mobile Number">
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. 98765 43210"
                required
              />
            </Field>
          </div>

          <div className={cn(
            'rounded-lg p-3 text-xs',
            isEmergency ? 'bg-red-50 text-red-900 border border-red-200' : 'bg-ink-50 text-ink-600'
          )}>
            {isEmergency
              ? `🚨 Emergency Alert: Dr. ${details.doctor.name} and hospital reception will be notified immediately of this emergency booking.`
              : `💡 Dr. ${details.doctor.name} will be notified immediately of your appointment for ${formatTabLabel(details.serviceDate)}.`}
          </div>

          <Button
            type="submit"
            variant={isEmergency ? 'danger' : 'primary'}
            size="lg"
            className={cn('w-full', isEmergency && 'bg-red-600 hover:bg-red-700 font-bold')}
            disabled={isPending || !selectedSlot || isClosed}
            isLoading={isPending}
            title={isClosed ? 'OPD closed today — book tomorrow instead.' : undefined}
          >
            {isClosed
              ? 'OPD closed today — book tomorrow instead.'
              : isPending
                ? 'Scheduling Appointment...'
                : isEmergency
                  ? `🚨 Confirm Emergency Visit for ${formatTabLabel(details.serviceDate)}`
                  : `Confirm Appointment for ${formatTabLabel(details.serviceDate)}`}
          </Button>
        </form>
      </Card>
    </div>
  );
}
