import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { serviceDateIn } from '@/lib/domain/time';
import {
  addIntervalBlock,
  getDoctorSlotsForDate,
  removeIntervalBlock,
  saveDoctorScheduleConfig,
  toggleSlotOverride,
} from '@/lib/services/scheduling';

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const { searchParams } = new URL(request.url);
    const doctorId = searchParams.get('doctorId');
    const dateParam = searchParams.get('date');

    if (!doctorId) {
      return NextResponse.json({ error: 'Doctor ID is required' }, { status: 400 });
    }

    const serviceDate = dateParam || serviceDateIn(session.timezone, new Date());
    const result = await getDoctorSlotsForDate({
      hospitalId: session.hospitalId,
      doctorId,
      serviceDate,
    });

    return NextResponse.json({ ok: true, data: result, serviceDate });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unauthorized or error occurred';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = await request.json();
    const { action, doctorId } = body;

    if (!doctorId) {
      return NextResponse.json({ error: 'Doctor ID is required' }, { status: 400 });
    }

    if (action === 'save_config') {
      const { startTime, endTime, slotMinutes, breakStartTime, breakEndTime, mode } = body;
      await saveDoctorScheduleConfig({
        hospitalId: session.hospitalId,
        doctorId,
        startTime,
        endTime,
        slotMinutes: Number(slotMinutes) || 15,
        breakStartTime: breakStartTime || null,
        breakEndTime: breakEndTime || null,
        mode: mode || 'slot',
      });
      return NextResponse.json({ ok: true, message: 'Schedule configuration saved successfully' });
    }

    if (action === 'toggle_slot') {
      const { serviceDate, slotTime, isAvailable, reason } = body;
      await toggleSlotOverride({
        hospitalId: session.hospitalId,
        doctorId,
        serviceDate,
        slotTime,
        isAvailable: Boolean(isAvailable),
        reason: reason || null,
      });
      return NextResponse.json({ ok: true, message: 'Slot status updated successfully' });
    }

    if (action === 'add_interval') {
      const { serviceDate, startTime, endTime, reason } = body;
      const row = await addIntervalBlock({
        hospitalId: session.hospitalId,
        doctorId,
        serviceDate,
        startTime,
        endTime,
        reason: reason || 'Emergency / Temporary Unavailability',
      });
      return NextResponse.json({
        ok: true,
        message: 'Interval blocked successfully',
        block: row,
      });
    }

    if (action === 'remove_interval') {
      const { blockId } = body;
      await removeIntervalBlock({
        hospitalId: session.hospitalId,
        doctorId,
        blockId,
      });
      return NextResponse.json({ ok: true, message: 'Interval block removed successfully' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to perform schedule operation';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
