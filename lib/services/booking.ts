import { and, desc, eq, sql } from 'drizzle-orm';
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
  fitListTitle,
  nextBookingStep,
  shouldSendPrompt,
  type ActiveAppointmentInfo,
  type BookingContext,
  type ConversationState,
} from '@/lib/domain/booking';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import { serviceDateIn } from '@/lib/domain/time';
import { LOCALE_NAMES, LOCALES, t, type Locale } from '@/lib/i18n/patient';
import { getProvider, type InteractiveButton, type ListRow } from '@/lib/notify/provider';
import { listDoctors } from './hospital';
import { createWalkIn, getQueueSnapshot } from './queue';

export type InboundWhatsApp = {
  phoneNumberId: string;
  messageId: string;
  fromPhone: string;
  text?: string;
  replyId?: string;
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

const MODE_TAGS: Record<Locale, { queue: string; slot: string }> = {
  mr: { queue: 'आज थेट रांग', slot: 'वेळ निवडा' },
  hi: { queue: 'आज लाइव कतार', slot: 'समय स्लॉट बुक करें' },
  en: { queue: 'Live queue today', slot: 'Book a time slot' },
};

const QUEUE_BRANCH_PROMPTS: Record<
  Locale,
  {
    body: (doctorName: string) => string;
    joinTitle: string;
    waitTitle: string;
  }
> = {
  mr: {
    body: (doctorName) =>
      `डॉ. ${doctorName} आज थेट रांगेवर रुग्ण पाहत आहेत — रुग्णांना त्यांच्या येण्याच्या क्रमाने पाहिले जाते, ठरलेल्या वेळेनुसार नाही.`,
    joinTitle: 'रांगेत सामील व्हा',
    waitTitle: 'प्रतीक्षा वेळ पाहा',
  },
  hi: {
    body: (doctorName) =>
      `डॉ. ${doctorName} आज लाइव कतार पर मरीज़ों को देख रहे हैं — मरीज़ों को उनके आने के क्रम में देखा जाता है, निश्चित समय पर नहीं।`,
    joinTitle: 'कतार में शामिल हों',
    waitTitle: 'पहले प्रतीक्षा समय देखें',
  },
  en: {
    body: (doctorName) =>
      `Dr. ${doctorName} is seeing patients today on a live queue — patients are seen in the order they arrive, not by fixed appointment time.`,
    joinTitle: 'Join queue now',
    waitTitle: 'See wait time first',
  },
};

const QUEUE_WAIT_TIME_PROMPTS: Record<
  Locale,
  {
    body: (doctorName: string, serving: number | string, ahead: number, wait: number) => string;
    joinTitle: string;
  }
> = {
  mr: {
    body: (doctorName, serving, ahead, wait) =>
      `डॉ. ${doctorName} — थेट रांग माहिती:

सध्या तपासणी सुरू: ${serving}
तुमच्या आधी रुग्ण: ${ahead}
अंदाजे प्रतीक्षा: ~${wait} मिनिटे

तुम्ही तयार असाल तेव्हा खालील बटण दाबून रांगेत सामील व्हा.`,
    joinTitle: 'रांगेत सामील व्हा',
  },
  hi: {
    body: (doctorName, serving, ahead, wait) =>
      `डॉ. ${doctorName} — लाइव कतार स्थिति:

वर्तमान में सेवारत: ${serving}
आपसे पहले मरीज़: ${ahead}
अनुमानित प्रतीक्षा: ~${wait} मिनट

जब आप तैयार हों, तब नीचे बटन दबाकर कतार में शामिल हों।`,
    joinTitle: 'कतार में शामिल हों',
  },
  en: {
    body: (doctorName, serving, ahead, wait) =>
      `Dr. ${doctorName} — Live Queue Status:

Currently serving: ${serving}
Patients ahead: ${ahead}
Estimated wait: ~${wait} min

Tap below to join the queue whenever you are ready.`,
    joinTitle: 'Join queue now',
  },
};

const QUEUE_CONFIRMATION: Record<
  Locale,
  (token: number, doctor: string, serving: number | string, wait: number, url: string) => string
> = {
  mr: (token, doctor, serving, wait, url) =>
    `तुम्ही डॉ. ${doctor} यांच्या रांगेत सामील झाला आहात.

तुमचा टोकन क्रमांक: ${token}
सध्या तपासणी सुरू: ${serving}
अंदाजे प्रतीक्षा: ~${wait} मिनिटे

रांगेतील स्थिती पाहा: ${url}

तुम्ही बाहेर थांबू शकता — तुमचा नंबर जवळ आल्यावर आम्ही कळवू.`,
  hi: (token, doctor, serving, wait, url) =>
    `आप डॉ. ${doctor} की कतार में शामिल हो गए हैं।

आपका टोकन नंबर: ${token}
वर्तमान में सेवारत: ${serving}
अनुमानित प्रतीक्षा: ~${wait} मिनट

कतार स्थिति देखें: ${url}

आप बाहर इंतज़ार कर सकते हैं — आपकी बारी पास आने पर हम सूचित करेंगे।`,
  en: (token, doctor, serving, wait, url) =>
    `You're in the queue for Dr. ${doctor}.

Your token number: ${token}
Currently serving: ${serving}
Estimated wait: ~${wait} min

Track position: ${url}

You don't need to wait inside — we'll message you when your token is close.`,
};

const SLOT_CONFIRMATION: Record<Locale, (doctor: string, datetime: string) => string> = {
  mr: (doctor, datetime) =>
    `तुमची अपॉइंटमेंट निश्चित झाली आहे.

डॉक्टर: डॉ. ${doctor}
तारीख व वेळ: ${datetime}

आम्ही अपॉइंटमेंटपूर्वी तुम्हाला स्मरणपत्र पाठवू.`,
  hi: (doctor, datetime) =>
    `आपकी अपॉइंटमेंट की पुष्टि हो गई है।

डॉक्टर: डॉ. ${doctor}
दिनांक और समय: ${datetime}

हम आपकी अपॉइंटमेंट से पहले आपको स्मरण पत्र भेजेंगे।`,
  en: (doctor, datetime) =>
    `Your appointment is confirmed.

Doctor: Dr. ${doctor}
Date & time: ${datetime}

We'll send you a reminder before your appointment.`,
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
डॉक्टर: डॉ. ${doctor}

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
डॉक्टर: डॉ. ${doctor}

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
Doctor: Dr. ${doctor}

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
डॉक्टर: डॉ. ${doctor}

रांगेतील सद्यस्थिती इथे पाहा:
${url}`,
  hi: (doctor, token, url) =>
    `आपकी वर्तमान अपॉइंटमेंट का विवरण:

टोकन नंबर: ${token}
डॉक्टर: डॉ. ${doctor}

कतार में अपनी स्थिति यहाँ देखें:
${url}`,
  en: (doctor, token, url) =>
    `Here are your active appointment details:

Token number: ${token}
Doctor: Dr. ${doctor}

Track your position in the queue here:
${url}`,
};

const REDIRECT_WEB: Record<Locale, (doctor: string, url: string) => string> = {
  mr: (doctor, url) =>
    `डॉ. ${doctor} यांच्याकडे अपॉइंटमेंटची वेळ निवडण्यासाठी, कृपया आमच्या वेबसाईटवर उपलब्ध स्लॉट निवडा:

${url}

आम्ही अपॉइंटमेंटपूर्वी तुम्हाला स्मरणपत्र पाठवू.`,
  hi: (doctor, url) =>
    `डॉ. ${doctor} के साथ अपॉइंटमेंट का समय चुनने के लिए, कृपया हमारी वेबसाइट पर उपलब्ध स्लॉट चुनें:

${url}

हम आपकी अपॉइंटमेंट से पहले आपको स्मरण पत्र भेजेंगे।`,
  en: (doctor, url) =>
    `To choose your appointment time for Dr. ${doctor}, please select an available slot on our website:

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
 * Handles one inbound WhatsApp message.
 */
export async function handleInboundMessage(inbound: InboundWhatsApp): Promise<void> {
  const db = getDb();

  const [resolved] = await db.execute<{ hospital_id: string | null }>(
    sql`select public.resolve_whatsapp_number(${inbound.phoneNumberId}) as hospital_id`,
  );
  const hospitalId = resolved?.hospital_id;
  if (!hospitalId) return;

  const phoneE164 = normalizeIndianPhone(inbound.fromPhone);
  if (!phoneE164) return;

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
  if (!claimed) return;

  const now = new Date();
  const today = serviceDateIn('Asia/Kolkata', now);

  const doctors = await listDoctors({ hospitalId, serviceDate: today });
  if (doctors.length === 0) return;

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

  const sendList = async (bodyText: string, rows: ListRow[], milestone: string) => {
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

    case 'ask_doctor': {
      const tags = MODE_TAGS[locale];
      await sendList(
        prompts.doctor,
        doctors.slice(0, 10).map((doctor) => {
          const modeTag = doctor.mode === 'queue' ? tags.queue : tags.slot;
          const desc = doctor.specialty ? `${doctor.specialty} (${modeTag})` : `(${modeTag})`;
          return {
            id: `doc:${doctor.id}`,
            title: fitListTitle(doctor.name),
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
          { id: 'queue_choice:wait', title: p.waitTitle },
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

      const currentServing = snapshot?.currentToken ?? 1;
      const patientsAhead = snapshot?.waitingCount ?? 0;
      const consultMin = snapshot?.medianConsultMinutes ?? doctor.defaultConsultMinutes;
      const waitMinutes = Math.max(5, patientsAhead * consultMin);

      const p = QUEUE_WAIT_TIME_PROMPTS[locale];
      await sendButtons(
        p.body(doctor.name, currentServing, patientsAhead, waitMinutes),
        [{ id: 'queue_choice:join', title: p.joinTitle }],
        'conversation:show_wait_time',
      );
      break;
    }

    case 'confirm_queue': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;

      const created = await createWalkIn({
        hospitalId,
        branchId: doctor.branchId,
        doctorId: doctor.id,
        timezone: 'Asia/Kolkata',
        patient: {
          phoneE164,
          name: await existingName(hospitalId, phoneE164),
          locale,
        },
        source: 'whatsapp',
        whatsappOptIn: true,
      });

      const snapshot = await getQueueSnapshot({
        hospitalId,
        doctorId: doctor.id,
        timezone: 'Asia/Kolkata',
      });

      const currentServing = snapshot?.currentToken ?? 1;
      const patientsAhead = Math.max(0, (snapshot?.waitingCount ?? 1) - 1);
      const consultMin = snapshot?.medianConsultMinutes ?? doctor.defaultConsultMinutes;
      const waitMinutes = Math.max(5, patientsAhead * consultMin);

      const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
      const sent = await provider.sendText({
        phoneNumberId: inbound.phoneNumberId,
        toPhoneE164: phoneE164,
        body: QUEUE_CONFIRMATION[locale](
          created.tokenNumber,
          doctor.name,
          currentServing,
          waitMinutes,
          `${baseUrl}/q/${created.publicToken}`,
        ),
      });

      await withTenant(hospitalId, (tx) =>
        tx
          .update(notificationOutbox)
          .set({
            status: 'sent',
            providerMessageId: sent.providerMessageId,
            sentAt: new Date(),
          })
          .where(
            and(
              eq(notificationOutbox.appointmentId, created.appointment.id),
              eq(notificationOutbox.milestone, 'queue_link'),
            ),
          ),
      );
      break;
    }

    case 'ask_slot': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      const doctorName = doctor?.name ?? '';
      const promptBody =
        locale === 'mr'
          ? `डॉ. ${doctorName} वेळेनुसार अपॉइंटमेंट घेतात. उपलब्ध वेळ निवडा:`
          : locale === 'hi'
            ? `डॉ. ${doctorName} निर्धारित अपॉइंटमेंट लेते हैं। उपलब्ध समय चुनें:`
            : `Dr. ${doctorName} takes scheduled appointments. Choose an available time:`;

      await sendList(promptBody, SLOT_ROWS[locale], 'conversation:slot');
      break;
    }

    case 'confirm_slot': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;

      const timeString = step.slot === 'now' ? 'Today (Next Available Slot)' : 'Today (Scheduled)';
      const sent = await provider.sendText({
        phoneNumberId: inbound.phoneNumberId,
        toPhoneE164: phoneE164,
        body: SLOT_CONFIRMATION[locale](doctor.name, timeString),
      });

      await withTenant(hospitalId, (tx) =>
        tx.insert(notificationOutbox).values({
          hospitalId,
          milestone: 'conversation:confirm_slot',
          templateCode: 'conversation',
          locale,
          payload: { doctorId: doctor.id, slot: step.slot },
          status: 'sent',
          providerMessageId: sent.providerMessageId,
          sentAt: new Date(),
        }),
      );
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

    const [patient] = await tx
      .select({ locale: patients.locale })
      .from(patients)
      .where(
        and(eq(patients.hospitalId, hospitalId), eq(patients.phoneE164, phoneE164)),
      );

    return {
      state: (conversation?.state ?? 'idle') as ConversationState,
      context: (conversation?.context ?? {}) as BookingContext,
      knownLocale: (patient?.locale ?? null) as Locale | null,
      lastPromptStep: conversation?.lastPromptStep ?? null,
      lastPromptAt: conversation?.lastPromptAt ?? null,
      promptsToday: conversation?.promptsToday ?? 0,
      promptsDate: conversation?.promptsDate ?? null,
    };
  });
}

async function existingName(hospitalId: string, phoneE164: string): Promise<string> {
  const found = await withTenant(hospitalId, async (tx) => {
    const [patient] = await tx
      .select({ name: patients.name })
      .from(patients)
      .where(
        and(eq(patients.hospitalId, hospitalId), eq(patients.phoneE164, phoneE164)),
      );
    return patient?.name ?? null;
  });

  return found ?? 'WhatsApp patient';
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
