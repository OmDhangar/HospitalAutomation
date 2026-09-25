export const LOCALES = ['mr', 'hi', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  mr: 'मराठी',
  hi: 'हिंदी',
  en: 'English',
};

/**
 * Patient-facing copy only.
 *
 * The staff dashboard stays in English on purpose: receptionists work with
 * English software all day, patients do not. Translating the whole product
 * would have cost roughly ten times as many strings for no adoption benefit.
 *
 * Wording is deliberately plain. "Patients ahead of you" is a fact anyone can
 * check by looking around the room; the time estimate is hedged everywhere it
 * appears, because being confidently wrong is how a queue page loses trust.
 */
type Strings = {
  yourToken: string;
  nowServing: string;
  peopleAhead: string;
  youAreNext: string;
  yourTurn: string;
  yourTurnHint: string;
  withDoctor: string;
  estimatedTime: string;
  estimateHint: string;
  doctor: string;
  paused: string;
  pausedHint: string;
  completed: string;
  completedHint: string;
  expired: string;
  expiredHint: string;
  cancelled: string;
  notFound: string;
  notFoundHint: string;
  updated: string;
  refresh: string;
  waiting: string;
  leaveHint: string;
  /** Appointment details and self-cancellation. */
  appointmentTime: string;
  cancelAction: string;
  cancelPrompt: string;
  cancelConfirm: string;
  cancelKeep: string;
  cancelDone: string;
  cancelDoneHint: string;
  cancelTooLate: string;
  cancelTooLateHint: string;
};

export const t: Record<Locale, Strings> = {
  mr: {
    yourToken: 'तुमचा टोकन क्रमांक',
    nowServing: 'सध्या सुरू',
    peopleAhead: 'तुमच्या आधी रुग्ण',
    youAreNext: 'तुमचा नंबर पुढचा आहे',
    yourTurn: 'तुमचा नंबर आला आहे',
    yourTurnHint: 'कृपया लगेच डॉक्टरांच्या खोलीत जा.',
    withDoctor: 'तुम्ही डॉक्टरांकडे आहात',
    estimatedTime: 'अंदाजे वेळ',
    estimateHint: 'रांग पुढे सरकेल तसा हा अंदाज बदलू शकतो.',
    doctor: 'डॉक्टर',
    paused: 'रांग तात्पुरती थांबली आहे',
    pausedHint: 'डॉक्टर लवकरच पुन्हा सुरू करतील. तुमचा टोकन सुरक्षित आहे.',
    completed: 'तुमची तपासणी पूर्ण झाली',
    completedHint: 'धन्यवाद. तब्येतीची काळजी घ्या.',
    expired: 'ही लिंक कालबाह्य झाली आहे',
    expiredHint: 'कृपया नवीन टोकनसाठी रिसेप्शनला संपर्क साधा.',
    cancelled: 'हा टोकन रद्द झाला आहे',
    notFound: 'ही लिंक सापडली नाही',
    notFoundHint: 'कृपया रिसेप्शनला विचारा.',
    updated: 'अद्ययावत',
    refresh: 'पुन्हा तपासा',
    waiting: 'रांगेत',
    leaveHint: 'तुम्ही बाहेर थांबू शकता. वेळ जवळ आल्यावर आम्ही कळवू.',
    appointmentTime: 'अपॉइंटमेंटची वेळ',
    cancelAction: 'अपॉइंटमेंट रद्द करा',
    cancelPrompt: 'तुम्ही येऊ शकत नसाल, तर आत्ताच रद्द करा. ती वेळ दुसऱ्या रुग्णाला मिळेल.',
    cancelConfirm: 'होय, रद्द करा',
    cancelKeep: 'नको, ठेवा',
    cancelDone: 'तुमची अपॉइंटमेंट रद्द झाली',
    cancelDoneHint: 'कळवल्याबद्दल धन्यवाद. नवीन वेळ हवी असल्यास रुग्णालयाला संपर्क करा.',
    cancelTooLate: 'ही अपॉइंटमेंट आता रद्द करता येणार नाही',
    cancelTooLateHint: 'कृपया रिसेप्शनला विचारा.',
  },
  hi: {
    yourToken: 'आपका टोकन नंबर',
    nowServing: 'अभी चल रहा है',
    peopleAhead: 'आपसे पहले मरीज़',
    youAreNext: 'आपका नंबर अगला है',
    yourTurn: 'आपकी बारी आ गई है',
    yourTurnHint: 'कृपया तुरंत डॉक्टर के कमरे में जाएँ।',
    withDoctor: 'आप डॉक्टर के पास हैं',
    estimatedTime: 'अनुमानित समय',
    estimateHint: 'कतार आगे बढ़ने पर यह अनुमान बदल सकता है।',
    doctor: 'डॉक्टर',
    paused: 'कतार कुछ देर के लिए रुकी है',
    pausedHint: 'डॉक्टर जल्द ही दोबारा शुरू करेंगे। आपका टोकन सुरक्षित है।',
    completed: 'आपकी जाँच पूरी हो गई',
    completedHint: 'धन्यवाद। अपना ध्यान रखें।',
    expired: 'यह लिंक समाप्त हो गया है',
    expiredHint: 'कृपया नए टोकन के लिए रिसेप्शन से संपर्क करें।',
    cancelled: 'यह टोकन रद्द कर दिया गया है',
    notFound: 'यह लिंक नहीं मिली',
    notFoundHint: 'कृपया रिसेप्शन से पूछें।',
    updated: 'अपडेट किया गया',
    refresh: 'दोबारा जाँचें',
    waiting: 'कतार में',
    leaveHint: 'आप बाहर इंतज़ार कर सकते हैं। समय पास आने पर हम बता देंगे।',
    appointmentTime: 'अपॉइंटमेंट का समय',
    cancelAction: 'अपॉइंटमेंट रद्द करें',
    cancelPrompt: 'यदि आप नहीं आ पा रहे हैं, तो अभी रद्द कर दें। वह समय किसी और मरीज़ को मिल जाएगा।',
    cancelConfirm: 'हाँ, रद्द करें',
    cancelKeep: 'नहीं, रहने दें',
    cancelDone: 'आपकी अपॉइंटमेंट रद्द कर दी गई',
    cancelDoneHint: 'बताने के लिए धन्यवाद। नया समय चाहिए तो अस्पताल से संपर्क करें।',
    cancelTooLate: 'यह अपॉइंटमेंट अब रद्द नहीं की जा सकती',
    cancelTooLateHint: 'कृपया रिसेप्शन से पूछें।',
  },
  en: {
    yourToken: 'Your token number',
    nowServing: 'Now serving',
    peopleAhead: 'patients ahead of you',
    youAreNext: 'You are next',
    yourTurn: 'It is your turn',
    yourTurnHint: 'Please go to the doctor’s room now.',
    withDoctor: 'You are with the doctor',
    estimatedTime: 'Estimated time',
    estimateHint: 'This estimate changes as the queue moves.',
    doctor: 'Doctor',
    paused: 'The queue is paused',
    pausedHint: 'The doctor will resume shortly. Your token is safe.',
    completed: 'Your consultation is complete',
    completedHint: 'Thank you. Take care.',
    expired: 'This link has expired',
    expiredHint: 'Please ask reception for a new token.',
    cancelled: 'This token was cancelled',
    notFound: 'This link was not found',
    notFoundHint: 'Please check with reception.',
    updated: 'Updated',
    refresh: 'Check again',
    waiting: 'In queue',
    leaveHint: 'You can wait outside. We will message you when your turn is close.',
    appointmentTime: 'Appointment time',
    cancelAction: 'Cancel appointment',
    /**
     * Says why cancelling is worth doing, not just that it is possible.
     *
     * A patient who cannot come will either cancel or quietly not turn up. The
     * second costs the hospital an empty slot and the patient nothing, so the
     * copy names the benefit to someone else — which is what actually moves
     * people to press it.
     */
    cancelPrompt:
      'If you cannot come, please cancel now. Your time can then be given to another patient.',
    cancelConfirm: 'Yes, cancel it',
    cancelKeep: 'No, keep it',
    cancelDone: 'Your appointment is cancelled',
    cancelDoneHint: 'Thank you for letting us know. To book again, contact the hospital.',
    cancelTooLate: 'This appointment can no longer be cancelled here',
    cancelTooLateHint: 'Please speak to the reception desk.',
  },
};

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
