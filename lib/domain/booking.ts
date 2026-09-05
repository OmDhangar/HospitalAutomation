import { isLocale, type Locale } from '@/lib/i18n/patient';

export type ConversationState =
  | 'idle'
  | 'awaiting_language'
  | 'awaiting_doctor'
  | 'awaiting_slot';

export type BookingContext = {
  locale?: Locale;
  doctorId?: string;
  slot?: string;
};

/**
 * What the business sends next. Every variant except `none` costs one billable
 * WhatsApp message, so the shape of this union is the shape of the cost model.
 */
export type BookingStep =
  | { kind: 'ask_language' }
  | { kind: 'ask_doctor' }
  | { kind: 'ask_slot'; doctorId: string }
  | { kind: 'confirm'; doctorId: string; slot: string }
  | { kind: 'none' };

export type InboundMessage = {
  /** Reply id from an interactive list or button, e.g. "doc:<uuid>". */
  replyId?: string;
  text?: string;
};

export type BookingTransition = {
  state: ConversationState;
  context: BookingContext;
  step: BookingStep;
};

const parseReply = (replyId: string | undefined) => {
  if (!replyId) return null;
  const separator = replyId.indexOf(':');
  if (separator === -1) return null;
  return {
    prefix: replyId.slice(0, separator),
    value: replyId.slice(separator + 1),
  };
};

/**
 * Drives a WhatsApp booking conversation.
 *
 * Pure on purpose: the number of billable messages a booking costs is decided
 * entirely here, so it can be asserted in a test rather than discovered on an
 * invoice.
 *
 * The key economy is `knownLocale`. Language is a property of the patient, not
 * of the conversation, so a returning patient skips the language question
 * entirely and their booking costs three messages instead of four.
 */
export function nextBookingStep(args: {
  state: ConversationState;
  context: BookingContext;
  message: InboundMessage;
  knownLocale: Locale | null;
  /** Doctors the patient may pick from, used to reject stale or forged ids. */
  availableDoctorIds: string[];
}): BookingTransition {
  const { context, message, knownLocale, availableDoctorIds } = args;
  const reply = parseReply(message.replyId);

  if (reply?.prefix === 'lang' && isLocale(reply.value)) {
    return {
      state: 'awaiting_doctor',
      context: { ...context, locale: reply.value },
      step: { kind: 'ask_doctor' },
    };
  }

  if (reply?.prefix === 'doc' && availableDoctorIds.includes(reply.value)) {
    return {
      state: 'awaiting_slot',
      context: { ...context, doctorId: reply.value },
      step: { kind: 'ask_slot', doctorId: reply.value },
    };
  }

  if (reply?.prefix === 'slot' && context.doctorId) {
    return {
      state: 'idle',
      context: { ...context, slot: reply.value },
      step: { kind: 'confirm', doctorId: context.doctorId, slot: reply.value },
    };
  }

  // Anything else — a greeting, free text, a stale button — restarts cleanly.
  const locale = context.locale ?? knownLocale ?? undefined;
  if (!locale) {
    return {
      state: 'awaiting_language',
      context: { ...context, doctorId: undefined, slot: undefined },
      step: { kind: 'ask_language' },
    };
  }

  return {
    state: 'awaiting_doctor',
    context: { locale, doctorId: undefined, slot: undefined },
    step: { kind: 'ask_doctor' },
  };
}

/**
 * How long an identical prompt is considered already answered.
 *
 * Re-sending a menu the patient already has adds nothing: WhatsApp keeps the
 * previous list tappable in the thread, so an impatient second "Hi" is best
 * answered by the message already sitting on their screen. Two minutes covers
 * double-taps and impatience without stranding someone who genuinely returns
 * later.
 */
export const PROMPT_COOLDOWN_SECONDS = 120;

/**
 * The most prompts one phone number can trigger in a day.
 *
 * A real booking takes three. Twelve leaves room for a confused patient to
 * restart several times, and stops a bored or malicious sender from running up
 * a WhatsApp bill by messaging the number in a loop. Past the cap we go quiet
 * rather than replying "too many messages" — that reply would itself cost.
 */
export const DAILY_PROMPT_CAP = 12;

export type PromptDecision =
  | { send: true }
  | { send: false; reason: 'duplicate' | 'daily_cap' };

/**
 * Whether a prompt is worth the money it costs.
 *
 * Confirmations are exempt from both rules: a patient who has completed a
 * booking must always be told, and the one-active-token constraint already
 * prevents that happening twice.
 */
export function shouldSendPrompt(args: {
  step: BookingStep['kind'];
  lastPromptStep: string | null;
  lastPromptAt: Date | null;
  promptsToday: number;
  now: Date;
}): PromptDecision {
  if (args.step === 'confirm' || args.step === 'none') return { send: true };

  if (args.promptsToday >= DAILY_PROMPT_CAP) {
    return { send: false, reason: 'daily_cap' };
  }

  if (args.step === args.lastPromptStep && args.lastPromptAt) {
    const elapsed = (args.now.getTime() - args.lastPromptAt.getTime()) / 1000;
    if (elapsed < PROMPT_COOLDOWN_SECONDS) return { send: false, reason: 'duplicate' };
  }

  return { send: true };
}

/**
 * Meta caps interactive list row titles at 24 characters. Devanagari reaches
 * that far sooner than Latin, so labels are truncated here rather than being
 * rejected by the API at send time.
 */
export const LIST_ROW_TITLE_LIMIT = 24;

export function fitListTitle(title: string): string {
  const trimmed = title.trim();
  if ([...trimmed].length <= LIST_ROW_TITLE_LIMIT) return trimmed;
  return `${[...trimmed].slice(0, LIST_ROW_TITLE_LIMIT - 1).join('')}…`;
}
