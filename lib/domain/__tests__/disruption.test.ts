import { describe, expect, it } from 'vitest';
import {
  disruptionActionFor,
  disruptionMessage,
  minutesOfDayIn,
  slotIsInBlock,
  summarise,
} from '../disruption';
import { APPOINTMENT_STATUSES } from '../types';

describe('disruptionActionFor', () => {
  it('cancels and messages patients who have not arrived', () => {
    expect(disruptionActionFor('CREATED')).toBe('cancel_and_notify');
    expect(disruptionActionFor('CONFIRMED')).toBe('cancel_and_notify');
  });

  it('never auto-cancels a patient who is already in the building', () => {
    /**
     * The rule that matters most. Sending "please book another day" to
     * somebody sitting fifteen feet from the reception desk is worse than
     * saying nothing — those conversations only go well in person.
     */
    expect(disruptionActionFor('ARRIVED')).toBe('needs_desk_action');
    expect(disruptionActionFor('WAITING')).toBe('needs_desk_action');
    expect(disruptionActionFor('HELD')).toBe('needs_desk_action');
    expect(disruptionActionFor('SKIPPED')).toBe('needs_desk_action');
  });

  it('leaves alone anyone already with the doctor', () => {
    expect(disruptionActionFor('CALLED')).toBe('leave_alone');
    expect(disruptionActionFor('IN_CONSULTATION')).toBe('leave_alone');
  });

  it('leaves terminal appointments untouched', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED'] as const) {
      expect(disruptionActionFor(status)).toBe('leave_alone');
    }
  });

  it('has a decision for every status in the state machine', () => {
    // A status added later without a rule here would otherwise fall through
    // and silently do nothing to a real patient's appointment.
    for (const status of APPOINTMENT_STATUSES) {
      expect(['cancel_and_notify', 'needs_desk_action', 'leave_alone']).toContain(
        disruptionActionFor(status),
      );
    }
  });

  it('cancels only two of the twelve statuses', () => {
    const cancelled = APPOINTMENT_STATUSES.filter(
      (s) => disruptionActionFor(s) === 'cancel_and_notify',
    );
    expect(cancelled).toEqual(['CREATED', 'CONFIRMED']);
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
