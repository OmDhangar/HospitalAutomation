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
  /** The sender chose "Myself": book under their own name. */
  patientSelf?: boolean;
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

/** States in which the patient has already said who the appointment is for. */
const PATIENT_CHOSEN_STATES: ReadonlySet<ConversationState> = new Set([
  'awaiting_doctor',
  'awaiting_queue_choice',
  'awaiting_slot',
]);

const hasPatient = (context: BookingContext): boolean =>
  Boolean(context.patientId || context.patientName || context.patientSelf);

/**
 * "Who is this appointment for?" — asked on every booking, the first included.
 *
 * It used to be skipped for a number with no saved patients, which booked the
 * first appointment under the WhatsApp sender whether or not they were the
 * patient. A parent booking for a child, or a son booking for his father, had
 * no way to say so until their second booking. With no saved profiles the
 * list offers "Myself" and "Someone else"; with saved profiles it lists them
 * plus "Add new patient".
 *
 * Starts a fresh context: the language survives, nothing else does.
 */
const askPatient = (
  locale: Locale,
  knownPatients: PatientProfile[] | undefined,
): BookingTransition => ({
  state: 'awaiting_patient_choice',
  context: { locale },
  step: { kind: 'ask_patient_choice', patients: knownPatients ?? [] },
});

/** What happens once a doctor is known, whether the patient picked them or not. */
function chooseDoctor(doctor: DoctorWithMode, context: BookingContext): BookingTransition {
  if (doctor.mode === 'queue') {
    // Direct queue booking without extra intermediate arrival questions
    return {
      state: 'idle',
      context: { ...context, doctorId: doctor.id, queueChoice: 'join' },
      step: {
        kind: 'confirm_queue',
        doctorId: doctor.id,
        patientName: context.patientName,
        patientAge: context.patientAge,
      },
    };
  }
  if (doctor.mode === 'both') {
    // Hybrid: offer choice between today's live queue vs scheduled slot
    return {
      state: 'awaiting_queue_choice',
      context: { ...context, doctorId: doctor.id, queueChoice: undefined },
      step: { kind: 'ask_queue_branch', doctorId: doctor.id },
    };
  }
  return {
    state: 'awaiting_slot',
    context: { ...context, doctorId: doctor.id, slot: undefined },
    step: { kind: 'ask_slot', doctorId: doctor.id },
  };
}

/**
 * The doctor menu, unless there is nothing to choose.
 *
 * A one-doctor clinic asking "which doctor?" is a billable message whose only
 * possible answer is already known. Every message that follows names the
 * doctor, so the patient still learns who they are booked with.
 */
function pickDoctor(doctors: DoctorWithMode[], context: BookingContext): BookingTransition {
  if (doctors.length === 1) return chooseDoctor(doctors[0], context);
  return {
    state: 'awaiting_doctor',
    context: { ...context, doctorId: undefined, slot: undefined, queueChoice: undefined },
    step: { kind: 'ask_doctor' },
  };
}

/**
 * Drives a WhatsApp booking conversation.
 *
 * Pure on purpose: the number of billable messages a booking costs is decided
 * entirely here, so it can be asserted in a test rather than discovered on an
 * invoice.
 *
 * Free text never books anything. Only an explicit reply — a patient, a doctor,
 * a queue or slot choice, or a name with an age typed in answer to "who is
 * this for?" — can reach a confirmation. That matters most for a one-doctor clinic, where the
 * step after choosing a patient may be the booking itself.
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
    return askPatient(locale, knownPatients);
  }

  // 3. Patient profile / name & age input handling
  if (reply?.prefix === 'patient') {
    if (reply.value === 'new') {
      return {
        state: 'awaiting_patient_name_age',
        context: {
          ...context,
          patientId: undefined,
          patientName: undefined,
          patientAge: undefined,
          patientSelf: undefined,
        },
        step: { kind: 'ask_patient_name_age' },
      };
    }

    if (reply.value === 'self') {
      // The sender is the patient. Their name is resolved at booking time —
      // the record on file, else their WhatsApp profile name — because this
      // function sees neither.
      return pickDoctor(doctors, {
        ...context,
        patientId: undefined,
        patientName: undefined,
        patientAge: undefined,
        patientSelf: true,
      });
    }

    const selectedProfile = knownPatients?.find((p) => p.id === reply.value);
    if (selectedProfile) {
      return pickDoctor(doctors, {
        ...context,
        patientId: selectedProfile.id,
        patientName: selectedProfile.name,
        patientAge: selectedProfile.age ?? undefined,
        patientSelf: undefined,
      });
    }
  }

  if (message.text && !reply) {
    const parsed = parsePatientNameAge(message.text);
    /**
     * Booking for someone else in one message: the patient list invites the
     * sender to type the name and age straight back, which saves the "please
     * send the patient's name" prompt that tapping "Someone else" costs.
     *
     * At the list itself, the age is what makes it a name. "Hi", "ok" and
     * "hello" all parse as names too, and with a one-doctor clinic the next
     * step after a name is the booking — so without an age the text is
     * treated as chatter, not as a patient called "Hi".
     */
    const isPatientName =
      args.state === 'awaiting_patient_name_age' ||
      (args.state === 'awaiting_patient_choice' && parsed?.age !== undefined);

    if (parsed && isPatientName) {
      return pickDoctor(doctors, {
        ...context,
        patientName: parsed.name,
        patientAge: parsed.age,
        patientId: undefined,
        patientSelf: undefined,
      });
    }
  }

  // 4. Interactive reply handling
  if (reply?.prefix === 'lang' && isLocale(reply.value)) {
    return askPatient(reply.value, knownPatients);
  }

  if (reply?.prefix === 'doc') {
    const doctorObj = doctors.find((d) => d.id === reply.value);
    if (doctorObj) return chooseDoctor(doctorObj, context);
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

  // Mid-booking with the patient already chosen: repeat the doctor menu and
  // keep the patient, rather than making them choose again. Not with a single
  // doctor, where "repeating the menu" would mean booking on free text.
  if (PATIENT_CHOSEN_STATES.has(args.state) && hasPatient(context) && doctors.length > 1) {
    return pickDoctor(doctors, context);
  }

  // Idle, or a booking abandoned part-way: a greeting starts a new booking,
  // and a new booking starts with who it is for.
  return askPatient(locale, knownPatients);
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

/**
 * Strips doctor prefixes (e.g. "Dr.", "Dr ", "डॉ.", "डॉ ") to avoid accidental
 * double titles like "Dr. Dr Rohan" when rendering templates or freeform text.
 */
export function cleanDoctorName(name: string): string {
  if (!name) return '';
  return name.trim().replace(/^(?:(?:dr\.?|डॉ\.?)\s*)+/i, '').trim();
}

/**
 * Formats a doctor's display name cleanly with the appropriate localized title prefix.
 */
export function formatDoctorName(name: string, locale: Locale = 'en'): string {
  const cleaned = cleanDoctorName(name);
  if (!cleaned) return '';
  if (locale === 'mr' || locale === 'hi') {
    return `डॉ. ${cleaned}`;
  }
  return `Dr. ${cleaned}`;
}


/**
 * The longest patient name worth keeping from a WhatsApp profile.
 *
 * Meta allows far more, and a display name is whatever the sender typed into
 * their phone — it lands on a queue card, a token slip and a display board,
 * none of which have room for a paragraph.
 */
export const MAX_PROFILE_NAME_LENGTH = 60;

/**
 * A WhatsApp display name, made fit to use as a patient name — or null.
 *
 * This is untrusted, user-controlled text arriving from a webhook and going
 * straight onto a medical record, so it is narrowed rather than trusted:
 * control characters removed, whitespace collapsed, length capped.
 *
 * Null rather than a placeholder when nothing usable survives. The caller
 * already has a fallback chain, and returning "WhatsApp patient" from here
 * would make an absent name indistinguishable from a patient who really is
 * called that — which is exactly the confusion this function exists to end.
 */
export function cleanProfileName(raw: string | undefined | null): string | null {
  if (!raw) return null;

  const cleaned = raw
    /**
     * Unicode categories rather than codepoint ranges: \p{C} covers control
     * and format characters in one, including the zero-width joiners emoji
     * are built from and the bidi overrides that can make a name render as
     * something other than what is stored.
     */
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  /**
   * A name made entirely of punctuation or symbols is not a name. Digits are
   * deliberately allowed through: "Anita 2" is a real thing people put in a
   * profile to distinguish family members sharing a handset, and discarding it
   * would lose the only distinguishing mark reception has.
   */
  if (!/\p{L}|\p{N}/u.test(cleaned)) return null;

  return cleaned.length > MAX_PROFILE_NAME_LENGTH
    ? cleaned.slice(0, MAX_PROFILE_NAME_LENGTH).trim()
    : cleaned;
}
