import { describe, expect, it } from 'vitest';
import { capacityAt, describeOrigin, maskPhone, traceVerdict, type CapacityChange } from '../booking-trace';

const d = (iso: string) => new Date(iso);

describe('describeOrigin', () => {
  it('tells desk, WhatsApp chat and booking page apart', () => {
    expect(describeOrigin({ source: 'walk_in', scheduledSlotAt: null, confirmedInChat: false })).toBe('desk_walk_in');
    expect(describeOrigin({ source: 'reception', scheduledSlotAt: d('2026-10-08T14:40:00Z'), confirmedInChat: false })).toBe('desk_slot');
    expect(describeOrigin({ source: 'whatsapp', scheduledSlotAt: null, confirmedInChat: true })).toBe('whatsapp_queue');
    expect(describeOrigin({ source: 'whatsapp', scheduledSlotAt: d('2026-10-08T08:40:00Z'), confirmedInChat: true })).toBe('whatsapp_slot');
    expect(describeOrigin({ source: 'whatsapp', scheduledSlotAt: d('2026-10-08T08:40:00Z'), confirmedInChat: false })).toBe('web_slot');
  });
});

describe('capacityAt', () => {
  const changes: CapacityChange[] = [
    { at: d('2026-10-05T12:00:00Z'), before: { walkInReserved: 0, quota: null }, after: { walkInReserved: 20, quota: 70 } },
    { at: d('2026-10-07T12:00:00Z'), before: { walkInReserved: 20, quota: 70 }, after: { walkInReserved: 25, quota: 80 } },
  ];
  const current = { walkInReserved: 25, quota: 80 };

  it('uses the last change before the booking', () => {
    expect(capacityAt(changes, current, d('2026-10-06T03:00:00Z'))).toMatchObject({ walkInReserved: 20, source: 'change_log' });
  });

  it('before any change, uses what the first change replaced', () => {
    expect(capacityAt(changes, current, d('2026-10-02T03:00:00Z'))).toMatchObject({ walkInReserved: 0, quota: null });
  });

  it('with no history, falls back to the current settings and says so', () => {
    expect(capacityAt([], current, d('2026-10-02T03:00:00Z'))).toMatchObject({ walkInReserved: 25, source: 'current' });
  });
});

describe('traceVerdict', () => {
  const base = { sessionKind: 'queue' as const, quotaPool: 'shared' as const, reserveAtBooking: 20, queueLinkSentToPhone: false };

  it('flags an online token inside the reserve as a fault', () => {
    const v = traceVerdict({ ...base, origin: 'whatsapp_queue', tokenNumber: 3, quotaPool: null });
    expect(v[0]).toMatchObject({ level: 'fault' });
    expect(v[0].message).toContain('1–20');
  });

  it('passes an online token above the reserve', () => {
    expect(traceVerdict({ ...base, origin: 'whatsapp_queue', tokenNumber: 21 })[0].level).toBe('ok');
  });

  it('a desk walk-in on a reserved number is correct, and the WhatsApp link is explained', () => {
    const v = traceVerdict({ ...base, origin: 'desk_walk_in', tokenNumber: 3, quotaPool: 'reserved', queueLinkSentToPhone: true });
    expect(v.map((x) => x.level)).toEqual(['ok', 'note']);
    expect(v[1].message).toContain('does not mean they booked online');
  });

  it('slot-session numbers never break the reserve', () => {
    const v = traceVerdict({ ...base, origin: 'whatsapp_slot', tokenNumber: 3, sessionKind: 'slot', quotaPool: null });
    expect(v.every((x) => x.level !== 'fault')).toBe(true);
  });
});

describe('maskPhone', () => {
  it('keeps the country code and the last two digits', () => {
    expect(maskPhone('+919404313273')).toBe('+91 94043 •••73');
  });
});
