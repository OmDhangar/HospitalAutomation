import { isLocale, type Locale } from '@/lib/i18n/patient';

export type DoctorScheduleMode = 'queue' | 'slot';

export type DoctorWithMode = {
  id: string;
  name: string;
  specialty?: string | null;
  mode: DoctorScheduleMode;
};

export type ConversationState =
  | 'idle'
  | 'awaiting_language'
  | 'awaiting_active_choice'
  | 'awaiting_doctor'
  | 'awaiting_queue_choice'
  | 'awaiting_slot';

export type BookingContext = {
  locale?: Locale;
  doctorId?: string;
  slot?: string;
  queueChoice?: 'join' | 'wait_time';
};

export type ActiveAppointmentInfo = {
  id: string;
  tokenNumber: number;
  doctorName: string;
  doctorId: string;
  status: string;
  publicToken: string;
  serviceDate: string;
};

/**
 * What the business sends next. Every variant except `none` costs one billable
 * WhatsApp message, so the shape of this union is the shape of the cost model.
 */
export type BookingStep =
  | { kind: 'ask_language' }
  | { kind: 'ask_active_choice'; appointment: ActiveAppointmentInfo }
  | { kind: 'show_active_appointment'; appointment: ActiveAppointmentInfo }
  | { kind: 'ask_doctor' }
  | { kind: 'ask_queue_branch'; doctorId: string }
  | { kind: 'show_queue_wait_time'; doctorId: string }
  | { kind: 'ask_slot'; doctorId: string }
  | { kind: 'confirm_queue'; doctorId: string }
  | { kind: 'confirm_slot'; doctorId: string; slot: string }
  | { kind: 'redirect_web_slot'; doctorId: string }
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

const KEYWORD_STATUS_REGEX = /^(status|link|queue|token|view|appointment|अपॉइंटमेंट|कतार|रांग)/i;

/**
 * Drives a WhatsApp booking conversation.
 *
 * Pure on purpose: the number of billable messages a booking costs is decided
 * entirely here, so it can be asserted in a test rather than discovered on an
 * invoice.
 */
export function nextBookingStep(args: {
  state: ConversationState;
  context: BookingContext;
  message: InboundMessage;
  knownLocale: Locale | null;
  /** Doctors the patient may pick from, with optional daily schedule mode. */
  availableDoctorIds?: string[];
  availableDoctors?: Array<string | DoctorWithMode>;
  /** Active unfulfilled appointment for this patient if one exists. */
  activeAppointment?: ActiveAppointmentInfo | null;
}): BookingTransition {
  const { context, message, knownLocale, activeAppointment } = args;
  const rawDoctors = args.availableDoctors ?? args.availableDoctorIds ?? [];
  const doctors: DoctorWithMode[] = rawDoctors.map((d) =>
    typeof d === 'string' ? { id: d, name: d, mode: 'queue' } : d,
  );

  const reply = parseReply(message.replyId);

  // 1. Explicit request to view active appointment (via interactive reply or keyword)
  if (reply?.prefix === 'active_appt' && reply.value === 'view') {
    if (activeAppointment) {
      return {
        state: 'idle',
        context,
        step: { kind: 'show_active_appointment', appointment: activeAppointment },
      };
    }
  }

  if (activeAppointment && message.text && KEYWORD_STATUS_REGEX.test(message.text.trim())) {
    return {
      state: 'idle',
      context,
      step: { kind: 'show_active_appointment', appointment: activeAppointment },
    };
  }

  // 2. Explicit request to start new booking when active appointment exists
  if (reply?.prefix === 'active_appt' && reply.value === 'new_booking') {
    const locale = context.locale ?? knownLocale ?? undefined;
    if (!locale) {
      return {
        state: 'awaiting_language',
        context: { ...context, doctorId: undefined, slot: undefined, queueChoice: undefined },
        step: { kind: 'ask_language' },
      };
    }
    return {
      state: 'awaiting_doctor',
      context: { locale, doctorId: undefined, slot: undefined, queueChoice: undefined },
      step: { kind: 'ask_doctor' },
    };
  }

  // 3. Interactive reply handling
  if (reply?.prefix === 'lang' && isLocale(reply.value)) {
    return {
      state: 'awaiting_doctor',
      context: { ...context, locale: reply.value },
      step: { kind: 'ask_doctor' },
    };
  }

  if (reply?.prefix === 'doc') {
    const doctorObj = doctors.find((d) => d.id === reply.value);
    if (doctorObj) {
      if (doctorObj.mode === 'queue') {
        return {
          state: 'awaiting_queue_choice',
          context: { ...context, doctorId: doctorObj.id, queueChoice: undefined },
          step: { kind: 'ask_queue_branch', doctorId: doctorObj.id },
        };
      } else {
        return {
          state: 'awaiting_slot',
          context: { ...context, doctorId: doctorObj.id, slot: undefined },
          step: { kind: 'ask_slot', doctorId: doctorObj.id },
        };
      }
    }
  }

  if (reply?.prefix === 'queue_choice' && context.doctorId) {
    if (reply.value === 'join') {
      return {
        state: 'idle',
        context: { ...context, queueChoice: 'join' },
        step: { kind: 'confirm_queue', doctorId: context.doctorId },
      };
    }
    if (reply.value === 'wait') {
      return {
        state: 'awaiting_queue_choice',
        context: { ...context, queueChoice: 'wait_time' },
        step: { kind: 'show_queue_wait_time', doctorId: context.doctorId },
      };
    }
  }

  if (reply?.prefix === 'slot' && context.doctorId) {
    if (reply.value === 'later') {
      return {
        state: 'idle',
        context: { ...context, slot: reply.value },
        step: { kind: 'redirect_web_slot', doctorId: context.doctorId },
      };
    }

    return {
      state: 'idle',
      context: { ...context, slot: reply.value },
      step: { kind: 'confirm_slot', doctorId: context.doctorId, slot: reply.value },
    };
  }

  // 4. Free text / Greeting / Starting fresh when patient HAS an active unfulfilled appointment
  if (activeAppointment && !reply) {
    return {
      state: 'awaiting_active_choice',
      context,
      step: { kind: 'ask_active_choice', appointment: activeAppointment },
    };
  }

  // 5. Anything else — a greeting, free text, returning patient without active appointment
  const locale = context.locale ?? knownLocale ?? undefined;
  if (!locale) {
    return {
      state: 'awaiting_language',
      context: { ...context, doctorId: undefined, slot: undefined, queueChoice: undefined },
      step: { kind: 'ask_language' },
    };
  }

  return {
    state: 'awaiting_doctor',
    context: { locale, doctorId: undefined, slot: undefined, queueChoice: undefined },
    step: { kind: 'ask_doctor' },
  };
}

/**
 * How long an identical prompt is considered already answered.
 */
export const PROMPT_COOLDOWN_SECONDS = 120;

/**
 * The most prompts one phone number can trigger in a day.
 */
export const DAILY_PROMPT_CAP = 12;

export type PromptDecision =
  | { send: true }
  | { send: false; reason: 'duplicate' | 'daily_cap' };

export function shouldSendPrompt(args: {
  step: BookingStep['kind'];
  lastPromptStep: string | null;
  lastPromptAt: Date | null;
  promptsToday: number;
  now: Date;
}): PromptDecision {
  if (
    args.step === 'confirm_queue' ||
    args.step === 'confirm_slot' ||
    args.step === 'redirect_web_slot' ||
    args.step === 'show_active_appointment' ||
    args.step === 'show_queue_wait_time' ||
    args.step === 'none'
  ) {
    return { send: true };
  }

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
 * Meta caps interactive list row titles at 24 characters.
 */
export const LIST_ROW_TITLE_LIMIT = 24;

export function fitListTitle(title: string): string {
  const trimmed = title.trim();
  if ([...trimmed].length <= LIST_ROW_TITLE_LIMIT) return trimmed;
  return `${[...trimmed].slice(0, LIST_ROW_TITLE_LIMIT - 1).join('')}…`;
}
