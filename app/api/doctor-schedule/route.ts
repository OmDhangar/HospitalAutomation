import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { serviceDateIn } from '@/lib/domain/time';
import { blockIntervalAndNotify, previewDisruption } from '@/lib/services/disruption';
import {
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

    /**
     * How many people this would affect, without affecting them.
     *
     * Cancelling a morning of appointments is not undone by pressing the
     * button again — the WhatsApp messages have already gone. The count is
     * shown first so the decision is made with it in view.
     */
    if (action === 'preview_interval') {
      const { serviceDate, startTime, endTime } = body;
      const summary = await previewDisruption({
        hospitalId: session.hospitalId,
        doctorId,
        serviceDate,
        startTime,
        endTime,
      });
      return NextResponse.json({ ok: true, summary });
    }

    if (action === 'add_interval') {
      const { serviceDate, startTime, endTime, reason } = body;

      /**
       * Blocks the window AND deals with everyone already booked inside it.
       *
       * The previous implementation called addIntervalBlock, which only stops
       * new bookings — patients already holding slots in the window kept a
       * live appointment and were told nothing, then travelled to the hospital
       * for a doctor who had gone.
       */
      const outcome = await blockIntervalAndNotify({
        hospitalId: session.hospitalId,
        doctorId,
        serviceDate,
        startTime,
        endTime,
        reason: reason || 'Emergency / Temporary Unavailability',
        actorUserId: session.userId,
      });

      return NextResponse.json({
        ok: true,
        message: outcome.message,
        blockId: outcome.blockId,
        summary: outcome.summary,
        // Patients already in the waiting room, for reception to speak to.
        needsDeskAction: outcome.needsDeskAction,
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
