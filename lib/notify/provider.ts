import type { Locale } from '@/lib/i18n/patient';
import { isRetryableMetaError, ProviderError } from './errors';
import { renderTemplate, TEMPLATES, type TemplateCode } from './templates';

export type TemplateMessage = {
  phoneNumberId: string;
  toPhoneE164: string;
  templateCode: TemplateCode;
  locale: Locale;
  variables: string[];
  /**
   * Fills the {{1}} in a template's URL button. Only the suffix travels — the
   * base URL is part of the approved template and cannot be changed per message.
   */
  urlButtonParam?: string;
};

export type ListRow = { id: string; title: string; description?: string };

export type InteractiveListMessage = {
  phoneNumberId: string;
  toPhoneE164: string;
  bodyText: string;
  buttonText: string;
  rows: ListRow[];
};

/**
 * A plain message, with no template.
 *
 * Only deliverable inside the 24-hour window a patient opens by messaging us
 * first — which is exactly the situation after a WhatsApp booking. Free-form
 * needs no approval, so the booking path does not wait on Meta's template
 * review, and the patient gets an answer immediately rather than whenever the
 * outbox worker next runs.
 */
export type TextMessage = {
  phoneNumberId: string;
  toPhoneE164: string;
  body: string;
};

export type SendResult = { providerMessageId: string };

/**
 * Business logic produces a notification intent; this interface turns it into
 * an API call. Nothing above this line knows Meta exists.
 *
 * That separation is not decoration. Meta changed how these messages are billed
 * on 1 October 2026, and will change it again; a BSP may end up cheaper than
 * the direct integration. Neither should reach the queue engine.
 */
export interface NotificationProvider {
  readonly name: string;
  sendTemplate(message: TemplateMessage): Promise<SendResult>;
  sendInteractiveList(message: InteractiveListMessage): Promise<SendResult>;
  /** Free-form; valid only inside an open customer service window. */
  sendText(message: TextMessage): Promise<SendResult>;
}

/* ------------------------------------------------------------ Meta Cloud API */

const GRAPH_VERSION = 'v23.0';

export class MetaCloudProvider implements NotificationProvider {
  readonly name = 'meta';

  constructor(private readonly accessToken: string) {}

  private async post(phoneNumberId: string, payload: unknown): Promise<SendResult> {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...(payload as object) }),
      },
    );

    const body = (await response.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number };
    };

    if (!response.ok) {
      const code = body.error?.code;
      throw new ProviderError(
        `WhatsApp send failed (${response.status}${code ? `, code ${code}` : ''}): ` +
          `${body.error?.message ?? 'unknown error'}`,
        isRetryableMetaError({ code, httpStatus: response.status }),
        code,
        response.status,
      );
    }

    const providerMessageId = body.messages?.[0]?.id;
    if (!providerMessageId) {
      // A 200 with no message id is not something a retry will fix.
      throw new ProviderError('WhatsApp send returned no message id', false);
    }

    return { providerMessageId };
  }

  async sendTemplate(message: TemplateMessage): Promise<SendResult> {
    const definition = TEMPLATES[message.templateCode];
    const components: unknown[] = [];

    if (message.variables.length > 0) {
      components.push({
        type: 'body',
        parameters: message.variables.map((text) => ({ type: 'text', text })),
      });
    }

    if (definition.urlButton && message.urlButtonParam) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: message.urlButtonParam }],
      });
    }

    return this.post(message.phoneNumberId, {
      to: message.toPhoneE164,
      type: 'template',
      template: {
        name: definition.name,
        language: { code: message.locale },
        components,
      },
    });
  }

  async sendText(message: TextMessage): Promise<SendResult> {
    return this.post(message.phoneNumberId, {
      to: message.toPhoneE164,
      type: 'text',
      // The queue link is the point of the message; let it render a preview.
      text: { preview_url: true, body: message.body },
    });
  }

  async sendInteractiveList(message: InteractiveListMessage): Promise<SendResult> {
    return this.post(message.phoneNumberId, {
      to: message.toPhoneE164,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: message.bodyText },
        action: {
          button: message.buttonText,
          sections: [{ rows: message.rows }],
        },
      },
    });
  }
}

/* -------------------------------------------------------------- development */

/**
 * Prints what would have been sent.
 *
 * Meta business verification takes one to three weeks, so this exists so the
 * entire notification path — outbox, worker, de-duplication, circuit breaker —
 * can be built and tested before any credentials arrive.
 */
export class ConsoleProvider implements NotificationProvider {
  readonly name = 'console';

  private id = 0;

  async sendTemplate(message: TemplateMessage): Promise<SendResult> {
    const text = renderTemplate(
      message.templateCode,
      message.locale,
      message.variables,
      message.urlButtonParam,
    );
    console.log(
      `[whatsapp:${message.locale}] -> ${message.toPhoneE164} (${message.templateCode})\n${text}\n`,
    );
    this.id += 1;
    return { providerMessageId: `console-${Date.now()}-${this.id}` };
  }

  async sendText(message: TextMessage): Promise<SendResult> {
    console.log(`[whatsapp:text] -> ${message.toPhoneE164}\n${message.body}\n`);
    this.id += 1;
    return { providerMessageId: `console-${Date.now()}-${this.id}` };
  }

  async sendInteractiveList(message: InteractiveListMessage): Promise<SendResult> {
    const rows = message.rows.map((row) => `   - ${row.title} [${row.id}]`).join('\n');
    console.log(
      `[whatsapp:list] -> ${message.toPhoneE164}\n${message.bodyText}\n${rows}\n`,
    );
    this.id += 1;
    return { providerMessageId: `console-${Date.now()}-${this.id}` };
  }
}

let cached: NotificationProvider | undefined;

export function getProvider(): NotificationProvider {
  if (cached) return cached;

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  cached = token ? new MetaCloudProvider(token) : new ConsoleProvider();
  return cached;
}

/** Test seam. */
export function setProvider(provider: NotificationProvider | undefined) {
  cached = provider;
}
