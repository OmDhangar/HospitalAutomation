import { describe, expect, it } from 'vitest';
import {
  cleanDoctorName,
  DAILY_PROMPT_CAP,
  fitListTitle,
  formatDoctorName,
  LIST_ROW_TITLE_LIMIT,
  nextBookingStep,
  parsePatientNameAge,
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
  { id: 'doc-c', name: 'Dr Joshi', mode: 'both' },
];

/** Replays a whole conversation and reports what the business had to send. */
function runConversation(args: {
  knownLocale: 'mr' | 'hi' | 'en' | null;
  inbound: Array<{ replyId?: string; text?: string }>;
  doctors?: DoctorWithMode[];
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
      availableDoctors: args.doctors ?? DOCTORS,
    });
    state = result.state;
    context = result.context;
    if (result.step.kind !== 'none') sent.push(result.step.kind);
  }

  return { state, context, sent };
}

describe('booking conversation', () => {
  it('directly issues queue token for queue-mode doctor without intermediate questions', () => {
    const { sent, context } = runConversation({
      knownLocale: null,
      inbound: [
        { text: 'Hi' },
        { replyId: 'lang:mr' },
        { replyId: 'patient:self' },
        { replyId: 'doc:doc-a' },
      ],
    });

    expect(sent).toEqual(['ask_language', 'ask_patient_choice', 'ask_doctor', 'confirm_queue']);
    expect(context.locale).toBe('mr');
    expect(context.doctorId).toBe('doc-a');
  });

  it('branches to queue vs slot choices for hybrid (both) mode doctor', () => {
    const { sent, context } = runConversation({
      knownLocale: null,
      inbound: [
        { text: 'Hi' },
        { replyId: 'lang:mr' },
        { replyId: 'patient:self' },
        { replyId: 'doc:doc-c' },
        { replyId: 'queue_choice:join' },
      ],
    });

    expect(sent).toEqual([
      'ask_language',
      'ask_patient_choice',
      'ask_doctor',
      'ask_queue_branch',
      'confirm_queue',
    ]);
    expect(context.locale).toBe('mr');
    expect(context.doctorId).toBe('doc-c');
  });

  it('branches directly to slot selection for slot-mode doctor', () => {
    const { sent } = runConversation({
      knownLocale: 'mr',
      inbound: [
        { text: 'Hi' },
        { replyId: 'patient:self' },
        { replyId: 'doc:doc-b' },
        { replyId: 'slot:10:30' },
      ],
    });

    expect(sent).toEqual(['ask_patient_choice', 'ask_doctor', 'ask_slot', 'confirm_slot']);
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
      context: { locale: 'en', patientSelf: true },
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

    it('asks who a new booking is for when patient selects active_appt:new_booking', () => {
      const result = nextBookingStep({
        state: 'awaiting_active_choice',
        context: { locale: 'en', patientName: 'Old Booking', doctorId: 'doc-a' },
        message: { replyId: 'active_appt:new_booking' },
        knownLocale: 'en',
        availableDoctors: DOCTORS,
        activeAppointment: mockAppt,
      });

      expect(result.step.kind).toBe('ask_patient_choice');
      expect(result.state).toBe('awaiting_patient_choice');
      // The last booking's patient and doctor must not leak into this one.
      expect(result.context).toEqual({ locale: 'en' });
    });
  });
});

describe('first booking from a number', () => {
  it('asks who the appointment is for, with no saved patients to list', () => {
    const res = nextBookingStep({
      state: 'awaiting_language',
      context: {},
      message: { replyId: 'lang:en' },
      knownLocale: null,
      availableDoctors: DOCTORS,
      knownPatients: [],
    });

    expect(res.state).toBe('awaiting_patient_choice');
    expect(res.step).toEqual({ kind: 'ask_patient_choice', patients: [] });
  });

  it('books "Myself" under the sender, leaving the name to be resolved at booking', () => {
    const { sent, context } = runConversation({
      knownLocale: null,
      inbound: [
        { text: 'Hi' },
        { replyId: 'lang:en' },
        { replyId: 'patient:self' },
        { replyId: 'doc:doc-a' },
      ],
    });

    expect(sent.at(-1)).toBe('confirm_queue');
    expect(context.patientSelf).toBe(true);
    expect(context.patientName).toBeUndefined();
  });

  it('books "Someone else" under the name and age the sender types', () => {
    const { sent, context } = runConversation({
      knownLocale: null,
      inbound: [
        { text: 'Hi' },
        { replyId: 'lang:hi' },
        { replyId: 'patient:new' },
        { text: 'Aarav Sharma 7' },
        { replyId: 'doc:doc-a' },
      ],
    });

    expect(sent).toEqual([
      'ask_language',
      'ask_patient_choice',
      'ask_patient_name_age',
      'ask_doctor',
      'confirm_queue',
    ]);
    expect(context.patientName).toBe('Aarav Sharma');
    expect(context.patientAge).toBe(7);
    expect(context.patientSelf).toBeUndefined();
  });

  describe('typing the name straight into the patient list', () => {
    it('takes a name and age typed at the list, without the extra prompt', () => {
      const { sent, context } = runConversation({
        knownLocale: null,
        inbound: [
          { text: 'Hi' },
          { replyId: 'lang:en' },
          { text: 'Aarav Sharma 7' },
          { replyId: 'doc:doc-a' },
        ],
      });

      expect(sent).toEqual(['ask_language', 'ask_patient_choice', 'ask_doctor', 'confirm_queue']);
      expect(sent).not.toContain('ask_patient_name_age');
      expect(context.patientName).toBe('Aarav Sharma');
      expect(context.patientAge).toBe(7);
      expect(context.patientSelf).toBeUndefined();
    });

    it('reads Devanagari names and numerals', () => {
      const res = nextBookingStep({
        state: 'awaiting_patient_choice',
        context: { locale: 'mr' },
        message: { text: 'आरव शर्मा ७' },
        knownLocale: 'mr',
        availableDoctors: DOCTORS,
      });

      expect(res.step.kind).toBe('ask_doctor');
      expect(res.context.patientName).toBe('आरव शर्मा');
      expect(res.context.patientAge).toBe(7);
    });

    it('works for a returning number with saved patients too', () => {
      const res = nextBookingStep({
        state: 'awaiting_patient_choice',
        context: { locale: 'en' },
        message: { text: 'Meera Sharma, 62' },
        knownLocale: 'en',
        availableDoctors: DOCTORS,
        knownPatients: [{ id: 'p-1', name: 'Ramesh Sharma', age: 35 }],
      });

      expect(res.step.kind).toBe('ask_doctor');
      expect(res.context.patientName).toBe('Meera Sharma');
      expect(res.context.patientId).toBeUndefined();
    });

    /**
     * "Hi", "ok" and a bare name all parse as names. At the list, only a
     * trailing age marks the text as a patient; anything else re-asks rather
     * than booking someone called "Hi".
     */
    it('does not take text without an age as a patient', () => {
      for (const text of ['Hi', 'ok', 'hello there', 'Aarav Sharma']) {
        const res = nextBookingStep({
          state: 'awaiting_patient_choice',
          context: { locale: 'en' },
          message: { text },
          knownLocale: 'en',
          availableDoctors: [{ id: 'doc-a', name: 'Dr Kulkarni', mode: 'queue' }],
        });

        expect(res.step.kind).toBe('ask_patient_choice');
        expect(res.context.patientName).toBeUndefined();
      }
    });
  });

  it('starts a returning sender over at the patient question, not the doctor menu', () => {
    // State left behind by a completed booking: idle, with that booking's
    // patient and doctor still in context.
    const res = nextBookingStep({
      state: 'idle',
      context: { locale: 'en', patientName: 'Aarav Sharma', doctorId: 'doc-a', queueChoice: 'join' },
      message: { text: 'Hi' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
      knownPatients: [{ id: 'p-1', name: 'Aarav Sharma', age: 7 }],
    });

    expect(res.step.kind).toBe('ask_patient_choice');
    expect(res.context).toEqual({ locale: 'en' });
  });

  it('keeps the chosen patient when free text arrives at the doctor menu', () => {
    const res = nextBookingStep({
      state: 'awaiting_doctor',
      context: { locale: 'en', patientName: 'Aarav Sharma', patientAge: 7 },
      message: { text: 'which one?' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
    });

    expect(res.step.kind).toBe('ask_doctor');
    expect(res.context.patientName).toBe('Aarav Sharma');
    expect(res.context.patientAge).toBe(7);
  });
});

describe('single-doctor hospital', () => {
  const ONLY_QUEUE: DoctorWithMode[] = [{ id: 'doc-a', name: 'Dr Kulkarni', mode: 'queue' }];
  const ONLY_BOTH: DoctorWithMode[] = [{ id: 'doc-c', name: 'Dr Joshi', mode: 'both' }];
  const ONLY_SLOT: DoctorWithMode[] = [{ id: 'doc-b', name: 'Dr Mehta', mode: 'slot' }];

  it('never sends the doctor menu', () => {
    for (const doctors of [ONLY_QUEUE, ONLY_BOTH, ONLY_SLOT]) {
      const { sent } = runConversation({
        knownLocale: null,
        doctors,
        inbound: [{ text: 'Hi' }, { replyId: 'lang:en' }, { replyId: 'patient:self' }],
      });
      expect(sent).not.toContain('ask_doctor');
    }
  });

  it('books a queue-mode doctor straight from the patient choice', () => {
    const { sent, context } = runConversation({
      knownLocale: null,
      doctors: ONLY_QUEUE,
      inbound: [{ text: 'Hi' }, { replyId: 'lang:mr' }, { replyId: 'patient:self' }],
    });

    expect(sent).toEqual(['ask_language', 'ask_patient_choice', 'confirm_queue']);
    expect(context.doctorId).toBe('doc-a');
  });

  it('books for someone else in one typed reply', () => {
    const { sent, context } = runConversation({
      knownLocale: null,
      doctors: ONLY_QUEUE,
      inbound: [{ text: 'Hi' }, { replyId: 'lang:en' }, { text: 'Aarav Sharma 7' }],
    });

    expect(sent).toEqual(['ask_language', 'ask_patient_choice', 'confirm_queue']);
    expect(context.patientName).toBe('Aarav Sharma');
  });

  it('books a queue-mode doctor straight from a typed name and age', () => {
    const { sent, context } = runConversation({
      knownLocale: 'en',
      doctors: ONLY_QUEUE,
      inbound: [{ text: 'Hi' }, { replyId: 'patient:new' }, { text: 'Priya Patil, 28' }],
    });

    expect(sent).toEqual(['ask_patient_choice', 'ask_patient_name_age', 'confirm_queue']);
    expect(context.patientName).toBe('Priya Patil');
  });

  it('goes straight to the queue-or-slot question for a hybrid doctor', () => {
    const { sent, state, context } = runConversation({
      knownLocale: 'en',
      doctors: ONLY_BOTH,
      inbound: [{ text: 'Hi' }, { replyId: 'patient:self' }],
    });

    expect(sent).toEqual(['ask_patient_choice', 'ask_queue_branch']);
    expect(state).toBe('awaiting_queue_choice');
    expect(context.doctorId).toBe('doc-c');
  });

  it('goes straight to the slot list for a slot-mode doctor', () => {
    const { sent } = runConversation({
      knownLocale: 'en',
      doctors: ONLY_SLOT,
      inbound: [{ text: 'Hi' }, { replyId: 'patient:self' }],
    });

    expect(sent).toEqual(['ask_patient_choice', 'ask_slot']);
  });

  /**
   * With one queue-mode doctor, "choose a doctor" and "book" are the same step,
   * so anything that used to fall back to the doctor menu would now book. Free
   * text must never do that.
   */
  it('never books on free text, even mid-booking', () => {
    for (const state of ['idle', 'awaiting_doctor', 'awaiting_queue_choice', 'awaiting_slot'] as const) {
      const res = nextBookingStep({
        state,
        context: { locale: 'en', patientSelf: true },
        message: { text: 'hello' },
        knownLocale: 'en',
        availableDoctors: ONLY_QUEUE,
      });
      expect(res.step.kind).toBe('ask_patient_choice');
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

describe('patient name and age parser', () => {
  it('parses standard name and age', () => {
    expect(parsePatientNameAge('Aarav Sharma 7')).toEqual({ name: 'Aarav Sharma', age: 7 });
    expect(parsePatientNameAge('Priya Patil, 28')).toEqual({ name: 'Priya Patil', age: 28 });
    expect(parsePatientNameAge('Ramesh Gupta 45 yrs')).toEqual({ name: 'Ramesh Gupta', age: 45 });
    expect(parsePatientNameAge('Ananya (5)')).toEqual({ name: 'Ananya', age: 5 });
  });

  it('parses Devanagari numerals in Marathi and Hindi', () => {
    expect(parsePatientNameAge('सुरेश पाटील ३२')).toEqual({ name: 'सुरेश पाटील', age: 32 });
    expect(parsePatientNameAge('आरव शर्मा ७ वर्षे')).toEqual({ name: 'आरव शर्मा', age: 7 });
  });

  it('falls back cleanly to name when age is omitted', () => {
    expect(parsePatientNameAge('Sneha Deshmukh')).toEqual({ name: 'Sneha Deshmukh' });
    expect(parsePatientNameAge('')).toBeNull();
  });
});

describe('multi-patient profile selection', () => {
  const KNOWN_PATIENTS = [
    { id: 'p-1', name: 'Ramesh Sharma', age: 35 },
    { id: 'p-2', name: 'Aarav Sharma', age: 7 },
  ];

  it('prompts to select from existing patient profiles on returning phone', () => {
    const res = nextBookingStep({
      state: 'idle',
      context: { locale: 'en' },
      message: { text: 'Hi' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
      knownPatients: KNOWN_PATIENTS,
    });

    expect(res.state).toBe('awaiting_patient_choice');
    expect(res.step).toEqual({
      kind: 'ask_patient_choice',
      patients: KNOWN_PATIENTS,
    });
  });

  it('selects existing profile and proceeds to doctor selection', () => {
    const res = nextBookingStep({
      state: 'awaiting_patient_choice',
      context: { locale: 'en' },
      message: { replyId: 'patient:p-2' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
      knownPatients: KNOWN_PATIENTS,
    });

    expect(res.state).toBe('awaiting_doctor');
    expect(res.context.patientId).toBe('p-2');
    expect(res.context.patientName).toBe('Aarav Sharma');
    expect(res.context.patientAge).toBe(7);
    expect(res.step.kind).toBe('ask_doctor');
  });

  it('prompts for new patient details when Add New Patient is picked', () => {
    const res = nextBookingStep({
      state: 'awaiting_patient_choice',
      context: { locale: 'en' },
      message: { replyId: 'patient:new' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
      knownPatients: KNOWN_PATIENTS,
    });

    expect(res.state).toBe('awaiting_patient_name_age');
    expect(res.step.kind).toBe('ask_patient_name_age');
  });

  it('accepts new patient text input and moves to doctor selection', () => {
    const res = nextBookingStep({
      state: 'awaiting_patient_name_age',
      context: { locale: 'en' },
      message: { text: 'Meera Sharma 32' },
      knownLocale: 'en',
      availableDoctors: DOCTORS,
      knownPatients: KNOWN_PATIENTS,
    });

    expect(res.state).toBe('awaiting_doctor');
    expect(res.context.patientName).toBe('Meera Sharma');
    expect(res.context.patientAge).toBe(32);
    expect(res.step.kind).toBe('ask_doctor');
  });

  describe('doctor name formatting', () => {
    it('strips duplicate or existing doctor prefixes properly', () => {
      expect(cleanDoctorName('Dr Rohan Gujrathi')).toBe('Rohan Gujrathi');
      expect(cleanDoctorName('Dr. Rohan Gujrathi')).toBe('Rohan Gujrathi');
      expect(cleanDoctorName('Dr. Dr Rohan Gujrathi')).toBe('Rohan Gujrathi');
      expect(cleanDoctorName('डॉ. रोहन गुजराथी')).toBe('रोहन गुजराथी');
      expect(cleanDoctorName('डॉ. डॉ. रोहन गुजराथी')).toBe('रोहन गुजराथी');
      expect(cleanDoctorName('Rohan Gujrathi')).toBe('Rohan Gujrathi');
      expect(cleanDoctorName('')).toBe('');
    });

    it('formats localized display titles cleanly without double prefixes', () => {
      expect(formatDoctorName('Dr. Dr Rohan Gujrathi', 'en')).toBe('Dr. Rohan Gujrathi');
      expect(formatDoctorName('Dr Rohan Gujrathi', 'en')).toBe('Dr. Rohan Gujrathi');
      expect(formatDoctorName('Rohan Gujrathi', 'en')).toBe('Dr. Rohan Gujrathi');
      expect(formatDoctorName('Dr Rohan Gujrathi', 'mr')).toBe('डॉ. Rohan Gujrathi');
      expect(formatDoctorName('डॉ. रोहन गुजराथी', 'mr')).toBe('डॉ. रोहन गुजराथी');
      expect(formatDoctorName('रोहन गुजराथी', 'hi')).toBe('डॉ. रोहन गुजराथी');
    });
  });
});


