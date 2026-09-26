import { describe, expect, it } from 'vitest';
import {
  isCancellableByPatient,
  disruptionActionFor,
  disruptionMessage,
  minutesOfDayIn,
  slotIsInBlock,
  summarise,
} from '../disruption';
import { APPOINTMENT_STATUSES } from '../types';

describe('disruptionActionFor', () => {
  const now = new Date('2026-09-26T09:00:00+05:30');
  const laterToday = new Date('2026-09-26T10:20:00+05:30');
  const earlierToday = new Date('2026-09-26T08:20:00+05:30');

  it('cancels and messages patients who have not arrived', () => {
    expect(disruptionActionFor({ status: 'CREATED', now })).toBe('cancel_and_notify');
    expect(disruptionActionFor({ status: 'CONFIRMED', now })).toBe('cancel_and_notify');
  });

  it('messages an online booking whose slot has not come round yet', () => {
    /**
     * The regression this signature exists for.
     *
     * `bookScheduledSlot` writes WAITING the moment a slot is booked, so a
     * patient who booked 10:20 from home is WAITING hours before they leave
     * the house. Reading that as presence classified every online booking as
     * "already at the hospital", and the emergency-unavailability feature
     * notified nobody at all — the people it exists for were the only ones it
     * never reached.
     */
    expect(
      disruptionActionFor({ status: 'WAITING', scheduledSlotAt: laterToday, now }),
    ).toBe('cancel_and_notify');
  });

  it('treats a walk-in as present, because it has no slot to be early for', () => {
    expect(disruptionActionFor({ status: 'WAITING', scheduledSlotAt: null, now })).toBe(
      'needs_desk_action',
    );
    expect(disruptionActionFor({ status: 'WAITING', now })).toBe('needs_desk_action');
  });

  it('treats a booked slot whose time has arrived as present', () => {
    // Past their own slot and still WAITING: they are most likely in the
    // building, so this stays a conversation for the desk.
    expect(
      disruptionActionFor({ status: 'WAITING', scheduledSlotAt: earlierToday, now }),
    ).toBe('needs_desk_action');
  });

  it('never auto-cancels a patient the desk has already dealt with', () => {
    /**
     * The rule that matters most, and it still beats scheduling: a future slot
     * time does not override an explicit signal that somebody is here.
     */
    for (const status of ['ARRIVED', 'HELD', 'SKIPPED'] as const) {
      expect(disruptionActionFor({ status, scheduledSlotAt: laterToday, now })).toBe(
        'needs_desk_action',
      );
    }
  });

  it('leaves alone anyone already with the doctor', () => {
    expect(disruptionActionFor({ status: 'CALLED', now })).toBe('leave_alone');
    expect(disruptionActionFor({ status: 'IN_CONSULTATION', now })).toBe('leave_alone');
  });

  it('leaves terminal appointments untouched', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] as const) {
      expect(disruptionActionFor({ status, scheduledSlotAt: laterToday, now })).toBe(
        'leave_alone',
      );
    }
  });

  it('has a decision for every status in the state machine', () => {
    // A status added later without a rule here would otherwise fall through
    // and silently do nothing to a real patient's appointment.
    for (const status of APPOINTMENT_STATUSES) {
      expect(['cancel_and_notify', 'needs_desk_action', 'leave_alone']).toContain(
        disruptionActionFor({ status, scheduledSlotAt: laterToday, now }),
      );
    }
  });

  it('cancels only the three not-yet-here cases, and only ahead of the slot', () => {
    const cancelled = APPOINTMENT_STATUSES.filter(
      (s) =>
        disruptionActionFor({ status: s, scheduledSlotAt: laterToday, now }) ===
        'cancel_and_notify',
    );
    expect(cancelled).toEqual(['CREATED', 'CONFIRMED', 'WAITING']);

    // Without a booked slot in the future, WAITING drops back out.
    const walkIns = APPOINTMENT_STATUSES.filter(
      (s) => disruptionActionFor({ status: s, now }) === 'cancel_and_notify',
    );
    expect(walkIns).toEqual(['CREATED', 'CONFIRMED']);
  });
});

describe('slotIsInBlock', () => {
  // 13:00–14:30
  const window = { blockStartMinutes: 780, blockEndMinutes: 870 };

  it('catches a slot at the start of the window', () => {
    expect(slotIsInBlock({ slotMinutes: 780, ...window })).toBe(true);
  });

  it('catches a slot inside the window', () => {
    expect(slotIsInBlock({ slotMinutes: 825, ...window })).toBe(true);
  });

  it('leaves the slot exactly at the end of the window alone', () => {
    /**
     * Half-open on purpose. A doctor who says "back by 2:30" means the 2:30
     * appointment is one they intend to keep, and cancelling it would cancel
     * an appointment that was never in doubt.
     */
    expect(slotIsInBlock({ slotMinutes: 870, ...window })).toBe(false);
  });

  it('leaves slots outside the window alone', () => {
    expect(slotIsInBlock({ slotMinutes: 779, ...window })).toBe(false);
    expect(slotIsInBlock({ slotMinutes: 900, ...window })).toBe(false);
  });
});

describe('minutesOfDayIn', () => {
  it('reads the wall clock in the hospital timezone, not UTC', () => {
    // 08:30 UTC is 14:00 in Kolkata.
    const at = new Date('2026-09-24T08:30:00Z');
    expect(minutesOfDayIn('Asia/Kolkata', at)).toBe(14 * 60);
    expect(minutesOfDayIn('UTC', at)).toBe(8 * 60 + 30);
  });

  it('is correct for a timezone that is not IST', () => {
    /**
     * The slot generator in scheduling.ts hardcodes a +05:30 offset. This
     * deliberately does not, so a hospital outside India does not silently
     * cancel the wrong appointments.
     */
    const at = new Date('2026-09-24T08:30:00Z');
    expect(minutesOfDayIn('Asia/Dubai', at)).toBe(12 * 60 + 30);
    expect(minutesOfDayIn('America/New_York', at)).toBe(4 * 60 + 30);
  });

  it('renders midnight as zero, not 1440', () => {
    const at = new Date('2026-09-23T18:30:00Z'); // 00:00 IST on the 24th
    expect(minutesOfDayIn('Asia/Kolkata', at)).toBe(0);
  });

  it('handles a half-hour offset without drift across the day', () => {
    for (const hour of [0, 6, 12, 18, 23]) {
      const at = new Date(Date.UTC(2026, 8, 24, hour, 0, 0));
      const minutes = minutesOfDayIn('Asia/Kolkata', at);
      expect(minutes).toBe((hour * 60 + 330) % 1440);
    }
  });
});

describe('summarise and disruptionMessage', () => {
  it('counts each action', () => {
    const summary = summarise([
      'cancel_and_notify',
      'cancel_and_notify',
      'needs_desk_action',
      'leave_alone',
    ]);
    expect(summary).toEqual({ cancelled: 2, needsDeskAction: 1, leftAlone: 1 });
  });

  it('says plainly that nobody was affected', () => {
    const text = disruptionMessage({ cancelled: 0, needsDeskAction: 0, leftAlone: 0 });
    expect(text).toBe('No upcoming bookings were affected.');
  });

  it('reports what happened to real people, not just the window', () => {
    // The existing UI says "13:00 to 14:30 is now unavailable", which reads as
    // though the problem is handled while patients have been told nothing.
    const text = disruptionMessage({ cancelled: 4, needsDeskAction: 0, leftAlone: 2 });
    expect(text).toContain('4 bookings cancelled');
    expect(text).toContain('messaged to rebook');
  });

  it('surfaces what is still owed at the desk', () => {
    const text = disruptionMessage({ cancelled: 1, needsDeskAction: 2, leftAlone: 0 });
    expect(text).toContain('1 booking cancelled');
    expect(text).toContain('2 patients are already waiting');
    expect(text).toContain('speak to them at the desk');
  });

  it('reads correctly in the singular', () => {
    const text = disruptionMessage({ cancelled: 1, needsDeskAction: 1, leftAlone: 0 });
    expect(text).toContain('1 booking cancelled');
    expect(text).toContain('patient is already waiting');
    expect(text).not.toContain('bookings');
  });
});

describe('isCancellableByPatient', () => {
  it('allows cancelling right up to the consultation starting', () => {
    /**
     * Deliberately permissive. A patient who cancels ten minutes out is doing
     * the hospital a favour — that slot becomes bookable again, where a
     * no-show helps nobody. Making cancellation awkward does not produce
     * attendance, it produces no-shows.
     */
    for (const status of [
      'CREATED',
      'CONFIRMED',
      'ARRIVED',
      'WAITING',
      'HELD',
      'SKIPPED',
      'CALLED',
    ] as const) {
      expect(isCancellableByPatient(status), status).toBe(true);
    }
  });

  it('stops once the appointment has actually happened', () => {
    for (const status of ['IN_CONSULTATION', 'COMPLETED'] as const) {
      expect(isCancellableByPatient(status), status).toBe(false);
    }
  });

  it('refuses to re-cancel or resurrect a closed appointment', () => {
    for (const status of ['CANCELLED', 'NO_SHOW', 'EXPIRED'] as const) {
      expect(isCancellableByPatient(status), status).toBe(false);
    }
  });

  it('has a decision for every status in the state machine', () => {
    for (const status of APPOINTMENT_STATUSES) {
      expect(typeof isCancellableByPatient(status)).toBe('boolean');
    }
  });

  it('never offers cancellation on an appointment that is already closed', () => {
    /**
     * The real invariant, and the only one these two rules share.
     *
     * They are otherwise independent, because they answer questions about
     * different actors. `disruptionActionFor` decides what the *system* may do
     * on the doctor's behalf, and leaves CALLED alone because that patient may
     * be standing at the consulting room door. `isCancellableByPatient` decides
     * what the *patient* may do about their own appointment, and permits
     * CALLED precisely because a patient who is cancelling is evidently not
     * there. Requiring the two to agree would be wrong.
     */
    const TERMINAL = ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] as const;

    for (const status of APPOINTMENT_STATUSES) {
      if (!isCancellableByPatient(status)) continue;
      expect(TERMINAL, `${status} is offered as cancellable`).not.toContain(status);
    }
  });

  it('differs from the doctor-unavailability rule at CALLED, on purpose', () => {
    // Pinned so the divergence is a decision rather than a later accident.
    expect(isCancellableByPatient('CALLED')).toBe(true);
    expect(disruptionActionFor({ status: 'CALLED' })).toBe('leave_alone');
  });
});
