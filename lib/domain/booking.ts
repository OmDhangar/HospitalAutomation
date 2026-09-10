import { isLocale, type Locale } from '@/lib/i18n/patient';

export type DoctorScheduleMode = 'queue' | 'slot' | 'both';

export type DoctorWithMode = {
  id: string;
  name: string;
  specialty?: string | null;
  mode: DoctorScheduleMode;
};

export type PatientProfile = {
  id: string;
  name: string;
  age?: number | null;
  gender?: string | null;
};

export type ConversationState =
  | 'idle'
  | 'awaiting_language'
  | 'awaiting_active_choice'
  | 'awaiting_patient_choice'
  | 'awaiting_patient_name_age'
  | 'awaiting_doctor'
  | 'awaiting_queue_choice'
  | 'awaiting_slot';

export type BookingContext = {
  locale?: Locale;
  doctorId?: string;
  slot?: string;
  queueChoice?: 'join' | 'wait_time';
  patientId?: string;
  patientName?: string;
  patientAge?: number;
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
  | { kind: 'ask_patient_choice'; patients: PatientProfile[] }
  | { kind: 'ask_patient_name_age' }
  | { kind: 'ask_doctor' }
  | { kind: 'ask_queue_branch'; doctorId: string }
  | { kind: 'show_queue_wait_time'; doctorId: string }
  | { kind: 'ask_slot'; doctorId: string }
  | { kind: 'confirm_queue'; doctorId: string; patientName?: string; patientAge?: number }
  | { kind: 'confirm_slot'; doctorId: string; slot: string; patientName?: string; patientAge?: number }
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

/**
 * Extracts patient name and optional age from inputs like:
 * - "Aarav Sharma 7" -> { name: "Aarav Sharma", age: 7 }
 * - "Priya Patil, 28" -> { name: "Priya Patil", age: 28 }
 * - "Ramesh 45 yrs" -> { name: "Ramesh", age: 45 }
 * - "सुरेश पाटील ३२" -> { name: "सुरेश पाटील", age: 32 }
 */
export function parsePatientNameAge(rawText: string): { name: string; age?: number } | null {
  if (!rawText || !rawText.trim()) return null;
  let text = rawText.trim();

  // Normalize Devanagari numerals: ०-९ to 0-9
  const devanagariDigits = '०१२३४५६७८९';
  text = text.replace(/[०-९]/g, (d) => String(devanagariDigits.indexOf(d)));

  // Match patterns like "Name, 32", "Name 32", "Name 32y", "Name 32 yrs", "Name (32)"
  const ageMatch = text.match(/(?:,\s*|\s+|\(|\b)(\d{1,3})\s*(?:y(?:ears?|rs?)?|वर्षे?|साल)?\)?$/i);
  if (ageMatch && ageMatch.index !== undefined) {
    const ageNum = parseInt(ageMatch[1], 10);
    const namePart = text.slice(0, ageMatch.index).trim().replace(/[,(]+$/, '').trim();
    if (namePart.length > 0 && ageNum >= 0 && ageNum <= 125) {
      return { name: namePart, age: ageNum };
    }
  }

  // Fallback: entire text is name if no valid trailing age
  const cleanedName = text.replace(/[,]+$/, '').trim();
  if (cleanedName.length > 0) {
    return { name: cleanedName };
  }

  return null;
}

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
  /** Saved patient profiles for this phone number. */
  knownPatients?: PatientProfile[];
}): BookingTransition {
  const { context, message, knownLocale, activeAppointment, knownPatients } = args;
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
    if (knownPatients && knownPatients.length > 0) {
      return {
        state: 'awaiting_patient_choice',
        context: { locale, doctorId: undefined, slot: undefined, queueChoice: undefined },
        step: { kind: 'ask_patient_choice', patients: knownPatients },
      };
    }
    return {
      state: 'awaiting_doctor',
      context: { locale, doctorId: undefined, slot: undefined, queueChoice: undefined },
      step: { kind: 'ask_doctor' },
    };
  }

  // 3. Patient profile / name & age input handling
  if (reply?.prefix === 'patient') {
    if (reply.value === 'new') {
      return {
        state: 'awaiting_patient_name_age',
        context: { ...context, patientId: undefined, patientName: undefined, patientAge: undefined },
        step: { kind: 'ask_patient_name_age' },
      };
    }

    const selectedProfile = knownPatients?.find((p) => p.id === reply.value);
    if (selectedProfile) {
      return {
        state: 'awaiting_doctor',
        context: {
          ...context,
          patientId: selectedProfile.id,
          patientName: selectedProfile.name,
          patientAge: selectedProfile.age ?? undefined,
        },
        step: { kind: 'ask_doctor' },
      };
    }
  }

  if (args.state === 'awaiting_patient_name_age' && message.text && !reply) {
    const parsed = parsePatientNameAge(message.text);
    if (parsed) {
      return {
        state: 'awaiting_doctor',
        context: {
          ...context,
          patientName: parsed.name,
          patientAge: parsed.age,
          patientId: undefined,
        },
        step: { kind: 'ask_doctor' },
      };
    }
  }

  // 4. Interactive reply handling
  if (reply?.prefix === 'lang' && isLocale(reply.value)) {
    if (knownPatients && knownPatients.length > 0) {
      return {
        state: 'awaiting_patient_choice',
        context: { ...context, locale: reply.value },
        step: { kind: 'ask_patient_choice', patients: knownPatients },
      };
    }
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
        // Direct queue booking without extra intermediate arrival questions
        return {
          state: 'idle',
          context: { ...context, doctorId: doctorObj.id, queueChoice: 'join' },
          step: {
            kind: 'confirm_queue',
            doctorId: doctorObj.id,
            patientName: context.patientName,
            patientAge: context.patientAge,
          },
        };
      } else if (doctorObj.mode === 'both') {
        // Hybrid: offer choice between today's live queue vs scheduled slot
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
        step: {
          kind: 'confirm_queue',
          doctorId: context.doctorId,
          patientName: context.patientName,
          patientAge: context.patientAge,
        },
      };
    }
    if (reply.value === 'slot' || reply.value === 'wait') {
      return {
        state: 'awaiting_slot',
        context: { ...context, slot: undefined },
        step: { kind: 'ask_slot', doctorId: context.doctorId },
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
      step: {
        kind: 'confirm_slot',
        doctorId: context.doctorId,
        slot: reply.value,
        patientName: context.patientName,
        patientAge: context.patientAge,
      },
    };
  }

  // 5. Free text / Greeting / Starting fresh when patient HAS an active unfulfilled appointment
  if (activeAppointment && !reply) {
    return {
      state: 'awaiting_active_choice',
      context,
      step: { kind: 'ask_active_choice', appointment: activeAppointment },
    };
  }

  // 6. Anything else — a greeting, free text, returning patient without active appointment
  const locale = context.locale ?? knownLocale ?? undefined;
  if (!locale) {
    return {
      state: 'awaiting_language',
      context: { ...context, doctorId: undefined, slot: undefined, queueChoice: undefined },
      step: { kind: 'ask_language' },
    };
  }

  if (knownPatients && knownPatients.length > 0 && !context.patientName && !context.patientId) {
    return {
      state: 'awaiting_patient_choice',
      context: { locale, doctorId: undefined, slot: undefined, queueChoice: undefined },
      step: { kind: 'ask_patient_choice', patients: knownPatients },
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

