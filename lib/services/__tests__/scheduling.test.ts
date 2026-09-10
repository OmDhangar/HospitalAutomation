import { describe, expect, it } from 'vitest';
import {
  generateRawSlots,
  minutesTo24HTime,
  minutesToFormattedTime,
  timeStringToMinutes,
} from '../scheduling';

describe('Doctor Appointment Scheduling Engine', () => {
  it('converts time strings and minutes accurately', () => {
    expect(timeStringToMinutes('10:00')).toBe(600);
    expect(timeStringToMinutes('14:30')).toBe(870);
    expect(minutesToFormattedTime(600)).toBe('10:00 AM');
    expect(minutesToFormattedTime(870)).toBe('2:30 PM');
    expect(minutesTo24HTime(870)).toBe('14:30');
  });

  it('generates correct slot intervals for 20 minute consultation duration', () => {
    const slots = generateRawSlots({
      startTime: '10:00',
      endTime: '12:00',
      slotMinutes: 20,
    });

    expect(slots.length).toBe(6);
    expect(slots.map((s) => s.timeFormatted)).toEqual([
      '10:00 AM',
      '10:20 AM',
      '10:40 AM',
      '11:00 AM',
      '11:20 AM',
      '11:40 AM',
    ]);
  });

  it('generates correct slot intervals for 15, 30, and 60 minute durations', () => {
    const slots15 = generateRawSlots({
      startTime: '10:00',
      endTime: '11:00',
      slotMinutes: 15,
    });
    expect(slots15.length).toBe(4);

    const slots30 = generateRawSlots({
      startTime: '10:00',
      endTime: '12:00',
      slotMinutes: 30,
    });
    expect(slots30.length).toBe(4);
    expect(slots30[0].timeFormatted).toBe('10:00 AM');
    expect(slots30[1].timeFormatted).toBe('10:30 AM');

    const slots60 = generateRawSlots({
      startTime: '10:00',
      endTime: '13:00',
      slotMinutes: 60,
    });
    expect(slots60.length).toBe(3);
  });

  it('flags break/lunch time slots correctly', () => {
    const slots = generateRawSlots({
      startTime: '10:00',
      endTime: '15:00',
      slotMinutes: 30,
      breakStartTime: '13:00',
      breakEndTime: '14:00',
    });

    const breakSlots = slots.filter((s) => s.isBreak);
    expect(breakSlots.length).toBe(2);
    expect(breakSlots.map((s) => s.timeFormatted)).toEqual(['1:00 PM', '1:30 PM']);
  });
});
