import 'dotenv/config';
import { createHmac } from 'node:crypto';

/**
 * Posts a correctly-signed fake Meta webhook at the local server.
 *
 * The point is to exercise the real path — signature verification, tenant
 * resolution, replay protection, the booking state machine, the outbox — with
 * no Meta account, no public URL and no tunnel. Everything downstream of the
 * HTTP request is identical to production; only the sender is pretended.
 *
 *   npm run whatsapp:simulate -- --pn <phoneNumberId> --text "Hi"
 *   npm run whatsapp:simulate -- --pn <phoneNumberId> --reply lang:mr
 *   npm run whatsapp:simulate -- --pn <phoneNumberId> --reply doc:<doctorId>
 *   npm run whatsapp:simulate -- --pn <phoneNumberId> --reply slot:now
 *
 * Run those four in order and you have booked an appointment over "WhatsApp".
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const phoneNumberId = arg('pn');
  const from = arg('from') ?? '919876543210';
  const text = arg('text');
  const reply = arg('reply');

  if (!phoneNumberId) {
    throw new Error(
      'Pass --pn <phoneNumberId>. Find it on /settings/whatsapp, or in whatsapp_numbers.',
    );
  }
  if (!text && !reply) throw new Error('Pass --text "..." or --reply <id>');

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    throw new Error(
      'WHATSAPP_APP_SECRET is not set. The webhook rejects unsigned requests, ' +
        'so set it to any string locally — the same value both sides.',
    );
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';

  // Shaped exactly like Meta's envelope, so the parser is genuinely exercised.
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'simulated-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                {
                  id: `wamid.sim.${Date.now()}`,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...(reply
                    ? {
                        type: 'interactive',
                        interactive: {
                          type: 'list_reply',
                          list_reply: { id: reply, title: reply },
                        },
                      }
                    : { type: 'text', text: { body: text } }),
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;

  const response = await fetch(`${baseUrl}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': signature,
    },
    body,
  });

  console.log(`${response.status} ${response.statusText}`);
  console.log(await response.text());

  if (response.status === 401) {
    console.log(
      '\n401 means the signature did not match: the server is running with a ' +
        'different WHATSAPP_APP_SECRET than this script. Restart it after editing .env.',
    );
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
