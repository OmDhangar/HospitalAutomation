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

export async function addIntervalBlockApi(payload: {
  doctorId: string;
  serviceDate: string;
  startTime: string;
  endTime: string;
  reason?: string;
}) {
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
