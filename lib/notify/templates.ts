import type { Locale } from '@/lib/i18n/patient';

export type TemplateCode = 'queue_link' | 'queue_milestone' | 'slot_reminder' | 'owner_monthly_report';

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
export const CRITICAL_TEMPLATES: ReadonlySet<TemplateCode> = new Set(['queue_link']);

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
