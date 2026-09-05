import 'dotenv/config';
import { LOCALES } from '@/lib/i18n/patient';
import { TEMPLATES, templateBaseUrl } from '@/lib/notify/templates';

/**
 * Prints, or submits, every message template Meta needs to approve.
 *
 *   npm run whatsapp:templates                 print the payloads
 *   npm run whatsapp:templates -- --submit     create them via the API
 *   npm run whatsapp:templates -- --status     show Meta's current verdicts
 *   npm run whatsapp:templates -- --fix        re-edit any REJECTED template
 *
 * Templates are approved per name *and* per language, so three kinds across
 * three languages is nine approvals. Approval takes anywhere from minutes to
 * days and it gates the entire notification path, so submit them all at once
 * and early.
 *
 * All three are UTILITY, not MARKETING. Utility costs several times less and is
 * the correct category: every one is triggered by something the patient or the
 * hospital did, not by us deciding to promote something.
 *
 * Meta's classifier decides whether it agrees. It rejects with
 * INCORRECT_CATEGORY when a body reads as promotional, which in practice means
 * each template has to open on the transaction it concerns rather than on the
 * benefit to the reader. A rejected template must be deleted before a
 * same-named replacement can be created:
 *
 *   DELETE /{waba-id}/message_templates?name={name}
 */
const GRAPH_VERSION = 'v23.0';

/** Meta requires sample values for each {{n}} so reviewers can see the shape. */
const EXAMPLES: Record<string, string[]> = {
  opd_queue_link: ['42', 'Dr Kulkarni'],
  opd_queue_milestone: ['4', 'Dr Kulkarni'],
  opd_owner_monthly_report: ['2026-08', '4820', '18', '96'],
};

type BodyComponent = {
  type: 'BODY';
  text: string;
  example?: { body_text: string[][] };
};

type ButtonsComponent = {
  type: 'BUTTONS';
  buttons: Array<{
    type: 'URL';
    text: string;
    url: string;
    example: string[];
  }>;
};

type TemplatePayload = {
  name: string;
  language: string;
  category: 'UTILITY';
  components: Array<BodyComponent | ButtonsComponent>;
};

function buildPayloads(): TemplatePayload[] {
  const payloads: TemplatePayload[] = [];

  for (const definition of Object.values(TEMPLATES)) {
    for (const locale of LOCALES) {
      const example = EXAMPLES[definition.name];
      const components: Array<BodyComponent | ButtonsComponent> = [
        {
          type: 'BODY',
          text: definition.body[locale],
          ...(example && example.length > 0 ? { example: { body_text: [example] } } : {}),
        },
      ];

      if (definition.urlButton) {
        const url = templateBaseUrl() + definition.urlButton.path;
        components.push({
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: definition.urlButton.label[locale],
              url,
              example: [url.replace('{{1}}', 'abc123XYZ')],
            },
          ],
        });
      }

      payloads.push({
        name: definition.name,
        // Meta expects a language tag; ours map one-to-one.
        language: locale,
        category: 'UTILITY',
        components,
      });
    }
  }

  return payloads;
}

/**
 * The button URL is frozen into the approved template, so a placeholder or a
 * tunnel address would have to be re-approved later. Refuse rather than let
 * that happen quietly.
 */
function assertUsableBaseUrl() {
  const base = templateBaseUrl();
  if (!base.startsWith('https://')) {
    throw new Error(
      `WHATSAPP_TEMPLATE_BASE_URL must be an https production domain (got "${base}"). ` +
        'It is baked into approved templates and cannot be changed per message.',
    );
  }
}

async function submit(payloads: TemplatePayload[]) {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!wabaId || !token) {
    throw new Error(
      'Submitting needs WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN in .env',
    );
  }
  assertUsableBaseUrl();

  for (const payload of payloads) {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    const body = (await response.json()) as {
      id?: string;
      status?: string;
      error?: { message?: string; error_user_msg?: string };
    };

    if (!response.ok) {
      // A template that already exists is not a failure worth stopping for.
      const message = body.error?.error_user_msg ?? body.error?.message ?? 'unknown';
      console.log(`  ✗ ${payload.name} (${payload.language}) — ${message}`);
      continue;
    }

    // A 200 does not mean approved: Meta returns the verdict in the body, and
    // an instant REJECTED is the common case for a miscategorised template.
    const status = body.status ?? 'SUBMITTED';
    const mark = status === 'REJECTED' ? '✗' : '✓';
    console.log(`  ${mark} ${payload.name} (${payload.language}) — ${status}`);
  }
}

type RemoteTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  rejected_reason?: string;
};

async function fetchRemote(): Promise<RemoteTemplate[]> {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!wabaId || !token) {
    throw new Error('Needs WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN');
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates` +
      '?fields=id,name,language,status,category,rejected_reason&limit=100',
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await response.json()) as { data?: RemoteTemplate[] };
  const ours = new Set(Object.values(TEMPLATES).map((t) => t.name));
  return (body.data ?? []).filter((t) => ours.has(t.name));
}

/**
 * Rewrites a REJECTED template in place.
 *
 * Deleting and recreating is the obvious move, but DELETE needs a permission
 * that app-dashboard tokens often lack, whereas editing the template by id
 * works with the same token that created it. Editing also preserves the name,
 * so nothing downstream has to change.
 */
async function fixRejected(payloads: TemplatePayload[]) {
  assertUsableBaseUrl();
  const token = process.env.WHATSAPP_ACCESS_TOKEN!;
  const remote = await fetchRemote();
  const rejected = remote.filter((t) => t.status === 'REJECTED');

  if (rejected.length === 0) {
    console.log('Nothing is rejected.');
    return;
  }

  for (const template of rejected) {
    const payload = payloads.find(
      (p) => p.name === template.name && p.language === template.language,
    );
    if (!payload) continue;

    const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${template.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: payload.category,
        components: payload.components,
      }),
    });

    const body = (await response.json()) as {
      success?: boolean;
      error?: { error_user_msg?: string; message?: string };
    };

    console.log(
      response.ok
        ? `  ✓ ${template.name} (${template.language}) — resubmitted`
        : `  ✗ ${template.name} (${template.language}) — ` +
            `${body.error?.error_user_msg ?? body.error?.message ?? 'unknown'}`,
    );
  }
}

async function showStatus() {
  const remote = await fetchRemote();
  if (remote.length === 0) {
    console.log('None of our templates exist on this WABA yet.');
    return;
  }
  for (const t of remote.sort((a, b) => a.name.localeCompare(b.name))) {
    const reason =
      t.status === 'REJECTED' && t.rejected_reason && t.rejected_reason !== 'NONE'
        ? ` — ${t.rejected_reason}`
        : '';
    console.log(`  ${t.name.padEnd(26)} ${t.language.padEnd(3)} ${t.status}${reason}`);
  }
}

async function main() {
  const payloads = buildPayloads();
  const shouldSubmit = process.argv.includes('--submit');

  if (process.argv.includes('--status')) {
    await showStatus();
    return;
  }

  if (process.argv.includes('--fix')) {
    await fixRejected(payloads);
    return;
  }

  if (!shouldSubmit) {
    console.log(`${payloads.length} templates to create, all category UTILITY.\n`);
    console.log('Paste each into Meta → WhatsApp → Message Templates,');
    console.log('or re-run with --submit to create them via the API.\n');
    console.log(JSON.stringify(payloads, null, 2));
    return;
  }

  console.log(`Submitting ${payloads.length} templates...\n`);
  await submit(payloads);
  console.log('\nApproval is asynchronous. Check status in the Meta dashboard.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
