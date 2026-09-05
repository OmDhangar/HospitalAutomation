import type { Locale } from '@/lib/i18n/patient';

export type TemplateCode =
  | 'queue_link'
  | 'queue_milestone'
  | 'booking_confirmed'
  | 'owner_monthly_report';

/**
 * Meta approves templates per name *and* per language, so these four kinds are
 * twelve separate approvals. Submit them all at once — approval is measured in
 * days and it gates the whole notification path.
 *
 * `body` is the exact text to submit for approval, and is also what the local
 * provider prints during development. Meta renders from its own approved copy
 * at send time; keeping the strings here means the two cannot drift silently.
 *
 * {{1}}, {{2}} … are Meta's positional variables.
 */
export type TemplateDefinition = {
  /** Template name as registered with Meta. */
  name: string;
  variables: readonly string[];
  body: Record<Locale, string>;
};

export const TEMPLATES: Record<TemplateCode, TemplateDefinition> = {
  queue_link: {
    name: 'opd_queue_link',
    variables: ['tokenNumber', 'doctorName', 'queueUrl'],
    body: {
      mr: 'तुमचा टोकन क्रमांक {{1}} आहे ({{2}}). रांगेची सद्यस्थिती इथे पाहा: {{3}}\n\nतुम्ही बाहेर थांबू शकता — वेळ जवळ आल्यावर आम्ही कळवू.',
      hi: 'आपका टोकन नंबर {{1}} है ({{2}})। कतार की स्थिति यहाँ देखें: {{3}}\n\nआप बाहर इंतज़ार कर सकते हैं — समय पास आने पर हम बता देंगे।',
      en: 'Your token number is {{1}} ({{2}}). Track the queue here: {{3}}\n\nYou can wait outside — we will message you when your turn is close.',
    },
  },
  queue_milestone: {
    name: 'opd_queue_milestone',
    variables: ['patientsAhead', 'doctorName'],
    body: {
      mr: 'तुमच्या आधी फक्त {{1}} रुग्ण आहेत ({{2}}). कृपया रुग्णालयात परत या.',
      hi: 'आपसे पहले केवल {{1}} मरीज़ हैं ({{2}})। कृपया अस्पताल वापस आएँ।',
      en: 'Only {{1}} patients are ahead of you ({{2}}). Please return to the hospital.',
    },
  },
  /**
   * Sent to the hospital owner, not a patient. Twelve messages a year against
   * a subscription worth thousands: the cheapest retention mechanism available,
   * and the only regular reminder that the product is doing anything.
   */
  owner_monthly_report: {
    name: 'opd_owner_monthly_report',
    variables: ['month', 'patientsSeen', 'medianWait', 'noShows'],
    body: {
      mr: '{{1}} चा अहवाल: {{2}} रुग्ण तपासले, सरासरी प्रतीक्षा {{3}} मिनिटे, {{4}} रुग्ण आले नाहीत.',
      hi: '{{1}} की रिपोर्ट: {{2}} मरीज़ देखे गए, औसत प्रतीक्षा {{3}} मिनट, {{4}} मरीज़ नहीं आए।',
      en: '{{1}} summary: {{2}} patients seen, median wait {{3}} minutes, {{4}} no-shows.',
    },
  },
  booking_confirmed: {
    name: 'opd_booking_confirmed',
    variables: ['doctorName', 'slot', 'queueUrl'],
    body: {
      mr: 'तुमची अपॉइंटमेंट निश्चित झाली: {{1}}, {{2}}. रांग इथे पाहा: {{3}}',
      hi: 'आपकी अपॉइंटमेंट तय हो गई: {{1}}, {{2}}। कतार यहाँ देखें: {{3}}',
      en: 'Your appointment is confirmed: {{1}} at {{2}}. Track the queue here: {{3}}',
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
export const CRITICAL_TEMPLATES: ReadonlySet<TemplateCode> = new Set([
  'queue_link',
  'booking_confirmed',
]);

export const isCritical = (code: TemplateCode): boolean => CRITICAL_TEMPLATES.has(code);

/** Fills {{n}} placeholders. Used for local development and for previews. */
export function renderTemplate(
  code: TemplateCode,
  locale: Locale,
  variables: string[],
): string {
  return TEMPLATES[code].body[locale].replace(/\{\{(\d+)\}\}/g, (_, index) => {
    return variables[Number(index) - 1] ?? '';
  });
}
