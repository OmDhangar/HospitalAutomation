'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import type { Locale } from '@/lib/i18n/patient';
import type { DoctorBookingDetails, TimeSlot } from '@/lib/services/web-booking';
import { submitSlotBooking, type BookSlotResult } from './actions';

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

      const res = await submitSlotBooking(formData);
      if (res.ok) {
        setSuccess(res);
      } else {
        setError(res.error);
      }
    });
  };

  if (success) {
    return (
      <div className="mx-auto max-w-lg">
        <Card className="border-brand-200 bg-white shadow-[var(--shadow-raised)]">
          <div className="bg-brand-50 px-6 py-5 border-b border-brand-100 text-center">
            <span className="inline-flex items-center justify-center size-12 rounded-full bg-brand-600 text-white font-bold text-xl mb-2">
              ✓
            </span>
            <h2 className="text-xl font-bold text-ink-900">Appointment Confirmed!</h2>
            <p className="text-xs text-brand-800 mt-1">
              Your appointment slot has been successfully scheduled
            </p>
          </div>

          <div className="p-6 space-y-5">
            <div className="rounded-xl bg-ink-50 p-4 border border-ink-200 text-center">
              <p className="text-xs font-medium text-ink-500 uppercase tracking-wider">
                Your Token Number
              </p>
              <p className="numeric text-5xl font-bold text-brand-700 mt-1">
                {success.tokenNumber}
              </p>
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-900">
                <span>🕒</span>
                <span>
                  Date: {details.serviceDate} · Time: {success.slotTimeFormatted}
                </span>
              </div>
            </div>

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

            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 leading-relaxed">
              <p className="font-medium">Notification Sent to Clinic:</p>
              <p className="mt-0.5">
                Dr. {success.doctorName} and hospital staff have been informed of your appointment
                slot for {details.serviceDate}.
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
          {error ? <Alert tone="error">{error}</Alert> : null}

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
              {[todayStr, tomorrowStr, dayAfterStr].map((dStr) => (
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
              ))}

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

            {details.slots.length === 0 ? (
              <div className="rounded-lg bg-ink-50 p-4 text-center border border-ink-200">
                <p className="text-xs font-medium text-ink-600">
                  No available slots for {formatTabLabel(details.serviceDate)}.
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

          <div className="rounded-lg bg-ink-50 p-3 text-xs text-ink-600">
            💡 Dr. {details.doctor.name} will be notified immediately of your appointment for {formatTabLabel(details.serviceDate)}.
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="w-full"
            disabled={isPending || !selectedSlot}
            isLoading={isPending}
          >
            {isPending ? 'Confirming Appointment...' : `Confirm Appointment for ${formatTabLabel(details.serviceDate)}`}
          </Button>
        </form>
      </Card>
    </div>
  );
}
