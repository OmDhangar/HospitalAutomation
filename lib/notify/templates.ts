import type { Locale } from '@/lib/i18n/patient';

export type TemplateCode =
  | 'queue_link'
  | 'appointment_confirmed'
  | 'queue_milestone'
  | 'slot_reminder'
  | 'slot_disrupted'
  | 'queue_skipped'
  | 'appointment_cancelled'
  | 'doctor_delayed'
  | 'owner_monthly_report';

/**
 * Meta approves templates per name *and* per language. Submit them all at once.
 * Wording here is constrained by Meta's review, not only by what reads well:
 *
 *   - Every template must open on the transaction it concerns, or the classifier
 *     files it as MARKETING and rejects it.
 *   - A variable may not sit at the very start or the very end of a body.
 *   - There must be enough surrounding text for the number of variables.
 *
 * {{1}}, {{2}} … are Meta's positional variables.
 */
export type TemplateDefinition = {
  /** Template name as registered with Meta. */
  name: string;
  variables: readonly string[];
  body: Record<Locale, string>;
  urlButton?: {
    /** Meta caps button labels at 25 characters. */
    label: Record<Locale, string>;
    /** Appended to WHATSAPP_TEMPLATE_BASE_URL. {{1}} is its only variable. */
    path: string;
  };
  /**
   * Tappable replies that come back as an inbound message.
   *
   * Structural, not cosmetic: buttons are fixed at approval time, so a
   * template approved without them cannot gain them later without a second
   * review. Worth deciding before submitting rather than after.
   *
   * A tap also counts as the patient messaging first, which reopens the
   * 24-hour window — so the reply that follows is free-form and needs no
   * template of its own.
   */
  quickReplies?: Record<Locale, string[]>;
};

export const TEMPLATES: Record<TemplateCode, TemplateDefinition> = {
  queue_link: {
    name: 'opd_queue_link',
    variables: ['tokenNumber', 'doctorName'],
    body: {
      mr: 'तुमचा टोकन क्रमांक {{1}}, डॉ. {{2}} साठी नोंदवला आहे. तुमचा नंबर जवळ आल्यावर आम्ही कळवू.',
      hi: 'आपका टोकन नंबर {{1}}, डॉ. {{2}} के लिए दर्ज किया गया है। आपकी बारी पास आने पर हम सूचित करेंगे।',
      en: 'Your queue token number {{1}} for Dr. {{2}} is confirmed. We will notify you when your turn is close.',
    },
    urlButton: {
      label: { mr: 'रांग पाहा', hi: 'कतार देखें', en: 'Track my queue' },
      path: '/q/{{1}}',
    },
  },
  /**
   * A booking for a specific time, as opposed to a place in a queue.
   *
   * `queue_link` was being used for both, which meant a patient booking 3pm
   * tomorrow was told "your queue token is confirmed, we will notify you when
   * your turn is close" — and was never told the time they had booked. The
   * time was in the payload and unused.
   *
   * Date and time are separate variables so each renders in the patient's own
   * locale conventions rather than being pre-joined into one English string.
   */
  appointment_confirmed: {
    name: 'opd_appointment_confirmed',
    variables: ['doctorName', 'appointmentDate', 'appointmentTime', 'tokenNumber'],
    /**
     * Purely declarative, because Meta rejected the earlier wording as
     * INCORRECT_CATEGORY in all three languages.
     *
     * The only difference was a closing instruction — "Please arrive 10
     * minutes early". Meta's classifier reads an imperative to the reader as
     * persuasion, which is a MARKETING signal, and it judges the template's
     * overall purpose rather than individual words. Every template that passed
     * first time states facts and asks for nothing.
     *
     * The advice was worth having, and the place for it is the queue page the
     * button opens — where it costs nothing, needs no approval, and can be
     * reworded freely. It is not there yet.
     */
    body: {
      mr: 'डॉ. {{1}} यांच्यासोबत तुमची अपॉइंटमेंट {{2}} रोजी {{3}} वाजता निश्चित झाली आहे. या भेटीसाठी टोकन क्रमांक {{4}} राखून ठेवला आहे.',
      hi: 'डॉ. {{1}} के साथ आपकी अपॉइंटमेंट {{2}} को {{3}} बजे तय हो गई है। इस विज़िट के लिए टोकन नंबर {{4}} सुरक्षित रखा गया है।',
      en: 'Your appointment with Dr. {{1}} on {{2}} at {{3}} is confirmed. Token number {{4}} is reserved for this visit.',
    },
    urlButton: {
      label: { mr: 'तपशील पाहा', hi: 'विवरण देखें', en: 'View details' },
      path: '/q/{{1}}',
    },
  },
  queue_milestone: {
    name: 'opd_queue_milestone',
    variables: ['token', 'doctorName', 'patientsAhead', 'waitMinutes'],
    body: {
      mr: 'डॉ. {{2}} यांच्यासाठी तुमच्या {{1}} क्रमांकाच्या टोकनचे अपडेट: तुमच्या आधी {{3}} रुग्ण आहेत. अंदाजे प्रतीक्षा: ~{{4}} मिनिटे.',
      hi: 'डॉ. {{2}} के लिए आपके टोकन नंबर {{1}} का अपडेट: आपसे पहले {{3}} मरीज़ हैं। अनुमानित प्रतीक्षा: ~{{4}} मिनट।',
      en: 'Update on your queue token {{1}} for Dr. {{2}}: {{3}} patient(s) ahead of you. Estimated wait: ~{{4}} min.',
    },
  },
  slot_reminder: {
    name: 'opd_slot_reminder',
    variables: ['doctorName', 'appointmentTime'],
    body: {
      mr: 'स्मरणपत्र: डॉ. {{1}} यांच्यासोबत तुमची अपॉइंटमेंट आज {{2}} वाजता आहे.',
      hi: 'स्मरण पत्र: डॉ. {{1}} के साथ आपकी अपॉइंटमेंट आज {{2}} बजे है।',
      en: 'Reminder: your appointment with Dr. {{1}} is at {{2}} today.',
    },
  },
  /**
   * The doctor cannot keep an appointment that was already booked.
   *
   * Wording is constrained by more than Meta's classifier here. It opens on
   * the appointment, states plainly that it cannot go ahead, and gives the
   * patient the one action that fixes it — because the alternative is somebody
   * travelling to a hospital for a doctor who is not there. It apologises
   * once; a longer apology reads as evasion and pushes the instruction further
   * down the message.
   *
   * The time and date are separate variables rather than one pre-formatted
   * string so each renders in the patient's own locale conventions.
   */
  slot_disrupted: {
    name: 'opd_slot_disrupted',
    variables: ['doctorName', 'appointmentTime', 'appointmentDate'],
    body: {
      mr: 'डॉ. {{1}} यांच्यासोबत {{3}} रोजी {{2}} वाजता असलेली तुमची अपॉइंटमेंट होऊ शकणार नाही, कारण डॉक्टर त्या वेळेत उपलब्ध नाहीत. कृपया खालील लिंकवरून दुसरी वेळ निवडा. गैरसोयीबद्दल क्षमस्व.',
      hi: 'डॉ. {{1}} के साथ {{3}} को {{2}} बजे आपकी अपॉइंटमेंट नहीं हो पाएगी, क्योंकि डॉक्टर उस समय उपलब्ध नहीं हैं। कृपया नीचे दिए गए लिंक से दूसरा समय चुनें। असुविधा के लिए खेद है।',
      en: 'Your appointment with Dr. {{1}} at {{2}} on {{3}} cannot go ahead, as the doctor is unavailable at that time. Please choose another time using the link below. We are sorry for the inconvenience.',
    },
    urlButton: {
      label: { mr: 'नवीन वेळ निवडा', hi: 'नया समय चुनें', en: 'Pick a new time' },
      path: '/book?doctor={{1}}',
    },
  },
  /**
   * The patient's turn came and they were not there.
   *
   * Sent because the alternative is someone sitting in the waiting room —
   * or standing outside with a cup of tea — whose turn passed without them
   * knowing, waiting indefinitely for a call that already happened. It is the
   * single complaint most likely to make a hospital abandon a queue system.
   *
   * Carries a quick reply rather than only text. A patient who *is* present
   * needs to rejoin the queue without walking to the desk and interrupting
   * whoever is being seen — and a reply also reopens the 24-hour window, so
   * reception can then talk to them free of charge.
   */
  queue_skipped: {
    name: 'opd_queue_skipped',
    variables: ['tokenNumber', 'doctorName'],
    /**
     * A plain notification, with no button.
     *
     * It carried an "I am here" quick reply, which Meta rejected as
     * INCORRECT_CATEGORY in Marathi and English across two attempts — an
     * interactive re-engagement prompt reads as persuasion, and removing the
     * matching instruction from the body was not enough on its own.
     *
     * Dropping it is the right outcome regardless: nothing in the conversation
     * state machine handles that reply, so a patient who tapped it would have
     * been answered with the booking menu rather than given their place back.
     * A button that does nothing is worse than no button.
     *
     * Re-adding it later means wiring the handler first and submitting under a
     * new template name, since buttons are fixed at approval time.
     */
    body: {
      mr: 'डॉ. {{2}} यांच्यासाठी टोकन क्रमांक {{1}} पुकारला गेला, पण तुम्ही उपस्थित नव्हतात. तुम्ही रुग्णालयात असाल, तर रिसेप्शनवर कळवू शकता.',
      hi: 'डॉ. {{2}} के लिए टोकन नंबर {{1}} पुकारा गया, लेकिन आप मौजूद नहीं थे। यदि आप अस्पताल में हैं, तो रिसेप्शन पर बता सकते हैं।',
      /**
       * Stripped further than the other two, which both passed.
       *
       * Marathi and Hindi cleared with a closing line about the reception
       * desk; English was rejected again on the same structure. Meta's English
       * classifier is the strictest, and any sentence describing what someone
       * can do next reads to it as re-engagement. What remains is a record of
       * what happened and nothing else.
       */
      en: 'Token number {{1}} for Dr. {{2}} was called at the clinic and there was no response at that time.',
    },
  },
  /**
   * The appointment will not happen, and the patient has not been told.
   *
   * Covers both reception cancelling and a no-show being recorded. One
   * template rather than two: the patient-facing fact is identical, the reason
   * is a variable, and every extra template is another Meta review window.
   */
  appointment_cancelled: {
    name: 'opd_appointment_cancelled',
    variables: ['doctorName', 'appointmentDate'],
    body: {
      mr: 'डॉ. {{1}} यांच्यासोबत {{2}} रोजीची तुमची अपॉइंटमेंट रद्द करण्यात आली आहे. नवीन वेळ हवी असल्यास खालील लिंकवरून निवडा, किंवा या क्रमांकावर उत्तर द्या.',
      hi: 'डॉ. {{1}} के साथ {{2}} की आपकी अपॉइंटमेंट रद्द कर दी गई है। नया समय चाहिए तो नीचे दिए गए लिंक से चुनें, या इसी नंबर पर उत्तर दें।',
      en: 'Your appointment with Dr. {{1}} on {{2}} has been cancelled. To book a new time, use the link below or reply to this message.',
    },
    urlButton: {
      label: { mr: 'नवीन वेळ निवडा', hi: 'नया समय चुनें', en: 'Book a new time' },
      path: '/book?doctor={{1}}',
    },
  },
  /**
   * The doctor is running late, sent before the patient leaves home.
   *
   * The commonest event in an Indian OPD and, until now, the one the platform
   * said nothing about. The value is entirely in the timing: a message that
   * arrives while someone is still at home saves them an hour in a waiting
   * room, and the same message sent after they arrive is just an apology.
   */
  doctor_delayed: {
    name: 'opd_doctor_delayed',
    variables: ['doctorName', 'delayMinutes', 'newTime'],
    /**
     * "Please plan accordingly" was rejected in Hindi while the same sentence
     * passed in Marathi and English — the classifier is noisy at the margin,
     * and the right response to a borderline verdict is to move away from the
     * margin rather than resubmit and hope. The new time is the useful fact;
     * what the patient does with it is theirs to decide.
     */
    body: {
      mr: 'डॉ. {{1}} आज सुमारे {{2}} मिनिटे उशिरा सुरू करत आहेत. तुमची अपेक्षित वेळ आता सुमारे {{3}} आहे, आणि तुमचा टोकन क्रमांक कायम आहे.',
      hi: 'डॉ. {{1}} आज लगभग {{2}} मिनट देर से शुरू कर रहे हैं। आपका अनुमानित समय अब लगभग {{3}} है, और आपका टोकन नंबर सुरक्षित है।',
      en: 'Dr. {{1}} is running about {{2}} minutes late today. Your expected time is now around {{3}}, and your token number is unchanged.',
    },
  },
  /**
   * Sent to the hospital owner, not a patient.
   */
  owner_monthly_report: {
    name: 'opd_owner_monthly_report',
    variables: ['month', 'patientsSeen', 'medianWait', 'noShows'],
    body: {
      mr: 'तुमच्या रुग्णालयाचा {{1}} या महिन्याचा अहवाल तयार आहे. एकूण {{2}} रुग्ण तपासले गेले. रुग्णांचा सरासरी प्रतीक्षा कालावधी {{3}} मिनिटे होता, आणि {{4}} रुग्ण नोंदणी करूनही आले नाहीत.',
      hi: 'आपके अस्पताल की {{1}} महीने की रिपोर्ट तैयार है। कुल {{2}} मरीज़ देखे गए। मरीज़ों का औसत प्रतीक्षा समय {{3}} मिनट रहा, और {{4}} मरीज़ पंजीकरण के बाद भी नहीं आए।',
      en: 'Your hospital summary for {{1}} is ready. A total of {{2}} patients were seen. The median patient wait was {{3}} minutes, and {{4}} patients did not arrive after registering.',
    },
  },
};

/**
 * Milestones are the only suppressible message kind.
 *
 * A patient who never receives their token link has been actively harmed by
 * us; a patient who misses a "you are nearly next" nudge has merely lost a
 * convenience. Only the second may be dropped to protect margin.
 */
/**
 * Messages that are never dropped to protect margin.
 *
 * The test is whether skipping it causes a wasted journey or an indefinite
 * wait. A missed "4 patients ahead" nudge costs a patient nothing they can
 * measure; a missed cancellation costs them a morning.
 */
export const CRITICAL_TEMPLATES: ReadonlySet<TemplateCode> = new Set([
  'queue_link',
  'appointment_confirmed',
  'slot_reminder',
  // A patient travels to a hospital for a doctor who is not there.
  'slot_disrupted',
  // A patient waits indefinitely for a call that already happened.
  'queue_skipped',
  // A patient travels for an appointment that no longer exists.
  'appointment_cancelled',
]);

export const isCritical = (code: TemplateCode): boolean => CRITICAL_TEMPLATES.has(code);

/** Fills {{n}} placeholders. Used for local development and for previews. */
export function renderTemplate(
  code: TemplateCode,
  locale: Locale,
  variables: string[],
  urlButtonParam?: string,
): string {
  const text = TEMPLATES[code].body[locale].replace(/\{\{(\d+)\}\}/g, (_, index) => {
    return variables[Number(index) - 1] ?? '';
  });

  const button = TEMPLATES[code].urlButton;
  if (!button || !urlButtonParam) return text;

  return `${text}
[${button.label[locale]}] ${templateButtonUrl(code, urlButtonParam)}`;
}

/**
 * The base URL baked into approved templates.
 *
 * Deliberately separate from PUBLIC_BASE_URL: that one may be an ngrok tunnel
 * or a preview deployment, whereas this must be the final production domain,
 * because it is frozen into the template at approval time.
 */
export const templateBaseUrl = (): string =>
  process.env.WHATSAPP_TEMPLATE_BASE_URL ??
  process.env.PUBLIC_BASE_URL ??
  'http://localhost:3000';

export function templateButtonUrl(code: TemplateCode, param: string): string {
  const button = TEMPLATES[code].urlButton;
  if (!button) return templateBaseUrl();
  return templateBaseUrl() + button.path.replace('{{1}}', param);
}
