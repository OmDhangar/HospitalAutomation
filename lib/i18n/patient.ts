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
  /** The doctor is on a break. */
  paused: string;
  pausedHint: string;
  /** Prefix for the time the break began: "On a break since" 1:10 PM. */
  pausedSince: string;
  patientPaused: string;
  patientPausedHint: string;
  resumeAction: string;
  resumeDone: string;
  resumeDoneHint: string;
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
  /** Display board translations. */
  displayTitle: string;
  displayNextPatient: string;
  displayWaiting: string;
  displaySeenToday: string;
  displayOnBreak: string;
  displayNotStarted: string;
  displayNoDoctors: string;
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
    paused: 'डॉक्टर विश्रांतीवर आहेत',
    pausedHint: 'डॉक्टर परत आल्यावर रांग पुन्हा सुरू होईल. तुमचा टोकन आणि क्रमांक सुरक्षित आहेत.',
    pausedSince: 'विश्रांती सुरू:',
    patientPaused: 'तुमचा नंबर होल्डवर (थांबवून) ठेवला आहे',
    patientPausedHint: 'तुम्ही टेस्ट किंवा कामासाठी बाहेर गेला असल्यास, परत आल्यावर खालील बटण दाबा.',
    resumeAction: 'मी परत आलो आहे / रांगेत पुन्हा या',
    resumeDone: 'तुम्ही रांगेत पुन्हा आला आहात',
    resumeDoneHint: 'तुमचा टोकन सक्रिय रांगेत जोडला गेला आहे.',
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
    displayTitle: 'प्रतीक्षा कक्ष फलक',
    displayNextPatient: 'पुढील रुग्ण',
    displayWaiting: 'प्रतीक्षेत',
    displaySeenToday: 'आज पाहिलेले',
    displayOnBreak: 'विश्रांतीवर',
    displayNotStarted: 'सुरू झाले नाही',
    displayNoDoctors: 'सध्या कोणतेही डॉक्टर सुरू नाहीत',
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
    paused: 'डॉक्टर ब्रेक पर हैं',
    pausedHint: 'डॉक्टर के लौटते ही कतार फिर से चलेगी। आपका टोकन और नंबर सुरक्षित है।',
    pausedSince: 'ब्रेक शुरू:',
    patientPaused: 'आपकी बारी होल्ड पर रखी गई है',
    patientPausedHint: 'यदि आप जाँच या किसी काम से बाहर हैं, तो लौटने पर नीचे दिया बटन दबाएँ।',
    resumeAction: 'मैं वापस आ गया हूँ / कतार में जुड़ें',
    resumeDone: 'आप दोबारा कतार में जुड़ गए हैं',
    resumeDoneHint: 'आपका टोकन सक्रिय कतार में वापस आ गया है।',
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
    displayTitle: 'प्रतीक्षा कक्ष डिस्प्ले',
    displayNextPatient: 'अगला मरीज़',
    displayWaiting: 'प्रतीक्षारत',
    displaySeenToday: 'आज देखे गए',
    displayOnBreak: 'ब्रेक पर',
    displayNotStarted: 'शुरू नहीं हुआ',
    displayNoDoctors: 'कोई डॉक्टर उपलब्ध नहीं है',
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
    paused: 'The doctor is on a break',
    pausedHint: 'The queue will move again when the doctor is back. Your token and your place are safe.',
    pausedSince: 'On a break since',
    patientPaused: 'Your turn is temporarily on hold',
    patientPausedHint: 'If you stepped out for tests, tap below when you are back in the waiting room.',
    resumeAction: 'I am back / Rejoin queue',
    resumeDone: 'You rejoined the queue',
    resumeDoneHint: 'Your token is back in the active waiting line.',
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
    cancelPrompt:
      'If you cannot come, please cancel now. Your time can then be given to another patient.',
    cancelConfirm: 'Yes, cancel it',
    cancelKeep: 'No, keep it',
    cancelDone: 'Your appointment is cancelled',
    cancelDoneHint: 'Thank you for letting us know. To book again, contact the hospital.',
    cancelTooLate: 'This appointment can no longer be cancelled here',
    cancelTooLateHint: 'Please speak to the reception desk.',
    displayTitle: 'Waiting Room Display',
    displayNextPatient: 'Next Patient',
    displayWaiting: 'Waiting',
    displaySeenToday: 'Seen today',
    displayOnBreak: 'On a break',
    displayNotStarted: 'Not started',
    displayNoDoctors: 'No doctors in session',
  },
};

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
