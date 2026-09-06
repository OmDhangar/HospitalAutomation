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
} from '../booking';

const DOCTORS = ['doc-a', 'doc-b'];

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
      availableDoctorIds: DOCTORS,
    });
    state = result.state;
    context = result.context;
    if (result.step.kind !== 'none') sent.push(result.step.kind);
  }

  return { state, context, sent };
}

describe('booking conversation', () => {
  it('costs a first-time patient four messages including the language question', () => {
    const { sent, context } = runConversation({
      knownLocale: null,
      inbound: [
        { text: 'Hi' },
        { replyId: 'lang:mr' },
        { replyId: 'doc:doc-a' },
        { replyId: 'slot:10:30' },
      ],
    });

    expect(sent).toEqual(['ask_language', 'ask_doctor', 'ask_slot', 'confirm']);
    expect(context.locale).toBe('mr');
    expect(context.doctorId).toBe('doc-a');
  });

  /**
   * The economy the whole cost model rests on. Language is stored against the
   * patient, so every visit after the first skips that question.
   */
  it('costs a returning patient three, by never asking for language again', () => {
    const { sent } = runConversation({
      knownLocale: 'mr',
      inbound: [{ text: 'Hi' }, { replyId: 'doc:doc-a' }, { replyId: 'slot:10:30' }],
    });

    expect(sent).toEqual(['ask_doctor', 'ask_slot', 'confirm']);
    expect(sent).toHaveLength(3);
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

    // Restarts are cheap but not free; what matters is that a confused patient
    // cannot drive the conversation into an unbounded number of sends.
    expect(sent.filter((kind) => kind === 'confirm')).toHaveLength(1);
    expect(sent.every((kind) => kind !== 'ask_language')).toBe(true);
  });

  it('rejects a doctor id that is not on offer', () => {
    const result = nextBookingStep({
      state: 'awaiting_doctor',
      context: { locale: 'en' },
      message: { replyId: 'doc:someone-elses-doctor' },
      knownLocale: 'en',
      availableDoctorIds: DOCTORS,
    });

    // Falls back to asking again rather than booking against a forged id.
    expect(result.step.kind).toBe('ask_doctor');
    expect(result.context.doctorId).toBeUndefined();
  });

  it('ignores a slot reply that arrives without a doctor chosen', () => {
    const result = nextBookingStep({
      state: 'idle',
      context: { locale: 'en' },
      message: { replyId: 'slot:10:00' },
      knownLocale: 'en',
      availableDoctorIds: DOCTORS,
    });

    expect(result.step.kind).toBe('ask_doctor');
  });

  it('starts over cleanly when a patient returns days later', () => {
    const result = nextBookingStep({
      state: 'awaiting_slot',
      context: { locale: 'mr', doctorId: 'doc-a' },
      message: { text: 'Hi' },
      knownLocale: 'mr',
      availableDoctorIds: DOCTORS,
    });

    expect(result.step.kind).toBe('ask_doctor');
    expect(result.context.doctorId).toBeUndefined();
    expect(result.context.locale).toBe('mr');
  });

  it('redirects to web slot booking when patient selects slot:later', () => {
    const result = nextBookingStep({
      state: 'awaiting_slot',
      context: { locale: 'en', doctorId: 'doc-a' },
      message: { replyId: 'slot:later' },
      knownLocale: 'en',
      availableDoctorIds: DOCTORS,
    });

    expect(result.step.kind).toBe('redirect_web');
    if (result.step.kind === 'redirect_web') {
      expect(result.step.doctorId).toBe('doc-a');
    }
  });

  it('confirms appointment directly when patient selects slot:now', () => {
    const result = nextBookingStep({
      state: 'awaiting_slot',
      context: { locale: 'en', doctorId: 'doc-a' },
      message: { replyId: 'slot:now' },
      knownLocale: 'en',
      availableDoctorIds: DOCTORS,
    });

    expect(result.step.kind).toBe('confirm');
    if (result.step.kind === 'confirm') {
      expect(result.step.doctorId).toBe('doc-a');
      expect(result.step.slot).toBe('now');
    }
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

  it('keeps a label that is exactly at the limit', () => {
    const exact = 'a'.repeat(LIST_ROW_TITLE_LIMIT);
    expect(fitListTitle(exact)).toBe(exact);
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

  /**
   * The case that costs real money: a patient tapping "Hi" five times used to
   * buy five identical menus, because each tap is a distinct Meta message id
   * and so slipped past replay protection.
   */
  it('does not repeat a menu the patient already has', () => {
    expect(
      decide({ lastPromptStep: 'ask_language', lastPromptAt: secondsAgo(5) }),
    ).toEqual({ send: false, reason: 'duplicate' });
  });

  it('sends again once the cooldown has passed', () => {
    expect(
      decide({
        lastPromptStep: 'ask_language',
        lastPromptAt: secondsAgo(PROMPT_COOLDOWN_SECONDS + 1),
      }),
    ).toEqual({ send: true });
  });

  it('still answers when the patient moves on to a different step', () => {
    // Progress must never be blocked — only repetition.
    expect(
      decide({ step: 'ask_doctor', lastPromptStep: 'ask_language', lastPromptAt: secondsAgo(1) }),
    ).toEqual({ send: true });
  });

  it('goes quiet once a sender passes the daily cap', () => {
    expect(decide({ promptsToday: DAILY_PROMPT_CAP })).toEqual({
      send: false,
      reason: 'daily_cap',
    });
  });

  it('never suppresses a booking confirmation', () => {
    // A patient who completed a booking must always be told, whatever else
    // they have been doing.
    expect(
      decide({
        step: 'confirm',
        lastPromptStep: 'confirm',
        lastPromptAt: secondsAgo(1),
        promptsToday: 999,
      }),
    ).toEqual({ send: true });
  });

  it('caps a spammer at the daily limit however many times they message', () => {
    let sent = 0;
    for (let i = 0; i < 500; i += 1) {
      // Alternating steps defeats the cooldown; only the cap stops this.
      const step = i % 2 === 0 ? 'ask_language' : 'ask_doctor';
      const decision = shouldSendPrompt({
        step,
        lastPromptStep: i % 2 === 0 ? 'ask_doctor' : 'ask_language',
        lastPromptAt: secondsAgo(1),
        promptsToday: sent,
        now,
      });
      if (decision.send) sent += 1;
    }
    expect(sent).toBe(DAILY_PROMPT_CAP);
  });
});
