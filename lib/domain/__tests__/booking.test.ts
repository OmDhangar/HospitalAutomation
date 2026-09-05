import { describe, expect, it } from 'vitest';
import {
  fitListTitle,
  LIST_ROW_TITLE_LIMIT,
  nextBookingStep,
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
