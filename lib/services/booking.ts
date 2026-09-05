import { and, eq, sql } from 'drizzle-orm';
import { getDb, withTenant } from '@/lib/db';
import {
  idempotencyKeys,
  notificationOutbox,
  patients,
  whatsappConversations,
} from '@/lib/db/schema';
import {
  fitListTitle,
  nextBookingStep,
  shouldSendPrompt,
  type BookingContext,
  type ConversationState,
} from '@/lib/domain/booking';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import { serviceDateIn } from '@/lib/domain/time';
import { LOCALE_NAMES, LOCALES, t, type Locale } from '@/lib/i18n/patient';
import { getProvider, type ListRow } from '@/lib/notify/provider';
import { listDoctors } from './hospital';
import { createWalkIn } from './queue';

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
    slot: 'तुम्ही कधी येणार आहात?',
    pick: 'निवडा',
  },
  hi: {
    language: 'कृपया अपनी भाषा चुनें',
    doctor: 'आप किस डॉक्टर से मिलना चाहते हैं?',
    slot: 'आप कब आ रहे हैं?',
    pick: 'चुनें',
  },
  en: {
    language: 'Please choose your language',
    doctor: 'Which doctor would you like to see?',
    slot: 'When are you coming in?',
    pick: 'Choose',
  },
};

/**
 * Confirmation sent the instant a booking completes.
 *
 * Free-form rather than the queue_link template, because the patient has just
 * messaged us and that opens a 24-hour window in which plain messages need no
 * approval. Three things follow: the booking path does not wait on Meta's
 * template review, the patient gets an answer in the same second rather than
 * whenever the worker next drains, and it costs exactly the same one message.
 *
 * The template still earns its place for walk-ins, where reception adds a
 * patient who has not messaged us and no window is open.
 */
const CONFIRMATION: Record<Locale, (token: number, doctor: string, url: string) => string> = {
  mr: (token, doctor, url) =>
    `तुमची अपॉइंटमेंट नोंदवली आहे.

टोकन क्रमांक: ${token}
डॉक्टर: ${doctor}

रांगेतील तुमची सद्यस्थिती इथे पाहा:
${url}

तुम्ही बाहेर थांबू शकता — तुमचा नंबर जवळ आल्यावर आम्ही कळवू.`,
  hi: (token, doctor, url) =>
    `आपकी अपॉइंटमेंट दर्ज हो गई है।

टोकन नंबर: ${token}
डॉक्टर: ${doctor}

कतार में अपनी स्थिति यहाँ देखें:
${url}

आप बाहर इंतज़ार कर सकते हैं — आपकी बारी पास आने पर हम सूचित करेंगे।`,
  en: (token, doctor, url) =>
    `Your appointment is booked.

Token number: ${token}
Doctor: ${doctor}

Track your position in the queue here:
${url}

You can wait outside — we will message you when your turn is close.`,
};

const SLOT_ROWS: Record<Locale, ListRow[]> = {
  mr: [
    { id: 'slot:now', title: 'आता येत आहे' },
    { id: 'slot:later', title: 'आज नंतर' },
  ],
  hi: [
    { id: 'slot:now', title: 'अभी आ रहा हूँ' },
    { id: 'slot:later', title: 'आज बाद में' },
  ],
  en: [
    { id: 'slot:now', title: 'Coming now' },
    { id: 'slot:later', title: 'Later today' },
  ],
};

/**
 * Handles one inbound WhatsApp message.
 *
 * Deliberately tolerant: a patient who types nonsense, taps a stale button, or
 * comes back a week later gets a clean restart rather than an error. The one
 * thing it must never do is process the same webhook twice.
 */
export async function handleInboundMessage(inbound: InboundWhatsApp): Promise<void> {
  const db = getDb();

  // Which hospital owns this WhatsApp number. Bootstrap lookup, same contract
  // as the other two: one identifier in, one hospital id out.
  const [resolved] = await db.execute<{ hospital_id: string | null }>(
    sql`select public.resolve_whatsapp_number(${inbound.phoneNumberId}) as hospital_id`,
  );
  const hospitalId = resolved?.hospital_id;
  if (!hospitalId) return;

  const phoneE164 = normalizeIndianPhone(inbound.fromPhone);
  if (!phoneE164) return;

  // Replay protection. Meta redelivers on any non-2xx, and a redelivered
  // booking would otherwise issue a second token.
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

  const doctors = await listDoctors({ hospitalId });
  if (doctors.length === 0) return;

  const conversation = await loadConversation(hospitalId, phoneE164);
  const { state, context, knownLocale } = conversation;

  const transition = nextBookingStep({
    state,
    context,
    message: { replyId: inbound.replyId, text: inbound.text },
    knownLocale,
    availableDoctorIds: doctors.map((doctor) => doctor.id),
  });

  const locale = transition.context.locale ?? knownLocale ?? 'en';
  const provider = getProvider();
  const prompts = PROMPTS[locale];

  const now = new Date();
  const today = serviceDateIn('Asia/Kolkata', now);
  // Yesterday's count must not bleed into today's budget.
  const promptsToday = conversation.promptsDate === today ? conversation.promptsToday : 0;

  const decision = shouldSendPrompt({
    step: transition.step.kind,
    lastPromptStep: conversation.lastPromptStep,
    lastPromptAt: conversation.lastPromptAt,
    promptsToday,
    now,
  });

  let promptsSent = promptsToday;

  const send = async (bodyText: string, rows: ListRow[], milestone: string) => {
    /**
     * The patient already has this exact menu in their thread and it is still
     * tappable, so repeating it buys nothing and costs a message. Staying quiet
     * is the better answer for them as well as for us.
     */
    if (!decision.send) return;
    promptsSent += 1;

    const result = await provider.sendInteractiveList({
      phoneNumberId: inbound.phoneNumberId,
      toPhoneE164: phoneE164,
      bodyText,
      buttonText: prompts.pick,
      rows,
    });

    // Recorded so conversation traffic counts towards messages-per-appointment.
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

  const step = transition.step;
  switch (step.kind) {
    case 'ask_language':
      await send(
        LOCALES.map((code) => PROMPTS[code].language).join('\n'),
        LOCALES.map((code) => ({ id: `lang:${code}`, title: LOCALE_NAMES[code] })),
        'conversation:language',
      );
      break;

    case 'ask_doctor':
      await send(
        prompts.doctor,
        doctors.slice(0, 10).map((doctor) => ({
          id: `doc:${doctor.id}`,
          title: fitListTitle(doctor.name),
          description: doctor.specialty ? fitListTitle(doctor.specialty) : undefined,
        })),
        'conversation:doctor',
      );
      break;

    case 'ask_slot':
      await send(prompts.slot, SLOT_ROWS[locale], 'conversation:slot');
      break;

    case 'confirm': {
      const doctor = doctors.find((d) => d.id === step.doctorId);
      if (!doctor) break;

      /**
       * The token link IS the confirmation, so booking costs one message here
       * rather than a confirmation followed by a link. createWalkIn queues it
       * through the outbox like any other, which keeps de-duplication and the
       * circuit breaker on the same path.
       */
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
        // A patient who messaged this number first has given about as clear an
        // affirmative consent to be replied to as exists.
        whatsappOptIn: true,
      });

      const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
      const sent = await provider.sendText({
        phoneNumberId: inbound.phoneNumberId,
        toPhoneE164: phoneE164,
        body: CONFIRMATION[locale](
          created.tokenNumber,
          doctor.name,
          `${baseUrl}/q/${created.publicToken}`,
        ),
      });

      /**
       * createWalkIn queued the queue_link template for the worker. It has now
       * been delivered by other means, so close the row out rather than leaving
       * the worker to send the patient a second copy.
       */
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

    case 'none':
      break;
  }

  await saveConversation({
    hospitalId,
    phoneE164,
    state: transition.state,
    context: transition.context,
    // Only record a prompt we actually sent, or the cooldown would restart on
    // every suppressed message and quietly become permanent.
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
      // Language remembered against the patient, not the conversation: this is
      // what makes a returning patient's booking cost one message less.
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

  // Reception fills in the real name at the desk; a placeholder is better than
  // interrogating a patient over WhatsApp for data we do not strictly need.
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

  // Persist the chosen language on the patient so it survives the conversation.
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
