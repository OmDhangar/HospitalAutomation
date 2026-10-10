import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, withTenant } from '@/lib/db';
import {
  appointments,
  doctors as doctorsTable,
  idempotencyKeys,
  notificationOutbox,
  patients,
  whatsappConversations,
} from '@/lib/db/schema';
import {
  cleanDoctorName,
  cleanProfileName,
  fitListTitle,
  formatDoctorName,
  nextBookingStep,
  shouldSendPrompt,
  type ActiveAppointmentInfo,
  type BookingContext,
  type ConversationState,
} from '@/lib/domain/booking';
import type { EtaResult } from '@/lib/domain/eta';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import { LOCALE_NAMES, LOCALES, t, type Locale } from '@/lib/i18n/patient';
import { getProvider, type InteractiveButton, type ListRow } from '@/lib/notify/provider';
import { listDoctors } from './hospital';
import { CapacityError } from './capacity';
import { createWalkIn, estimateForNewJoiner, getPublicQueueView, getQueueSnapshot } from './queue';
import { getPlanAccess } from './subscriptions';
import { getDoctorSlotsForDate } from './scheduling';
import { bookScheduledSlot, BookingError } from './web-booking';

/**
 * Used only when a patient has never given a name, has no record, and set no
 * WhatsApp profile name. Before the parser captured the profile name this was
 * the common case rather than the rare one, and every booking landed under it.
 */
const FALLBACK_PATIENT_NAME = 'WhatsApp patient';

export type InboundWhatsApp = {
  phoneNumberId: string;
  messageId: string;
  fromPhone: string;
  text?: string;
  replyId?: string;
  /** The sender's WhatsApp display name, when Meta sent one. */
  profileName?: string;
};

/** Copy for the conversation itself. Templates cover everything outbound-only. */
const PROMPTS: Record<Locale, { language: string; doctor: string; slot: string; pick: string }> = {
  mr: {
    language: 'कृपया तुमची भाषा निवडा',
    doctor: 'तुम्हाला कोणत्या डॉक्टरांकडे यायचे आहे?',
    slot: 'उपलब्ध वेळ निवडा:',
    pick: 'निवडा',
  },
  hi: {
    language: 'कृपया अपनी भाषा चुनें',
    doctor: 'आप किस डॉक्टर से मिलना चाहते हैं?',
    slot: 'उपलब्ध समय चुनें:',
    pick: 'चुनें',
  },
  en: {
    language: 'Please choose your language',
    doctor: 'Which doctor would you like to see today?',
    slot: 'Choose an available time:',
    pick: 'Choose',
  },
};

const MODE_TAGS: Record<Locale, { queue: string; slot: string; both: string }> = {
  mr: { queue: 'आज थेट रांग', slot: 'वेळ निवडा', both: 'रांग व वेळ स्लॉट' },
  hi: { queue: 'आज लाइव कतार', slot: 'समय स्लॉट बुक करें', both: 'कतार और स्लॉट' },
  en: { queue: 'Live queue today', slot: 'Book a time slot', both: 'Queue & Slots' },
};

const QUEUE_BRANCH_PROMPTS: Record<
  Locale,
  {
    body: (doctorName: string) => string;
    joinTitle: string;
    slotTitle: string;
  }
> = {
  mr: {
    body: (doctorName) =>
      `${formatDoctorName(doctorName, 'mr')} साठी तुम्ही आज थेट रांगेत सामील होऊ शकता किंवा भविष्यातील वेळ स्लॉट बुक करू शकता.`,
    joinTitle: 'आज थेट रांग',
    slotTitle: 'वेळ स्लॉट निवडा',
  },
  hi: {
    body: (doctorName) =>
      `${formatDoctorName(doctorName, 'hi')} के लिए आप आज लाइव कतार में शामिल हो सकते हैं या आगामी समय स्लॉट बुक कर सकते हैं।`,
    joinTitle: 'आज लाइव कतार',
    slotTitle: 'समय स्लॉट चुनें',
  },
  en: {
    body: (doctorName) =>
      `For ${formatDoctorName(doctorName, 'en')}, would you like to join today's live queue or book a scheduled appointment time slot?`,
    joinTitle: 'Join Live Queue',
    slotTitle: 'Book Time Slot',
  },
};

const QUEUE_WAIT_TIME_PROMPTS: Record<
  Locale,
  {
    body: (doctorName: string, serving: number | string, ahead: number, waitLine: string) => string;
    joinTitle: string;
  }
> = {
  mr: {
    body: (doctorName, serving, ahead, waitLine) =>
      `${formatDoctorName(doctorName, 'mr')} — थेट रांग माहिती:

सध्या तपासणी सुरू: ${serving}
तुमच्या आधी रुग्ण: ${ahead}
${waitLine}

तुम्ही तयार असाल तेव्हा खालील बटण दाबून रांगेत सामील व्हा.`,
    joinTitle: 'रांगेत सामील व्हा',
  },
  hi: {
    body: (doctorName, serving, ahead, waitLine) =>
      `${formatDoctorName(doctorName, 'hi')} — लाइव कतार स्थिति:

वर्तमान में सेवारत: ${serving}
आपसे पहले मरीज़: ${ahead}
${waitLine}

जब आप तैयार हों, तब नीचे बटन दबाकर कतार में शामिल हों।`,
    joinTitle: 'कतार में शामिल हों',
  },
  en: {
    body: (doctorName, serving, ahead, waitLine) =>
      `${formatDoctorName(doctorName, 'en')} — Live Queue Status:

Currently serving: ${serving}
Patients ahead: ${ahead}
${waitLine}

Tap below to join the queue whenever you are ready.`,
    joinTitle: 'Join queue now',
  },
};

const PATIENT_PROMPTS: Record<
  Locale,
  {
    /**
     * Also tells the sender they can type someone else's name and age straight
     * back. Doing that books in one reply; tapping "Someone else" costs a
     * further prompt asking for the name.
     */
    choiceBody: string;
    choicePick: string;
    newPatientTitle: string;
    askNameAge: string;
    /** First booking from a number: the sender, or somebody else. */
    selfTitle: string;
    otherTitle: string;
    otherDesc: string;
  }
> = {
  mr: {
    choiceBody:
      'ही अपॉइंटमेंट कोणासाठी नोंदवायची आहे?\n\nदुसऱ्या व्यक्तीसाठी असल्यास, थेट त्यांचे नाव आणि वय पाठवा (उदा. आरव शर्मा 7).',
    choicePick: 'रुग्ण निवडा',
    newPatientTitle: 'नवीन रुग्ण जोडा',
    askNameAge: 'कृपया रुग्णाचे पूर्ण नाव आणि वय सांगा (उदा. आरव शर्मा 7):',
    selfTitle: 'माझ्यासाठी',
    otherTitle: 'दुसऱ्या व्यक्तीसाठी',
    otherDesc: 'किंवा नाव व वय टाइप करा',
  },
  hi: {
    choiceBody:
      'यह अपॉइंटमेंट किसके लिए बुक करनी है?\n\nकिसी और के लिए हो, तो सीधे उनका नाम और उम्र भेजें (उदा. आरव शर्मा 7).',
    choicePick: 'मरीज़ चुनें',
    newPatientTitle: 'नया मरीज़ जोड़ें',
    askNameAge: 'कृपया मरीज़ का पूरा नाम और उम्र बताएं (उदा. आरव शर्मा 7):',
    selfTitle: 'मेरे लिए',
    otherTitle: 'किसी और के लिए',
    otherDesc: 'या नाम व उम्र टाइप करें',
  },
  en: {
    choiceBody:
      'Who is this appointment for?\n\nBooking for someone else? Just reply with their name and age (e.g. Aarav Sharma 7).',
    choicePick: 'Select Patient',
    newPatientTitle: 'Add New Patient',
    askNameAge: 'Please reply with the patient’s full name and age (e.g. Aarav Sharma 7):',
    selfTitle: 'Myself',
    otherTitle: 'Someone else',
    otherDesc: 'Or type name & age',
  },
};

/**
 * One extra line on the confirmation when the doctor is on a break, rather than
 * a separate message. Without it a patient booking during lunch reads "currently
 * serving: 7", watches 7 not move for forty minutes, and concludes the queue is
 * broken.
 */
const ON_BREAK_NOTE: Record<Locale, string> = {
  mr: 'डॉक्टर सध्या विश्रांतीवर आहेत. ते परत आल्यावर रांग पुन्हा सुरू होईल.',
  hi: 'डॉक्टर अभी ब्रेक पर हैं। उनके लौटते ही कतार फिर से चलेगी।',
  en: 'The doctor is on a break right now. The queue will move again when they are back.',
};

/**
 * "Call 3": who is being served, as the serving sequence rather than a token,
 * so a patient reading "currently serving" never sees a token higher than
 * theirs and thinks they were skipped. Falls back to the token, then a dash.
 */
const servingLabel = (
  snapshot: { currentCallNumber: number | null; currentToken: number | null } | null,
  locale: Locale,
): string =>
  snapshot?.currentCallNumber != null
    ? `${t[locale].callWord} ${snapshot.currentCallNumber}`
    : snapshot?.currentToken != null
      ? String(snapshot.currentToken)
      : '-';

const withBreakNote = (body: string, locale: Locale, onBreak: boolean): string =>
  onBreak ? `${ON_BREAK_NOTE[locale]}\n\n${body}` : body;

const QUEUE_CONFIRMATION: Record<
  Locale,
  (token: number, doctor: string, patient: string, serving: number | string, waitLine: string, url: string) => string
> = {
  mr: (token, doctor, patient, serving, waitLine, url) =>
    `तुम्ही ${formatDoctorName(doctor, 'mr')} यांच्या रांगेत सामील झाला आहात.

रुग्ण: ${patient}
तुमचा टोकन क्रमांक: ${token}
सध्या तपासणी सुरू: ${serving}
${waitLine}

रांगेतील स्थिती पाहा: ${url}

तुम्ही बाहेर थांबू शकता — तुमचा नंबर जवळ आल्यावर आम्ही कळवू.`,
  hi: (token, doctor, patient, serving, waitLine, url) =>
    `आप ${formatDoctorName(doctor, 'hi')} की कतार में शामिल हो गए हैं।

मरीज़: ${patient}
आपका टोकन नंबर: ${token}
वर्तमान में सेवारत: ${serving}
${waitLine}

कतार स्थिति देखें: ${url}

आप बाहर इंतज़ार कर सकते हैं — आपकी बारी पास आने पर हम सूचित करेंगे।`,
  en: (token, doctor, patient, serving, waitLine, url) =>
    `You're in the queue for ${formatDoctorName(doctor, 'en')}.

Patient: ${patient}
Your token number: ${token}
Currently serving: ${serving}
${waitLine}

Track position: ${url}

You don't need to wait inside — we'll message you when your token is close.`,
};

/**
 * What the patient is told about timing, in one line.
 *
 * Before OPD the estimate counts from the doctor's start, and says so; once
 * the doctor is overdue no time is promised at all. It used to be a bare
 * "~5 min" floor, which at 10am for a 12pm OPD sent patients in two hours early.
 */
type WaitInfo =
  | { kind: 'planned'; startsAt: string; around: string }
  | { kind: 'live'; minutes: number; around: string }
  | { kind: 'not_started' };

const WAIT_LINE: Record<Locale, (w: WaitInfo) => string> = {
  mr: (w) =>
    w.kind === 'planned'
      ? `डॉक्टर ${w.startsAt} वाजता सुरू करतील\nतुमची अंदाजे वेळ: सुमारे ${w.around}`
      : w.kind === 'live'
        ? `अंदाजे प्रतीक्षा: ~${w.minutes} मिनिटे (सुमारे ${w.around})`
        : 'डॉक्टरांनी अजून तपासणी सुरू केलेली नाही. तुमचा नंबर जवळ आल्यावर आम्ही कळवू.',
  hi: (w) =>
    w.kind === 'planned'
      ? `डॉक्टर ${w.startsAt} बजे शुरू करेंगे\nआपका अनुमानित समय: लगभग ${w.around}`
      : w.kind === 'live'
        ? `अनुमानित प्रतीक्षा: ~${w.minutes} मिनट (लगभग ${w.around})`
        : 'डॉक्टर ने अभी शुरू नहीं किया है। आपकी बारी पास आने पर हम सूचित करेंगे।',
  en: (w) =>
    w.kind === 'planned'
      ? `Doctor starts at ${w.startsAt}\nYour expected time: around ${w.around}`
      : w.kind === 'live'
        ? `Estimated wait: ~${w.minutes} min (around ${w.around})`
        : "The doctor hasn't started yet. We'll message you when your turn is close.",
};

function waitInfoFor(eta: EtaResult | null, timezone: string): WaitInfo {
  if (!eta || eta.state === 'not_started') return { kind: 'not_started' };
  const around = formatTimeIn(timezone, eta.windowStart);
  return eta.state === 'planned'
    ? { kind: 'planned', startsAt: formatTimeIn(timezone, eta.basis.anchorAt), around }
    : { kind: 'live', minutes: eta.waitMinutes, around };
}

/**
 * Said instead of a token when the day refuses an online queue booking: not
 * open yet, fully booked, or (on a split day) the live queue has closed and
 * only evening slots remain.
 */
const QUEUE_UNAVAILABLE: Record<Locale, (doctor: string, opensAt: string | null, closed: boolean) => string> = {
  mr: (doctor, opensAt, closed) =>
    closed
      ? `${formatDoctorName(doctor, 'mr')} यांची आजची थेट रांग बंद झाली आहे. संध्याकाळच्या सत्रासाठी वेळ बुक करण्यासाठी "Hi" पाठवा.`
      : opensAt
      ? `${formatDoctorName(doctor, 'mr')} यांच्या आजच्या रांगेसाठी ऑनलाइन नोंदणी ${opensAt} वाजता सुरू होईल. कृपया तेव्हा पुन्हा संदेश पाठवा.`
      : `${formatDoctorName(doctor, 'mr')} यांची आजची ऑनलाइन नोंदणी पूर्ण भरली आहे. कृपया रुग्णालयात संपर्क करा.`,
  hi: (doctor, opensAt, closed) =>
    closed
      ? `${formatDoctorName(doctor, 'hi')} की आज की लाइव कतार बंद हो गई है। शाम के सत्र का समय बुक करने के लिए "Hi" भेजें।`
      : opensAt
      ? `${formatDoctorName(doctor, 'hi')} की आज की कतार के लिए ऑनलाइन बुकिंग ${opensAt} बजे शुरू होगी। कृपया तब दोबारा संदेश भेजें।`
      : `${formatDoctorName(doctor, 'hi')} की आज की ऑनलाइन बुकिंग पूरी भर चुकी है। कृपया अस्पताल से संपर्क करें।`,
  en: (doctor, opensAt, closed) =>
    closed
      ? `${formatDoctorName(doctor, 'en')}'s live queue has closed for today. Send "Hi" to book a time in the evening session.`
      : opensAt
      ? `Online booking for ${formatDoctorName(doctor, 'en')}'s queue today opens at ${opensAt}. Please message us again then.`
      : `${formatDoctorName(doctor, 'en')}'s queue is fully booked online for today. Please contact the hospital.`,
};

const SLOT_CONFIRMATION: Record<
  Locale,
  (doctor: string, patient: string, datetime: string, token: number | string, url: string) => string
> = {
  mr: (doctor, patient, datetime, token, url) =>
    `तुमची अपॉइंटमेंट निश्चित झाली आहे.

रुग्ण: ${patient}
डॉक्टर: ${formatDoctorName(doctor, 'mr')}
तारीख व वेळ: ${datetime}
टोकन क्रमांक: ${token}

रांगेतील स्थिती पाहा: ${url}

आम्ही अपॉइंटमेंटच्या 15 मिनिटे आधी तुम्हाला स्मरणपत्र पाठवू.`,
  hi: (doctor, patient, datetime, token, url) =>
    `आपकी अपॉइंटमेंट की पुष्टि हो गई है।

मरीज़: ${patient}
डॉक्टर: ${formatDoctorName(doctor, 'hi')}
दिनांक और समय: ${datetime}
टोकन नंबर: ${token}

कतार स्थिति देखें: ${url}

हम आपकी अपॉइंटमेंट से 15 मिनट पहले आपको स्मरण पत्र भेजेंगे।`,
  en: (doctor, patient, datetime, token, url) =>
    `Your appointment is confirmed.

Patient: ${patient}
Doctor: ${formatDoctorName(doctor, 'en')}
Date & time: ${datetime}
Token number: ${token}

Track position: ${url}

We'll send you a reminder 15 minutes before your appointment.`,
};

const ACTIVE_CHOICE_PROMPTS: Record<
  Locale,
  {
    body: (doctor: string, token: number, url: string) => string;
    viewTitle: string;
    viewDesc: string;
    newTitle: string;
    newDesc: string;
  }
> = {
  mr: {
    body: (doctor, token, url) =>
      `तुमची एक अपॉइंटमेंट आधीच नोंदवलेली आहे!

टोकन क्रमांक: ${token}
डॉक्टर: ${formatDoctorName(doctor, 'mr')}

रांगेतील सद्यस्थिती इथे पाहा:
${url}

तुम्हाला पुढे काय करायचे आहे?`,
    viewTitle: 'अपॉइंटमेंट पाहा',
    viewDesc: 'लाइव्ह रांग लिंक मिळवा',
    newTitle: 'नवीन बुकिंग करा',
    newDesc: 'दुसऱ्या डॉक्टरांसाठी टोकन किंवा वेळ घ्या',
  },
  hi: {
    body: (doctor, token, url) =>
      `आपका एक टोकन पहले से सक्रिय है!

टोकन नंबर: ${token}
डॉक्टर: ${formatDoctorName(doctor, 'hi')}

कतार में अपनी स्थिति यहाँ देखें:
${url}

आप क्या करना चाहते हैं?`,
    viewTitle: 'अपॉइंटमेंट देखें',
    viewDesc: 'लाइव कतार लिंक प्राप्त करें',
    newTitle: 'नई अपॉइंटमेंट लें',
    newDesc: 'दूसरे डॉक्टर के लिए बुकिंग करें',
  },
  en: {
    body: (doctor, token, url) =>
      `You already have an active appointment booked!

Token number: ${token}
Doctor: ${formatDoctorName(doctor, 'en')}

Track your position in the queue here:
${url}

What would you like to do?`,
    viewTitle: 'View Active Queue',
    viewDesc: 'Get your live queue tracking link',
    newTitle: 'Book New Appointment',
    newDesc: 'Book another doctor or department',
  },
};

const SHOW_ACTIVE_PROMPTS: Record<
  Locale,
  (doctor: string, token: number, url: string) => string
> = {
  mr: (doctor, token, url) =>
    `तुमच्या सद्य अपॉइंटमेंटची माहिती खालीलप्रमाणे आहे:

टोकन क्रमांक: ${token}
डॉक्टर: ${formatDoctorName(doctor, 'mr')}

रांगेतील सद्यस्थिती इथे पाहा:
${url}`,
  hi: (doctor, token, url) =>
    `आपकी वर्तमान अपॉइंटमेंट का विवरण:

टोकन नंबर: ${token}
डॉक्टर: ${formatDoctorName(doctor, 'hi')}

कतार में अपनी स्थिति यहाँ देखें:
${url}`,
  en: (doctor, token, url) =>
    `Here are your active appointment details:

Token number: ${token}
Doctor: ${formatDoctorName(doctor, 'en')}

Track your position in the queue here:
${url}`,
};

const REDIRECT_WEB: Record<Locale, (doctor: string, url: string) => string> = {
  mr: (doctor, url) =>
    `${formatDoctorName(doctor, 'mr')} यांच्याकडे अपॉइंटमेंटची वेळ निवडण्यासाठी, कृपया उपलब्ध वेळ निवडा:

${url}

आम्ही अपॉइंटमेंटपूर्वी तुम्हाला स्मरणपत्र पाठवू.`,
  hi: (doctor, url) =>
    `${formatDoctorName(doctor, 'hi')} के साथ अपॉइंटमेंट का समय चुनने के लिए, कृपया उपलब्ध स्लॉट चुनें:

${url}

हम आपकी अपॉइंटमेंट से पहले आपको स्मरण पत्र भेजेंगे।`,
  en: (doctor, url) =>
    `To choose your appointment time for ${formatDoctorName(doctor, 'en')}, please select an available slot on our website:

${url}

We'll send you a reminder before your appointment.`,
};

const SLOT_ROWS: Record<Locale, ListRow[]> = {
  mr: [
    { id: 'slot:now', title: 'आताचा वेळ' },
    { id: 'slot:later', title: 'वेबसाईटवर वेळ निवडा' },
  ],
  hi: [
    { id: 'slot:now', title: 'अभी का समय' },
    { id: 'slot:later', title: 'वेबसाइट पर समय चुनें' },
  ],
  en: [
    { id: 'slot:now', title: 'Coming now' },
    { id: 'slot:later', title: 'Select slot on web' },
  ],
};

export async function getActiveAppointment(
  hospitalId: string,
  phoneE164: string,
): Promise<ActiveAppointmentInfo | null> {
  return withTenant(hospitalId, async (tx) => {
    const rows = await tx
      .select({
        id: appointments.id,
        tokenNumber: appointments.tokenNumber,
        status: appointments.status,
        publicToken: appointments.publicToken,
        serviceDate: appointments.serviceDate,
        doctorId: appointments.doctorId,
        doctorName: doctorsTable.name,
      })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .innerJoin(doctorsTable, eq(appointments.doctorId, doctorsTable.id))
      .where(
        and(
          eq(appointments.hospitalId, hospitalId),
          eq(patients.phoneE164, phoneE164),
          sql`${appointments.status} not in ('COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED')`,
          sql`${appointments.publicTokenExpiresAt} > now()`,
        ),
      )
      .orderBy(desc(appointments.createdAt))
      .limit(1);

    if (rows.length === 0) return null;
    return rows[0];
  });
}

/**
 * Records a message that produced no reply, and why.
 *
 * Every early return below looks identical from the patient's side: a blue
 * tick and silence. The read receipt is sent by the webhook route before this
 * function runs, so "delivered, read, no answer" is the signature of all six
 * of them at once — which makes them indistinguishable in production unless
 * each one says which it was.
 */
function dropped(
  inbound: InboundWhatsApp,
  reason: string,
  fields: Record<string, unknown> = {},
): void {
  console.warn(
    '[whatsapp:inbound.dropped]',
    JSON.stringify({
      reason,
      phone_number_id: inbound.phoneNumberId,
      message_id: inbound.messageId,
      ...fields,
    }),
  );
}

/**
 * Handles one inbound WhatsApp message.
 */
export async function handleInboundMessage(
  inbound: InboundWhatsApp,
  options: {
    /**
     * Set by the per-hospital webhook. Its signature proves the payload came
     * from that hospital's own Meta app — and nothing more. The phone number
     * id inside is whatever that app put there, so a hospital controlling its
     * own app secret could otherwise sign a message naming another hospital's
     * number and have it booked into that hospital's queue, with replies sent
     * from that hospital's number.
     */
    expectedHospitalId?: string;
  } = {},
): Promise<void> {
  const db = getDb();

  const [resolved] = await db.execute<{ hospital_id: string | null }>(
    sql`select public.resolve_whatsapp_number(${inbound.phoneNumberId}) as hospital_id`,
  );
  const hospitalId = resolved?.hospital_id;
  if (!hospitalId) {
    return dropped(inbound, 'unroutable_number', {
      hint: 'whatsapp_numbers row must be status=registered on an active hospital',
    });
  }
  if (options.expectedHospitalId && options.expectedHospitalId !== hospitalId) {
    return dropped(inbound, 'number_not_owned_by_signing_hospital', {
      signing_hospital: options.expectedHospitalId,
    });
  }
  // A revoked or lapsed plan stops WhatsApp booking, without a reply: the
  // staff are locked out of the queue it would join.
  if ((await getPlanAccess(hospitalId)).state === 'locked') {
    return dropped(inbound, 'plan_inactive', { hospitalId });
  }

  const phoneE164 = normalizeIndianPhone(inbound.fromPhone);
  if (!phoneE164) {
    return dropped(inbound, 'unparseable_sender', {
      // Masked: logs are not where patient phone numbers belong.
      from_masked: `${inbound.fromPhone.slice(0, 3)}…${inbound.fromPhone.slice(-2)}`,
    });
  }

  const claimed = await withTenant(hospitalId, async (tx) => {
    const rows = await tx
      .insert(idempotencyKeys)
      .values({
        hospitalId,
        key: `wa:${inbound.messageId}`,
        endpoint: 'whatsapp.inbound',
        requestHash: inbound.messageId,
      })
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });
    return rows.length > 0;
  });
  if (!claimed) {
    // Meta redelivered a message we already claimed. Normally that means the
    // first attempt succeeded — but if it crashed after claiming and before
    // replying, this message is now permanently unanswerable.
    return dropped(inbound, 'already_processed', {
      hint: 'redelivery, or a crash after the idempotency claim',
    });
  }

  const now = new Date();
  const today = serviceDateIn('Asia/Kolkata', now);

  const doctors = await listDoctors({ hospitalId, serviceDate: today });
  if (doctors.length === 0) {
    return dropped(inbound, 'no_active_doctors', { hospitalId });
  }

  const conversation = await loadConversation(hospitalId, phoneE164);
  const { state, context, knownLocale } = conversation;

  const activeAppointment = await getActiveAppointment(hospitalId, phoneE164);

  const transition = nextBookingStep({
    state,
    context,
    message: { replyId: inbound.replyId, text: inbound.text },
    knownLocale,
    availableDoctors: doctors.map((d) => ({
      id: d.id,
      name: d.name,
      specialty: d.specialty,
      mode: d.mode,
    })),
    activeAppointment,
    knownPatients: conversation.knownPatients,
  });

  const locale = transition.context.locale ?? knownLocale ?? 'en';
  const provider = getProvider();
  const prompts = PROMPTS[locale];

  const promptsToday = conversation.promptsDate === today ? conversation.promptsToday : 0;

  const decision = shouldSendPrompt({
    step: transition.step.kind,
    lastPromptStep: conversation.lastPromptStep,
    lastPromptAt: conversation.lastPromptAt,
    promptsToday,
    now,
  });

  let promptsSent = promptsToday;

  if (!decision.send) {
    // Deliberate silence, not a failure: either the patient already has this
    // exact prompt on screen (120s cooldown) or the number has spent its daily
    // budget. Logged because during testing it is indistinguishable from a
    // broken bot, and that costs hours.
    dropped(inbound, `suppressed:${decision.reason}`, {
      step: transition.step.kind,
      last_prompt_step: conversation.lastPromptStep,
      prompts_today: promptsToday,
    });
  }

  const sendText = async (bodyText: string, milestone: string) => {
    if (!decision.send) return;
    promptsSent += 1;

    const result = await provider.sendText({
      phoneNumberId: inbound.phoneNumberId,
      toPhoneE164: phoneE164,
      body: bodyText,
    });

    await withTenant(hospitalId, (tx) =>
      tx.insert(notificationOutbox).values({
        hospitalId,
        milestone,
        templateCode: 'conversation',
        locale,
        payload: { bodyLength: bodyText.length },
        status: 'sent',
        providerMessageId: result.providerMessageId,
        sentAt: new Date(),
      }),
    );
  };

  /**
   * The booking reply in the chat is the patient's queue link, so it is
   * recorded under the queue_link milestone. That keeps the meter honest and,
   * through the outbox's one-per-milestone index, stops any paid template for
   * the same news from being queued afterwards.
   */
  const recordChatConfirmation = async (
    appointment: { id: string; patientId: string },
    providerMessageId: string | null | undefined,
  ) => {
    await withTenant(hospitalId, (tx) =>
      tx
        .insert(notificationOutbox)
        .values({
          hospitalId,
          appointmentId: appointment.id,
          patientId: appointment.patientId,
          milestone: 'queue_link',
          templateCode: 'conversation',
          locale,
          payload: { inChat: true },
          status: 'sent',
          providerMessageId: providerMessageId ?? null,
          sentAt: new Date(),
        })
        .onConflictDoNothing(),
    );
  };

  const sendList =async (bodyText: string, rows: ListRow[], milestone: string) => {
    if (!decision.send) return;
    promptsSent += 1;

    const result = await provider.sendInteractiveList({
      phoneNumberId: inbound.phoneNumberId,
      toPhoneE164: phoneE164,
      bodyText,
      buttonText: prompts.pick,
      rows,
    });

    await withTenant(hospitalId, (tx) =>
      tx.insert(notificationOutbox).values({
        hospitalId,
        milestone,
        templateCode: 'conversation',
        locale,
        payload: { rows: rows.length },
        status: 'sent',
        providerMessageId: result.providerMessageId,
        sentAt: new Date(),
      }),
    );
  };

  const sendButtons = async (bodyText: string, buttons: InteractiveButton[], milestone: string) => {
    if (!decision.send) return;
    promptsSent += 1;

    const result = await provider.sendInteractiveButtons({
      phoneNumberId: inbound.phoneNumberId,
      toPhoneE164: phoneE164,
      bodyText,
      buttons,
    });

    await withTenant(hospitalId, (tx) =>
      tx.insert(notificationOutbox).values({
        hospitalId,
        milestone,
        templateCode: 'conversation',
        locale,
        payload: { buttons: buttons.length },
        status: 'sent',
        providerMessageId: result.providerMessageId,
        sentAt: new Date(),
      }),
    );
  };

  const step = transition.step;
  switch (step.kind) {
    case 'ask_active_choice': {
      const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
      const appt = step.appointment;
      const choicePrompt = ACTIVE_CHOICE_PROMPTS[locale];
      await sendList(
        choicePrompt.body(
          appt.doctorName,
          appt.tokenNumber,
          `${baseUrl}/q/${appt.publicToken}`,
        ),
        [
          {
            id: 'active_appt:view',
            title: fitListTitle(choicePrompt.viewTitle),
            description: fitListTitle(choicePrompt.viewDesc),
          },
          {
            id: 'active_appt:new_booking',
            title: fitListTitle(choicePrompt.newTitle),
            description: fitListTitle(choicePrompt.newDesc),
          },
        ],
        'conversation:active_choice',
      );
      break;
    }

    case 'show_active_appointment': {
      const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
      const appt = step.appointment;
      const bodyText = SHOW_ACTIVE_PROMPTS[locale](
        appt.doctorName,
        appt.tokenNumber,
        `${baseUrl}/q/${appt.publicToken}`,
      );
      const sent = await provider.sendText({
        phoneNumberId: inbound.phoneNumberId,
        toPhoneE164: phoneE164,
        body: bodyText,
      });

      await withTenant(hospitalId, (tx) =>
        tx.insert(notificationOutbox).values({
          hospitalId,
          milestone: 'conversation:show_active',
          templateCode: 'conversation',
          locale,
          payload: { appointmentId: appt.id },
          status: 'sent',
          providerMessageId: sent.providerMessageId,
          sentAt: new Date(),
        }),
      );
      break;
    }

    case 'ask_language':
      await sendList(
        LOCALES.map((code) => PROMPTS[code].language).join('\n'),
        LOCALES.map((code) => ({ id: `lang:${code}`, title: LOCALE_NAMES[code] })),
        'conversation:language',
      );
      break;

    case 'ask_patient_choice': {
      const p = PATIENT_PROMPTS[locale];
      // A number with no saved patients gets "Myself" and "Someone else", so
      // even a first booking can be for a child or a parent. The sender's
      // WhatsApp name sits under "Myself" so they can see whose name it books.
      const selfName = cleanProfileName(inbound.profileName);
      const rows: ListRow[] =
        step.patients.length === 0
          ? [
              {
                id: 'patient:self',
                title: fitListTitle(p.selfTitle),
                ...(selfName ? { description: fitListTitle(selfName) } : {}),
              },
              {
                id: 'patient:new',
                title: fitListTitle(p.otherTitle),
                description: fitListTitle(p.otherDesc),
              },
            ]
          : [
              ...step.patients.slice(0, 8).map((pt) => ({
                id: `patient:${pt.id}`,
                title: fitListTitle(pt.age ? `${pt.name} (${pt.age})` : pt.name),
              })),
              {
                id: 'patient:new',
                title: fitListTitle(p.newPatientTitle),
              },
            ];
      await sendList(p.choiceBody, rows, 'conversation:patient_choice');
      break;
    }

    case 'ask_patient_name_age': {
      const p = PATIENT_PROMPTS[locale];
      await sendText(p.askNameAge, 'conversation:patient_name_age');
      break;
    }

    case 'ask_doctor': {
      const tags = MODE_TAGS[locale];
      await sendList(
        prompts.doctor,
        doctors.slice(0, 10).map((doctor) => {
          const modeTag =
            doctor.mode === 'both' ? tags.both : doctor.mode === 'queue' ? tags.queue : tags.slot;
          const desc = doctor.specialty ? `${doctor.specialty} (${modeTag})` : `(${modeTag})`;
          return {
            id: `doc:${doctor.id}`,
            title: fitListTitle(formatDoctorName(doctor.name, locale)),
            description: fitListTitle(desc),
          };
        }),
        'conversation:doctor',
      );
      break;
    }

    case 'ask_queue_branch': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;

      const p = QUEUE_BRANCH_PROMPTS[locale];
      await sendButtons(
        p.body(doctor.name),
        [
          { id: 'queue_choice:join', title: p.joinTitle },
          { id: 'queue_choice:slot', title: p.slotTitle },
        ],
        'conversation:queue_branch',
      );
      break;
    }

    case 'show_queue_wait_time': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;

      const snapshot = await getQueueSnapshot({
        hospitalId,
        doctorId: doctor.id,
        timezone: 'Asia/Kolkata',
      });

      const currentServing = servingLabel(snapshot, locale);
      // Everyone with the doctor or waiting is ahead of a patient joining now.
      const patientsAhead = snapshot?.rows.length ?? 0;
      const waitLine = WAIT_LINE[locale](
        waitInfoFor(snapshot ? estimateForNewJoiner(snapshot) : null, 'Asia/Kolkata'),
      );

      const p = QUEUE_WAIT_TIME_PROMPTS[locale];
      await sendButtons(
        withBreakNote(
          p.body(doctor.name, currentServing, patientsAhead, waitLine),
          locale,
          snapshot?.paused ?? false,
        ),
        [{ id: 'queue_choice:join', title: p.joinTitle }],
        'conversation:show_wait_time',
      );
      break;
    }

    case 'confirm_queue': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;

      const pName =
        step.patientName ??
        transition.context.patientName ??
        (await existingName(hospitalId, phoneE164)) ??
        cleanProfileName(inbound.profileName) ??
        FALLBACK_PATIENT_NAME;
      const pAge = step.patientAge ?? transition.context.patientAge;

      let created: Awaited<ReturnType<typeof createWalkIn>>;
      try {
        created = await createWalkIn({
          hospitalId,
          branchId: doctor.branchId,
          doctorId: doctor.id,
          timezone: 'Asia/Kolkata',
          patient: {
            phoneE164,
            name: pName,
            age: pAge,
            locale,
          },
          source: 'whatsapp',
          whatsappOptIn: true,
          confirmationSentInChat: true,
        });
      } catch (error) {
        if (!(error instanceof CapacityError)) throw error;
        // Not open yet, or full: say so in the chat (free), and issue nothing.
        const opensAt = error.opensAt ? formatTimeIn('Asia/Kolkata', error.opensAt) : null;
        const sent = await provider.sendText({
          phoneNumberId: inbound.phoneNumberId,
          toPhoneE164: phoneE164,
          body: QUEUE_UNAVAILABLE[locale](doctor.name, opensAt, error.code === 'QUEUE_CLOSED'),
        });
        await withTenant(hospitalId, (tx) =>
          tx.insert(notificationOutbox).values({
            hospitalId,
            milestone: 'conversation:queue_unavailable',
            templateCode: 'conversation',
            locale,
            payload: { doctorId: doctor.id, reason: error.code },
            status: 'sent',
            providerMessageId: sent.providerMessageId,
            sentAt: new Date(),
          }),
        );
        break;
      }

      const snapshot = await getQueueSnapshot({
        hospitalId,
        doctorId: doctor.id,
        timezone: 'Asia/Kolkata',
      });
      // The same "ahead" and estimate the patient's link shows, so the chat
      // and the page never disagree.
      const view = await getPublicQueueView(created.publicToken);

      const currentServing = servingLabel(snapshot, locale);
      const waitLine = WAIT_LINE[locale](
        waitInfoFor(view?.etaState === 'not_started' ? null : (view?.eta ?? null), 'Asia/Kolkata'),
      );

      const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
      const patientDisplay = pAge ? `${pName} (${pAge} yrs)` : pName;
      const sent = await provider.sendText({
        phoneNumberId: inbound.phoneNumberId,
        toPhoneE164: phoneE164,
        body: withBreakNote(
          QUEUE_CONFIRMATION[locale](
            created.tokenNumber,
            doctor.name,
            patientDisplay,
            currentServing,
            waitLine,
            `${baseUrl}/q/${created.publicToken}`,
          ),
          locale,
          snapshot?.paused ?? false,
        ),
      });

      await recordChatConfirmation(created.appointment, sent.providerMessageId);
      break;
    }

    case 'ask_slot': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;
      const doctorDisplayName = formatDoctorName(doctor.name, locale);

      const scheduleResult = await getDoctorSlotsForDate({
        hospitalId,
        doctorId: doctor.id,
        serviceDate: today,
      });
      const availableSlots = scheduleResult.slots.filter((s) => s.available);

      const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
      const bookUrl = `${baseUrl}/book?doctor=${doctor.id}&phone=${encodeURIComponent(phoneE164)}&hospital=${hospitalId}&locale=${locale}`;

      if (availableSlots.length === 0) {
        const sent = await provider.sendText({
          phoneNumberId: inbound.phoneNumberId,
          toPhoneE164: phoneE164,
          body: REDIRECT_WEB[locale](doctor.name, bookUrl),
        });
        await withTenant(hospitalId, (tx) =>
          tx.insert(notificationOutbox).values({
            hospitalId,
            milestone: 'conversation:redirect_web_slot',
            templateCode: 'conversation',
            locale,
            payload: { doctorId: doctor.id, url: bookUrl },
            status: 'sent',
            providerMessageId: sent.providerMessageId,
            sentAt: new Date(),
          }),
        );
        break;
      }

      const promptBody =
        locale === 'mr'
          ? `${doctorDisplayName} वेळेनुसार अपॉइंटमेंट घेतात. उपलब्ध वेळ निवडा:`
          : locale === 'hi'
            ? `${doctorDisplayName} निर्धारित अपॉइंटमेंट लेते हैं। उपलब्ध समय चुनें:`
            : `${doctorDisplayName} takes scheduled appointments. Choose an available time:`;

      const firstSlot = availableSlots[0];
      const nowTitle =
        locale === 'mr'
          ? `आताचा वेळ (${firstSlot.timeStr})`
          : locale === 'hi'
            ? `अभी का समय (${firstSlot.timeStr})`
            : `Coming now (${firstSlot.timeStr})`;

      const laterTitle =
        locale === 'mr'
          ? 'वेबसाईटवर वेळ निवडा'
          : locale === 'hi'
            ? 'वेबसाइट पर समय चुनें'
            : 'Select slot on web';

      const rows: ListRow[] = [
        {
          id: 'slot:now',
          title: fitListTitle(nowTitle),
          description: fitListTitle(firstSlot.timeStr),
        },
      ];

      for (const slot of availableSlots.slice(1, 6)) {
        rows.push({
          id: `slot:${slot.datetimeIso}`,
          title: fitListTitle(slot.timeStr),
        });
      }

      rows.push({
        id: 'slot:later',
        title: fitListTitle(laterTitle),
        description: fitListTitle('More dates & times'),
      });

      await sendList(promptBody, rows, 'conversation:slot');
      break;
    }

    case 'confirm_slot': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;

      const pName =
        step.patientName ??
        transition.context.patientName ??
        (await existingName(hospitalId, phoneE164)) ??
        cleanProfileName(inbound.profileName) ??
        FALLBACK_PATIENT_NAME;
      const pAge = step.patientAge ?? transition.context.patientAge;
      const patientDisplay = pAge ? `${pName} (${pAge} yrs)` : pName;

      let slotIso: string | undefined;
      let slotDisplayTime: string | undefined;

      if (step.slot === 'now') {
        const scheduleResult = await getDoctorSlotsForDate({
          hospitalId,
          doctorId: doctor.id,
          serviceDate: today,
        });
        const availableSlots = scheduleResult.slots.filter((s) => s.available);
        if (availableSlots.length > 0) {
          slotIso = availableSlots[0].datetimeIso;
          slotDisplayTime = availableSlots[0].timeStr;
        }
      } else {
        const slotDate = new Date(step.slot);
        if (!isNaN(slotDate.getTime())) {
          slotIso = step.slot;
        }
      }

      const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';

      if (!slotIso) {
        const bookUrl = `${baseUrl}/book?doctor=${doctor.id}&phone=${encodeURIComponent(phoneE164)}&hospital=${hospitalId}&locale=${locale}`;
        const sent = await provider.sendText({
          phoneNumberId: inbound.phoneNumberId,
          toPhoneE164: phoneE164,
          body: REDIRECT_WEB[locale](doctor.name, bookUrl),
        });
        await withTenant(hospitalId, (tx) =>
          tx.insert(notificationOutbox).values({
            hospitalId,
            milestone: 'conversation:redirect_web_slot',
            templateCode: 'conversation',
            locale,
            payload: { doctorId: doctor.id, url: bookUrl },
            status: 'sent',
            providerMessageId: sent.providerMessageId,
            sentAt: new Date(),
          }),
        );
        break;
      }

      let booked: Awaited<ReturnType<typeof bookScheduledSlot>>;
      try {
        booked = await bookScheduledSlot({
          hospitalId,
          doctorId: doctor.id,
          patientName: pName,
          patientAge: pAge,
          phoneE164,
          slotDatetimeIso: slotIso,
          locale,
          confirmationSentInChat: true,
        });
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        // The slot went between showing the list and the tap. Send the booking
        // page rather than silence, so the patient can pick another time.
        const bookUrl = `${baseUrl}/book?doctor=${doctor.id}&phone=${encodeURIComponent(phoneE164)}&hospital=${hospitalId}&locale=${locale}`;
        const sent = await provider.sendText({
          phoneNumberId: inbound.phoneNumberId,
          toPhoneE164: phoneE164,
          body: REDIRECT_WEB[locale](doctor.name, bookUrl),
        });
        await withTenant(hospitalId, (tx) =>
          tx.insert(notificationOutbox).values({
            hospitalId,
            milestone: 'conversation:redirect_web_slot',
            templateCode: 'conversation',
            locale,
            payload: { doctorId: doctor.id, url: bookUrl, reason: error.code },
            status: 'sent',
            providerMessageId: sent.providerMessageId,
            sentAt: new Date(),
          }),
        );
        break;
      }

      const formattedTime = slotDisplayTime ?? booked.slotTimeFormatted;
      const timeString =
        locale === 'mr'
          ? `आज ${formattedTime} वाजता`
          : locale === 'hi'
            ? `आज ${formattedTime} बजे`
            : `Today at ${formattedTime}`;

      const sent = await provider.sendText({
        phoneNumberId: inbound.phoneNumberId,
        toPhoneE164: phoneE164,
        body: SLOT_CONFIRMATION[locale](
          doctor.name,
          patientDisplay,
          timeString,
          // "S3" for an evening slot-session booking.
          booked.tokenLabel,
          `${baseUrl}/q/${booked.publicToken}`,
        ),
      });

      await recordChatConfirmation(booked.appointment, sent.providerMessageId);
      break;
    }

    case 'redirect_web_slot': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;

      const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
      const bookUrl = `${baseUrl}/book?doctor=${doctor.id}&phone=${encodeURIComponent(phoneE164)}&hospital=${hospitalId}&locale=${locale}`;
      const sent = await provider.sendText({
        phoneNumberId: inbound.phoneNumberId,
        toPhoneE164: phoneE164,
        body: REDIRECT_WEB[locale](doctor.name, bookUrl),
      });

      await withTenant(hospitalId, (tx) =>
        tx.insert(notificationOutbox).values({
          hospitalId,
          milestone: 'conversation:redirect_web_slot',
          templateCode: 'conversation',
          locale,
          payload: { doctorId: doctor.id, url: bookUrl },
          status: 'sent',
          providerMessageId: sent.providerMessageId,
          sentAt: new Date(),
        }),
      );
      break;
    }

    case 'none':
      break;
  }

  await saveConversation({
    hospitalId,
    phoneE164,
    state: transition.state,
    context: transition.context,
    lastPromptStep: decision.send ? transition.step.kind : conversation.lastPromptStep,
    lastPromptAt: decision.send ? now : conversation.lastPromptAt,
    promptsToday: promptsSent,
    promptsDate: today,
  });
}

async function loadConversation(hospitalId: string, phoneE164: string) {
  return withTenant(hospitalId, async (tx) => {
    const [conversation] = await tx
      .select()
      .from(whatsappConversations)
      .where(
        and(
          eq(whatsappConversations.hospitalId, hospitalId),
          eq(whatsappConversations.phoneE164, phoneE164),
        ),
      );

    const patientRows = await tx
      .select({
        id: patients.id,
        name: patients.name,
        age: patients.age,
        gender: patients.gender,
        locale: patients.locale,
      })
      .from(patients)
      .where(
        // ACTIVE records only: a merged duplicate is reached through its survivor.
        and(eq(patients.hospitalId, hospitalId), eq(patients.phoneE164, phoneE164), isNull(patients.mergedIntoId)),
      );

    const firstPatient = patientRows[0];

    return {
      state: (conversation?.state ?? 'idle') as ConversationState,
      context: (conversation?.context ?? {}) as BookingContext,
      knownLocale: (firstPatient?.locale ?? null) as Locale | null,
      knownPatients: patientRows.map((p) => ({
        id: p.id,
        name: p.name,
        age: p.age,
        gender: p.gender,
      })),
      lastPromptStep: conversation?.lastPromptStep ?? null,
      lastPromptAt: conversation?.lastPromptAt ?? null,
      promptsToday: conversation?.promptsToday ?? 0,
      promptsDate: conversation?.promptsDate ?? null,
    };
  });
}

/**
 * The name already on file for this number, or null.
 *
 * Returns null rather than a placeholder so the caller's fallback chain can
 * tell "no record yet" from "a record that happens to be badly named" — the
 * distinction that decides whether the WhatsApp profile name should be used.
 */
async function existingName(hospitalId: string, phoneE164: string): Promise<string | null> {
  const found = await withTenant(hospitalId, async (tx) => {
    const [patient] = await tx
      .select({ name: patients.name })
      .from(patients)
      .where(
        // ACTIVE records only: a merged duplicate is reached through its survivor.
        and(eq(patients.hospitalId, hospitalId), eq(patients.phoneE164, phoneE164), isNull(patients.mergedIntoId)),
      );
    return patient?.name ?? null;
  });

  /**
   * A stored placeholder counts as no name at all.
   *
   * Every booking made before the parser captured the profile name landed on
   * this string, and treating it as a real record would make those numbers
   * permanently anonymous — the profile name sits below the stored name in the
   * fallback chain, so it would never get a chance. Discounting it here lets
   * the next message from that number book under the patient's actual name.
   *
   * The old row is left alone rather than renamed. `patients` is keyed on
   * (hospital, phone, name) so that one handset can hold a family's profiles,
   * which means a rename is not an update but a collision risk — and those
   * rows are attached to appointments that really did happen under that name.
   */
  return found === FALLBACK_PATIENT_NAME ? null : found;
}

async function saveConversation(args: {
  hospitalId: string;
  phoneE164: string;
  state: ConversationState;
  context: BookingContext;
  lastPromptStep: string | null;
  lastPromptAt: Date | null;
  promptsToday: number;
  promptsDate: string;
}) {
  await withTenant(args.hospitalId, (tx) =>
    tx
      .insert(whatsappConversations)
      .values({
        hospitalId: args.hospitalId,
        phoneE164: args.phoneE164,
        state: args.state,
        context: args.context,
        lastInboundAt: new Date(),
        lastPromptStep: args.lastPromptStep,
        lastPromptAt: args.lastPromptAt,
        promptsToday: args.promptsToday,
        promptsDate: args.promptsDate,
      })
      .onConflictDoUpdate({
        target: [whatsappConversations.hospitalId, whatsappConversations.phoneE164],
        set: {
          state: args.state,
          context: args.context,
          lastInboundAt: new Date(),
          lastPromptStep: args.lastPromptStep,
          lastPromptAt: args.lastPromptAt,
          promptsToday: args.promptsToday,
          promptsDate: args.promptsDate,
          updatedAt: new Date(),
        },
      }),
  );

  if (args.context.locale) {
    await withTenant(args.hospitalId, (tx) =>
      tx
        .update(patients)
        .set({ locale: args.context.locale })
        .where(
          and(
            eq(patients.hospitalId, args.hospitalId),
            eq(patients.phoneE164, args.phoneE164),
          ),
        ),
    );
  }
}

export { t as patientStrings };
