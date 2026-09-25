'use client';

// Client helper wrappers calling server endpoint or server actions for scheduling

export async function fetchDoctorScheduleData(doctorId: string, serviceDate?: string) {
  const res = await fetch(`/api/doctor-schedule?doctorId=${encodeURIComponent(doctorId)}&date=${encodeURIComponent(serviceDate || '')}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch schedule' }));
    throw new Error(err.error || 'Failed to fetch schedule');
  }
  return res.json();
}

export async function saveScheduleConfigApi(payload: {
  doctorId: string;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
  mode?: 'queue' | 'slot' | 'both';
}) {
  const res = await fetch('/api/doctor-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save_config', ...payload }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Failed to save schedule configuration');
  }
  return data;
}

export async function toggleSlotOverrideApi(payload: {
  doctorId: string;
  serviceDate: string;
  slotTime: string;
  isAvailable: boolean;
  reason?: string;
}) {
  const res = await fetch('/api/doctor-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'toggle_slot', ...payload }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Failed to update slot status');
  }
  return data;
}

export type DisruptionSummaryDto = {
  cancelled: number;
  needsDeskAction: number;
  leftAlone: number;
};

/**
 * Counts who a block would affect, changing nothing.
 *
 * Read-only by design so the confirmation the user sees is generated from the
 * same rules that will run a moment later, rather than from a guess made in
 * the browser.
 */
export async function previewIntervalApi(payload: {
  doctorId: string;
  serviceDate: string;
  startTime: string;
  endTime: string;
}): Promise<{ summary: DisruptionSummaryDto }> {
  const res = await fetch('/api/doctor-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'preview_interval', ...payload }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Failed to check which appointments are affected');
  }
  return data;
}

/**
 * Blocks the window and handles everyone booked inside it.
 *
 * Returns the server's summary sentence. The caller shows that rather than
 * inventing its own: what the user needs to know is what happened to patients,
 * not that a time range changed colour.
 */
export async function addIntervalBlockApi(payload: {
  doctorId: string;
  serviceDate: string;
  startTime: string;
  endTime: string;
  reason?: string;
}): Promise<{
  message: string;
  blockId: string;
  summary: DisruptionSummaryDto;
  needsDeskAction: Array<{
    appointmentId: string;
    patientName: string;
    phoneE164: string | null;
    tokenNumber: number | null;
  }>;
}> {
  const res = await fetch('/api/doctor-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add_interval', ...payload }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Failed to add emergency interval block');
  }
  return data;
}

export async function removeIntervalBlockApi(payload: { doctorId: string; blockId: string }) {
  const res = await fetch('/api/doctor-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove_interval', ...payload }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Failed to remove interval block');
  }
  return data;
}
