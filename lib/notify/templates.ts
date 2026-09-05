import type { Locale } from '@/lib/i18n/patient';

export type TemplateCode = 'queue_link' | 'queue_milestone' | 'owner_monthly_report';

/**
 * Meta approves templates per name *and* per language, so these three kinds are
 * nine separate approvals. Submit them all at once — approval is measured in
 * days and it gates the whole notification path.
 *
 * Wording here is constrained by Meta's review, not only by what reads well:
 *
 *   - Every template must open on the transaction it concerns, or the classifier
 *     files it as MARKETING and rejects it. An earlier draft of the queue link
 *     led with the queue and closed with "you can wait outside" and came back
 *     INCORRECT_CATEGORY; leading with "Your appointment is booked" fixed it.
 *     The category matters commercially — marketing costs several times more.
 *   - A variable may not sit at the very start or the very end of a body.
 *   - There must be enough surrounding text for the number of variables.
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
  /**
   * A tappable link, rendered as a button rather than as text in the body.
   *
   * This is not a styling choice. A bare URL in a utility body reads as
   * promotional to Meta's classifier and is rejected INCORRECT_CATEGORY — we
   * had exactly that rejection three times before moving the link here. Buttons
   * are the mechanism Meta provides for this, and they pass.
   *
   * The base URL is fixed at approval time and only `path`'s {{1}} varies per
   * message, so the production domain has to be settled before templates are
   * submitted. Changing domains later means a fresh round of approvals.
   */
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
      mr: 'तुमची अपॉइंटमेंट नोंदवली आहे. टोकन क्रमांक {{1}}, डॉक्टर {{2}}. तुमचा नंबर जवळ आल्यावर आम्ही कळवू.',
      hi: 'आपकी अपॉइंटमेंट दर्ज हो गई है। टोकन नंबर {{1}}, डॉक्टर {{2}}। आपकी बारी पास आने पर हम सूचित करेंगे।',
      en: 'Your appointment is booked. Token number {{1}}, with {{2}}. We will notify you when your turn is close.',
    },
    urlButton: {
      label: { mr: 'रांग पाहा', hi: 'कतार देखें', en: 'Track my queue' },
      path: '/q/{{1}}',
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
