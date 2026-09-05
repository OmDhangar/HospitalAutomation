import 'dotenv/config';
import { LOCALES } from '@/lib/i18n/patient';
import { TEMPLATES } from '@/lib/notify/templates';

/**
 * Prints, or submits, every message template Meta needs to approve.
 *
 *   npm run whatsapp:templates            print the payloads
 *   npm run whatsapp:templates -- --submit  create them via the API
 *
 * Templates are approved per name *and* per language, so four kinds across
 * three languages is twelve approvals. Approval takes anywhere from minutes to
 * days and it gates the entire notification path, so submit them all at once
 * and early.
 *
 * All four are UTILITY, not MARKETING. Utility is cheaper and is the correct
 * category: every one of these is triggered by something the patient or the
 * hospital did, not by us deciding to promote something. Getting this wrong
 * costs roughly six times more per message and risks rejection.
 */
const GRAPH_VERSION = 'v23.0';

/** Meta requires sample values for each {{n}} so reviewers can see the shape. */
const EXAMPLES: Record<string, string[]> = {
  opd_queue_link: ['42', 'Dr Kulkarni', 'https://example.com/q/abc123'],
  opd_queue_milestone: ['4', 'Dr Kulkarni'],
  opd_booking_confirmed: ['Dr Kulkarni', '10:30 am', 'https://example.com/q/abc123'],
  opd_owner_monthly_report: ['2026-08', '4820', '18', '96'],
};

type TemplatePayload = {
  name: string;
  language: string;
  category: 'UTILITY';
  components: Array<{
    type: 'BODY';
    text: string;
    example?: { body_text: string[][] };
  }>;
};

function buildPayloads(): TemplatePayload[] {
  const payloads: TemplatePayload[] = [];

  for (const definition of Object.values(TEMPLATES)) {
    for (const locale of LOCALES) {
      const example = EXAMPLES[definition.name];
      payloads.push({
        name: definition.name,
        // Meta expects a language tag; ours map one-to-one.
        language: locale,
        category: 'UTILITY',
        components: [
          {
            type: 'BODY',
            text: definition.body[locale],
            ...(example && example.length > 0
              ? { example: { body_text: [example] } }
              : {}),
          },
        ],
      });
    }
  }

  return payloads;
}

async function submit(payloads: TemplatePayload[]) {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!wabaId || !token) {
    throw new Error(
      'Submitting needs WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN in .env',
    );
  }

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

    console.log(`  ✓ ${payload.name} (${payload.language}) — ${body.status ?? 'submitted'}`);
  }
}

async function main() {
  const payloads = buildPayloads();
  const shouldSubmit = process.argv.includes('--submit');

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
