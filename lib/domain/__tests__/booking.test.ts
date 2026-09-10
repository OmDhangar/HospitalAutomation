import { describe, expect, it } from 'vitest';
import {
  DAILY_PROMPT_CAP,
  fitListTitle,
  LIST_ROW_TITLE_LIMIT,
  nextBookingStep,
  PROMPT_COOLDOWN_SECONDS,
  shouldSendPrompt,
  type BookingContext,
  type BookingStep,
  type ConversationState,
  type DoctorWithMode,
} from '../booking';

const DOCTORS: DoctorWithMode[] = [
  { id: 'doc-a', name: 'Dr Kulkarni', mode: 'queue' },
  { id: 'doc-b', name: 'Dr Mehta', mode: 'slot' },
];

/** Replays a whole conversation and reports what the business had to send. */
function runConversation(args: {
  knownLocale: 'mr' | 'hi' | 'en' | null;
  inbound: Array<{ replyId?: string; text?: string }>;
}) {
  let state: ConversationState = 'idle';
  let context: BookingContext = {};
  const sent: BookingStep['kind'][] = [];

  for (const message of args.inbound) {
    const result = nextBookingStep({
      state,
      context,
      message,
      knownLocale: args.knownLocale,
      availableDoctors: DOCTORS,
    });
    state = result.state;
    context = result.context;
    if (result.step.kind !== 'none') sent.push(result.step.kind);
  }

  return { state, context, sent };
}

describe('booking conversation', () => {
  it('branches to queue choices for queue-mode doctor', () => {
    const { sent, context } = runConversation({
      knownLocale: null,
      inbound: [
        { text: 'Hi' },
        { replyId: 'lang:mr' },
        { replyId: 'doc:doc-a' },
        { replyId: 'queue_choice:join' },
      ],
    });

    expect(sent).toEqual(['ask_language', 'ask_doctor', 'ask_queue_branch', 'confirm_queue']);
    expect(context.locale).toBe('mr');
    expect(context.doctorId).toBe('doc-a');
  });

  it('branches directly to slot selection for slot-mode doctor', () => {
    const { sent, context } = runConversation({
      knownLocale: 'mr',
      inbound: [{ text: 'Hi' }, { replyId: 'doc:doc-b' }, { replyId: 'slot:10:30' }],
    });

    expect(sent).toEqual(['ask_doctor', 'ask_slot', 'confirm_slot']);
    expect(sent).toHaveLength(3);
  });

  it('shows wait time without issuing a token when patient picks "See wait time first"', () => {
    const result = nextBookingStep({
      state: 'awaiting_queue_choice',
      context: { locale: 'en', doctorId: 'doc-a' },
      message: { replyId: 'queue_choice:wait' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
    });

    expect(result.step.kind).toBe('show_queue_wait_time');
    expect(result.state).toBe('awaiting_queue_choice');
  });

  it('issues token when patient explicitly picks "Join queue now" after seeing wait time', () => {
    const result = nextBookingStep({
      state: 'awaiting_queue_choice',
      context: { locale: 'en', doctorId: 'doc-a', queueChoice: 'wait_time' },
      message: { replyId: 'queue_choice:join' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
    });

    expect(result.step.kind).toBe('confirm_queue');
    expect(result.state).toBe('idle');
  });

  it('never sends more than four messages, however confused the patient gets', () => {
    const { sent } = runConversation({
      knownLocale: 'hi',
      inbound: [
        { text: 'hello' },
        { text: 'kya' },
        { text: '???' },
        { replyId: 'doc:doc-b' },
        { replyId: 'slot:11:00' },
      ],
    });

    expect(sent.filter((kind) => kind === 'confirm_slot')).toHaveLength(1);
    expect(sent.every((kind) => kind !== 'ask_language')).toBe(true);
  });

  it('rejects a doctor id that is not on offer', () => {
    const result = nextBookingStep({
      state: 'awaiting_doctor',
      context: { locale: 'en' },
      message: { replyId: 'doc:someone-elses-doctor' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
    });

    expect(result.step.kind).toBe('ask_doctor');
    expect(result.context.doctorId).toBeUndefined();
  });

  it('redirects to web slot booking when patient selects slot:later', () => {
    const result = nextBookingStep({
      state: 'awaiting_slot',
      context: { locale: 'en', doctorId: 'doc-b' },
      message: { replyId: 'slot:later' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
    });

    expect(result.step.kind).toBe('redirect_web_slot');
    if (result.step.kind === 'redirect_web_slot') {
      expect(result.step.doctorId).toBe('doc-b');
    }
  });

  describe('active appointment flow', () => {
    const mockAppt = {
      id: 'appt-123',
      tokenNumber: 5,
      doctorName: 'Dr Kulkarni',
      doctorId: 'doc-a',
      status: 'WAITING',
      publicToken: 'tok-abc',
      serviceDate: '2026-09-08',
    };

    it('presents ask_active_choice when patient with active appointment sends greeting', () => {
      const result = nextBookingStep({
        state: 'idle',
        context: { locale: 'en' },
        message: { text: 'Hi' },
        knownLocale: 'en',
        availableDoctors: DOCTORS,
        activeAppointment: mockAppt,
      });

      expect(result.step.kind).toBe('ask_active_choice');
      expect(result.state).toBe('awaiting_active_choice');
    });

    it('shows active appointment details when patient selects active_appt:view', () => {
      const result = nextBookingStep({
        state: 'awaiting_active_choice',
        context: { locale: 'en' },
        message: { replyId: 'active_appt:view' },
        knownLocale: 'en',
        availableDoctors: DOCTORS,
        activeAppointment: mockAppt,
      });

      expect(result.step.kind).toBe('show_active_appointment');
      if (result.step.kind === 'show_active_appointment') {
        expect(result.step.appointment.tokenNumber).toBe(5);
        expect(result.step.appointment.publicToken).toBe('tok-abc');
      }
    });

    it('routes to new booking doctor selection when patient selects active_appt:new_booking', () => {
      const result = nextBookingStep({
        state: 'awaiting_active_choice',
        context: { locale: 'en' },
        message: { replyId: 'active_appt:new_booking' },
        knownLocale: 'en',
        availableDoctors: DOCTORS,
        activeAppointment: mockAppt,
      });

      expect(result.step.kind).toBe('ask_doctor');
      expect(result.state).toBe('awaiting_doctor');
    });
  });
});

describe('interactive list titles', () => {
  it('leaves short Latin labels alone', () => {
    expect(fitListTitle('Dr Kulkarni')).toBe('Dr Kulkarni');
  });

  it('truncates by character, not byte, so Devanagari is not mangled', () => {
    const long = 'डॉक्टर कुलकर्णी सामान्य वैद्यकशास्त्र विभाग';
    const fitted = fitListTitle(long);
    expect([...fitted].length).toBeLessThanOrEqual(LIST_ROW_TITLE_LIMIT);
    expect(fitted.endsWith('…')).toBe(true);
  });
});

describe('prompt suppression', () => {
  const now = new Date('2026-09-05T10:00:00Z');
  const secondsAgo = (n: number) => new Date(now.getTime() - n * 1000);

  const decide = (over: Partial<Parameters<typeof shouldSendPrompt>[0]> = {}) =>
    shouldSendPrompt({
      step: 'ask_language',
      lastPromptStep: null,
      lastPromptAt: null,
      promptsToday: 0,
      now,
      ...over,
    });

  it('sends the first prompt', () => {
    expect(decide()).toEqual({ send: true });
  });

  it('does not repeat a menu the patient already has', () => {
    expect(
      decide({ lastPromptStep: 'ask_language', lastPromptAt: secondsAgo(5) }),
    ).toEqual({ send: false, reason: 'duplicate' });
  });

  it('never suppresses a queue or slot confirmation', () => {
    expect(
      decide({
        step: 'confirm_queue',
        lastPromptStep: 'confirm_queue',
        lastPromptAt: secondsAgo(1),
        promptsToday: 999,
      }),
    ).toEqual({ send: true });

    expect(
      decide({
        step: 'confirm_slot',
        lastPromptStep: 'confirm_slot',
        lastPromptAt: secondsAgo(1),
        promptsToday: 999,
      }),
    ).toEqual({ send: true });
  });
});
