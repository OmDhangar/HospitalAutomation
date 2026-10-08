import { describe, expect, it } from 'vitest';
import {
  dayStartAt,
  effectiveMode,
  isLiveQueueOpen,
  liveQueueClosesAt,
  runsOwnList,
  sessionForSlot,
  slotNumber,
  toDaySessions,
  validateSessions,
  type SessionConfig,
} from '../sessions';
import { zonedTimeToUtc } from '../time';

const DATE = '2026-10-08';
const TZ = 'Asia/Kolkata';
const at = (time: string) => zonedTimeToUtc(DATE, time, TZ);

const queue: SessionConfig = { mode: 'queue', startTime: '12:00', endTime: '19:00', slotMinutes: 10 };
const evening: SessionConfig = { mode: 'slot', startTime: '20:00', endTime: '22:00', slotMinutes: 10 };
const hybrid = toDaySessions([evening, queue], DATE, TZ);

describe('validateSessions', () => {
  it('accepts the hybrid day', () => {
    expect(validateSessions([queue, evening])).toEqual([]);
  });

  it('rejects overlaps, inverted times and a second live queue', () => {
    expect(validateSessions([queue, { ...evening, startTime: '18:30' }])).toContain('Sessions must not overlap.');
    expect(validateSessions([{ ...queue, endTime: '11:00' }])).toContain('Session 1: must end after it starts.');
    expect(validateSessions([queue, { ...queue, startTime: '20:00', endTime: '21:00' }])).toContain(
      'Only one session can run the live queue.',
    );
    expect(validateSessions([])).toContain('Add at least one session.');
  });

  it('rejects a slot length out of range', () => {
    expect(validateSessions([{ ...evening, slotMinutes: 2 }])).toHaveLength(1);
  });
});

describe('hybrid day', () => {
  it('sorts sessions and starts the day at the live queue', () => {
    expect(hybrid.map((s) => s.mode)).toEqual(['queue', 'slot']);
    expect(dayStartAt(hybrid)).toEqual(at('12:00'));
  });

  it('closes the live queue at 7pm, and offers slots only after', () => {
    expect(liveQueueClosesAt(hybrid)).toEqual(at('19:00'));
    expect(isLiveQueueOpen(hybrid, at('18:59'))).toBe(true);
    expect(isLiveQueueOpen(hybrid, at('19:00'))).toBe(false);
    expect(effectiveMode(hybrid, at('11:00'))).toBe('both');
    expect(effectiveMode(hybrid, at('19:30'))).toBe('slot');
  });

  it('a plain queue day never closes, so existing hospitals are unaffected', () => {
    const plain = toDaySessions([queue], DATE, TZ);
    expect(liveQueueClosesAt(plain)).toBeNull();
    expect(isLiveQueueOpen(plain, at('23:00'))).toBe(true);
    expect(effectiveMode(plain, at('23:00'))).toBe('queue');
  });

  it('numbers evening slots S1, S2… by time', () => {
    expect(slotNumber(hybrid, at('20:00'))).toBe(1);
    expect(slotNumber(hybrid, at('20:10'))).toBe(2);
    expect(slotNumber(hybrid, at('21:50'))).toBe(12);
    // Not a slot start, outside the session, or in the live queue session.
    expect(slotNumber(hybrid, at('20:05'))).toBeNull();
    expect(slotNumber(hybrid, at('22:00'))).toBeNull();
    expect(slotNumber(hybrid, at('13:00'))).toBeNull();
  });

  it('numbers continue across several slot sessions', () => {
    const two = toDaySessions(
      [evening, { mode: 'slot', startTime: '08:00', endTime: '09:00', slotMinutes: 15 }],
      DATE,
      TZ,
    );
    expect(slotNumber(two, at('08:45'))).toBe(4);
    expect(slotNumber(two, at('20:00'))).toBe(5);
  });

  it('a single slot-only day keeps the classic booking, without S-numbers', () => {
    const only = toDaySessions([evening], DATE, TZ);
    expect(slotNumber(only, at('20:00'))).toBeNull();
    expect(runsOwnList(only, only[0])).toBe(false);
    expect(runsOwnList(hybrid, hybrid[1])).toBe(true);
  });

  it('finds the session a slot belongs to', () => {
    expect(sessionForSlot(hybrid, at('20:30'))?.mode).toBe('slot');
    expect(sessionForSlot(hybrid, at('13:00'))).toBeNull();
  });
});
