import 'dotenv/config';
import postgres from 'postgres';

/**
 * Answers "why did the bot go quiet".
 *
 * The inbound path has six places where it returns without replying, and none
 * of them log anything today. From the outside every one of them looks
 * identical: the patient's message gets a blue tick, and nothing comes back.
 * This walks each of them in order against the live database and reports which
 * one is firing.
 *
 *   npx tsx scripts/diagnose-whatsapp.ts
 *   npx tsx scripts/diagnose-whatsapp.ts --phone 919876543210
 *
 * Read-only. It changes nothing and prints no secrets.
 */

const ok = (s: string) => `  \x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `  \x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `  \x1b[33m!\x1b[0m ${s}`;
const head = (s: string) => `\n\x1b[1m${s}\x1b[0m`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type TokenCheck = {
  okay: boolean;
  expired: boolean;
  detail: string;
  verifiedName?: string;
};

/**
 * Asks Meta whether the token can actually read this number.
 *
 * A read, never a send: it proves the credential without costing a message or
 * bothering a patient. The token itself is never printed, and Meta's own error
 * text is discarded because it quotes the token back inside the message.
 */
async function checkToken(phoneNumberId: string, token: string): Promise<TokenCheck> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v23.0/${encodeURIComponent(phoneNumberId)}` +
        '?fields=id,verified_name,quality_rating',
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );

    const body = (await response.json()) as {
      verified_name?: string;
      error?: { code?: number; type?: string };
    };

    if (response.ok) {
      return { okay: true, expired: false, detail: 'ok', verifiedName: body.verified_name };
    }

    const code = body.error?.code;
    return {
      okay: false,
      expired: code === 190,
      detail: `http ${response.status}, code ${code ?? '?'}`,
    };
  } catch (error) {
    return {
      okay: false,
      expired: false,
      detail: error instanceof Error ? error.name : 'network error',
    };
  }
}

/** Normalises the way lib/domain/phone.ts does, so lookups match stored rows. */
function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.slice(-10);
  return `+91${ten}`;
}

async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is not set');

  const sql = postgres(url, { max: 1 });
  const phone = arg('phone');

  let blocking = 0;

  /* ---------------------------------------------------------- environment */

  console.log(head('1. Environment'));
  const envs = [
    ['WHATSAPP_ACCESS_TOKEN', 'outbound sends fall back to console logging'],
    ['WHATSAPP_APP_SECRET', 'the webhook rejects EVERY request with 401'],
    ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'Meta cannot re-verify the webhook'],
    ['PUBLIC_BASE_URL', 'queue links point nowhere'],
  ] as const;

  for (const [name, consequence] of envs) {
    // Presence only. The value is never printed.
    if (process.env[name]) console.log(ok(name));
    else {
      console.log(bad(`${name} is NOT set — ${consequence}`));
      blocking += 1;
    }
  }

  /* ------------------------------------------------- numbers and routing */

  console.log(head('2. Sender numbers and inbound routing'));

  const numbers = await sql<
    {
      phone_number_id: string;
      display_phone_number: string | null;
      status: string;
      quality_rating: string | null;
      hospital_id: string | null;
      hospital_name: string | null;
      hospital_active: boolean | null;
    }[]
  >`
    select n.phone_number_id, n.display_phone_number, n.status, n.quality_rating,
           n.hospital_id, h.name as hospital_name, h.active as hospital_active
    from whatsapp_numbers n
    left join hospitals h on h.id = n.hospital_id
    order by h.name nulls last
  `;

  if (numbers.length === 0) {
    console.log(bad('No rows in whatsapp_numbers at all. Nothing can route.'));
    blocking += 1;
  }

  /**
   * Only a number that belongs to a hospital is expected to route.
   *
   * A row with a NULL hospital_id is unassigned inventory, and it is *supposed*
   * to resolve to nothing — that is the design, not a fault. Reporting those as
   * failures buries the one line that matters under a wall of red.
   */
  const assigned = numbers.filter((n) => n.hospital_id);
  const inventory = numbers.filter((n) => !n.hospital_id);

  /** Assigned rows whose routing key cannot be a real Meta id. */
  const placeholderAssigned = assigned.filter(
    (n) => !/^\d{10,20}$/.test(n.phone_number_id.trim()),
  );

  for (const n of assigned) {
    const label = `${n.display_phone_number ?? n.phone_number_id} → ${n.hospital_name}`;

    // Mirrors resolve_whatsapp_number exactly: registered + active hospital, or
    // the webhook silently drops every message for this number.
    const [resolved] = await sql<{ hospital_id: string | null }[]>`
      select public.resolve_whatsapp_number(${n.phone_number_id}) as hospital_id
    `;

    /**
     * Resolving in SQL is necessary but not sufficient.
     *
     * The row can look perfect — assigned, registered, active hospital — and
     * still never match a real webhook, because what arrives from Meta is the
     * numeric phone_number_id, not the display number. A placeholder left by
     * the seed script resolves happily when queried with itself and matches
     * nothing Meta ever sends. That failure is invisible from the database and
     * accounts for the read-receipt-then-silence symptom exactly, so it is
     * checked separately here. Same rule as isPlausiblePhoneNumberId().
     */
    const looksReal = /^\d{10,20}$/.test(n.phone_number_id.trim());

    if (resolved?.hospital_id && !looksReal) {
      console.log(bad(`${label} — phone_number_id is NOT a real Meta id.`));
      console.log(`      stored: '${n.phone_number_id}'`);
      console.log(
        '      Meta sends a 15-ish digit numeric id. This is a placeholder, so\n' +
          '      every inbound webhook resolves to nothing and is dropped silently\n' +
          '      AFTER the read receipt is sent — blue tick, no reply.',
      );
      console.log(
        '      Fix: WhatsApp Manager → API Setup → copy "Phone number ID", then\n' +
          '      update this row (see section 7).',
      );
      blocking += 1;
      continue;
    }

    if (resolved?.hospital_id) {
      console.log(ok(`${label} — resolves, status=${n.status}, id=${n.phone_number_id}`));

      /**
       * Routing being correct proves nothing about whether we can reply.
       *
       * A token that is merely present passes every check that does not call
       * Meta, and an expired one fails the reply *and* the read receipt — which
       * is wrapped in .catch(() => {}) and so disappears without trace. The
       * visible result is a message that arrives with no blue tick and no
       * answer, which looks like a webhook problem and is not one. Only a real
       * request settles it.
       */
      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      if (token) {
        const live = await checkToken(n.phone_number_id, token);
        if (live.okay) {
          console.log(ok(`      token works — Meta returned '${live.verifiedName}'`));
        } else {
          console.log(bad(`      TOKEN REJECTED BY META (${live.detail})`));
          if (live.expired) {
            console.log(
              '      Error 190 means the token is expired or revoked. A token\n' +
                '      copied from the App Dashboard lasts 24 hours. Generate a\n' +
                '      permanent one: Business Settings → System Users → Add →\n' +
                '      Admin → Generate token, with whatsapp_business_messaging\n' +
                '      and whatsapp_business_management.',
            );
          }
          blocking += 1;
        }
      }
    } else {
      console.log(bad(`${label} — DOES NOT RESOLVE. Inbound is dropped silently.`));
      if (n.status !== 'registered') {
        console.log(`      cause: status is '${n.status}', must be 'registered'`);
      }
      if (n.hospital_active === false) console.log('      cause: hospital is inactive');
      blocking += 1;
    }

    if (n.quality_rating && n.quality_rating.toUpperCase() !== 'GREEN') {
      console.log(warn(`      quality rating is ${n.quality_rating}`));
    }
  }

  if (assigned.length === 0) {
    console.log(bad('No number is assigned to any hospital. Nothing can route.'));
    blocking += 1;
  }

  /**
   * A real id sitting in inventory while a placeholder holds the hospital.
   *
   * This is what a re-seed leaves behind: the working number was assigned once,
   * the demo hospital was then deleted, and ON DELETE SET NULL orphaned it
   * rather than removing it — after which seeding inserted a fresh placeholder
   * and took the hospital. Both rows look individually plausible, the resolver
   * is happy, and inbound still goes nowhere. It is also why the obvious fix
   * (renaming the placeholder to the real id) fails on the unique constraint.
   */
  const strandedReal = inventory.filter((n) => /^\d{10,20}$/.test(n.phone_number_id.trim()));
  if (strandedReal.length > 0 && placeholderAssigned.length > 0) {
    console.log(
      bad(
        '\n  A REAL phone number id is sitting unassigned while a placeholder\n' +
          '  holds the hospital. Renaming the placeholder will fail on the unique\n' +
          '  constraint — move the hospital onto the real row instead:',
      ),
    );
    for (const real of strandedReal) {
      console.log(`      real id in inventory: ${real.phone_number_id}`);
    }
    for (const ph of placeholderAssigned) {
      console.log(`      placeholder holding ${ph.hospital_name}: ${ph.phone_number_id}`);
    }
    blocking += 1;
  }

  if (inventory.length > 0) {
    console.log(
      `\n  ${inventory.length} unassigned number(s) in inventory — not an error; ` +
        'these are\n  meant not to resolve until a hospital is given one.',
    );

    /**
     * Orphans accumulate on their own. `whatsapp_numbers.hospital_id` is
     * ON DELETE SET NULL, so every re-seed that drops the demo hospital leaves
     * its number behind as inventory rather than removing it.
     */
    const orphans = inventory.filter((n) => /^(demo-)?pn-|^\+1 555/.test(n.phone_number_id));
    if (orphans.length > 0) {
      console.log(
        warn(
          `${orphans.length} look like leftovers from previous seed runs ` +
            '(ON DELETE SET NULL\n      orphans them instead of deleting them). Clean up with:\n' +
            "      delete from whatsapp_numbers where hospital_id is null and phone_number_id like 'pn-%';",
        ),
      );
    }
  }

  /* ---------------------------------------------------------- doctors */

  console.log(head('3. Active doctors'));

  const doctorCounts = await sql<
    { hospital_id: string; name: string; active_doctors: number }[]
  >`
    select h.id as hospital_id, h.name,
           count(d.id) filter (where d.active) ::int as active_doctors
    from hospitals h
    left join doctors d on d.hospital_id = h.id
    where h.active = true
    group by h.id, h.name
    order by h.name
  `;

  for (const row of doctorCounts) {
    if (row.active_doctors === 0) {
      // handleInboundMessage returns early on an empty doctor list, with no
      // reply — the patient gets a blue tick and silence.
      console.log(bad(`${row.name} — 0 active doctors. Bot returns without replying.`));
      blocking += 1;
    } else {
      console.log(ok(`${row.name} — ${row.active_doctors} active doctors`));
    }
  }

  /* ------------------------------------------------- the prompt budget */

  console.log(head('4. Prompt budget (the usual cause while testing)'));
  console.log(
    '  Cooldown 120s on the same step; daily cap 12 prompts per number.\n' +
      '  Both suppress the reply deliberately — blue tick, no response.',
  );

  const convos = await sql<
    {
      phone_e164: string;
      state: string;
      last_prompt_step: string | null;
      last_prompt_at: Date | null;
      prompts_today: number;
      prompts_date: string | null;
      seconds_since: number | null;
      hospital_name: string;
    }[]
  >`
    select c.phone_e164, c.state, c.last_prompt_step, c.last_prompt_at,
           c.prompts_today, c.prompts_date::text,
           extract(epoch from (now() - c.last_prompt_at))::int as seconds_since,
           h.name as hospital_name
    from whatsapp_conversations c
    join hospitals h on h.id = c.hospital_id
    ${phone ? sql`where c.phone_e164 = ${toE164(phone)}` : sql``}
    order by c.last_prompt_at desc nulls last
    limit ${phone ? 5 : 10}
  `;

  if (convos.length === 0) {
    console.log(
      warn(
        phone
          ? `No conversation row for ${toE164(phone)}. Either it never arrived, or routing dropped it (see section 2).`
          : 'No conversations yet.',
      ),
    );
  }

  const todayIST = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

  for (const c of convos) {
    console.log(`\n  ${c.phone_e164} @ ${c.hospital_name}`);
    console.log(`    state          ${c.state}`);
    console.log(`    last prompt    ${c.last_prompt_step ?? '—'}`);
    console.log(
      `    sent           ${
        c.seconds_since === null ? 'never' : `${c.seconds_since}s ago`
      }`,
    );

    const countsToday = c.prompts_date === todayIST;
    const used = countsToday ? c.prompts_today : 0;
    console.log(`    prompts today  ${used} / 12`);

    if (used >= 12) {
      console.log(bad('    DAILY CAP REACHED — suppressed until midnight IST.'));
      blocking += 1;
    } else if (c.seconds_since !== null && c.seconds_since < 120) {
      console.log(
        bad(
          `    IN COOLDOWN — ${120 - c.seconds_since}s left. A repeat of the same ` +
            'step is suppressed. This is the most common reason a test "stops working".',
        ),
      );
      blocking += 1;
    } else {
      console.log(ok('    not rate limited'));
    }
  }

  /* -------------------------------------------------------- dead messages */

  console.log(head('5. Messages killed by the idempotency guard'));

  const [stuck] = await sql<{ n: number }[]>`
    select count(*)::int as n
    from idempotency_keys
    where endpoint = 'whatsapp.inbound'
      and created_at > now() - interval '24 hours'
  `;
  console.log(`  ${stuck.n} inbound messages claimed in the last 24h`);
  console.log(
    warn(
      'The key is claimed BEFORE the reply is sent. If a send crashed after the\n' +
        '      claim, Meta redelivers and the message is dropped forever. A NEW\n' +
        '      message from the patient is unaffected.',
    ),
  );

  /* ------------------------------------------------------------- outbox */

  console.log(head('6. Outbound queue'));

  const outbox = await sql<{ status: string; n: number }[]>`
    select status, count(*)::int as n
    from notification_outbox
    where created_at > now() - interval '48 hours'
    group by status order by n desc
  `;

  if (outbox.length === 0) console.log(warn('Nothing queued in 48h.'));
  for (const row of outbox) {
    const line = `${row.n} ${row.status}`;
    if (row.status === 'failed') {
      console.log(bad(line));
      blocking += 1;
    } else console.log(ok(line));
  }

  /**
   * Is anything actually draining the queue?
   *
   * A row whose scheduled_for passed several minutes ago and is still pending
   * means no scheduler is calling /api/internal/tick. Nothing errors when that
   * happens — the outbox simply fills up in silence, and every reminder and
   * queue link stops arriving while the rest of the product looks healthy.
   * That is the single easiest failure in this system to miss, so it is checked
   * explicitly rather than inferred from a status count.
   */
  const [stale] = await sql<{ n: number; oldest_minutes: number | null }[]>`
    select
      count(*)::int as n,
      max(extract(epoch from (now() - scheduled_for)) / 60)::int as oldest_minutes
    from notification_outbox
    where status = 'pending' and scheduled_for < now() - interval '5 minutes'
  `;

  if (stale.n > 0) {
    console.log(
      bad(
        `\n  ${stale.n} message(s) overdue by up to ${stale.oldest_minutes} minutes.\n` +
          '  Nothing is draining the outbox. Reminders and queue links are NOT\n' +
          '  being delivered. Set up a scheduler to POST /api/internal/tick,\n' +
          '  or run: npm run worker:tick',
      ),
    );
    blocking += 1;
  } else {
    console.log(ok('no overdue messages — the outbox is being drained'));
  }

  const failures = await sql<
    { template_code: string; failed_reason: string | null; attempts: number; n: number }[]
  >`
    select template_code, failed_reason, attempts, count(*)::int as n
    from notification_outbox
    where status = 'failed' and created_at > now() - interval '48 hours'
    group by template_code, failed_reason, attempts
    order by n desc limit 10
  `;

  for (const f of failures) {
    console.log(`\n  ${f.n}× ${f.template_code} (${f.attempts} attempts)`);
    console.log(`     ${f.failed_reason ?? 'no reason recorded'}`);

    // 132xxx is Meta's template family. These are classified as permanent in
    // lib/notify/errors.ts, so a template that is merely under re-review after
    // an edit kills every message queued during the review window.
    if (f.failed_reason && /13200[0-9]|13201[0-9]/.test(f.failed_reason)) {
      console.log(
        bad(
          '     TEMPLATE ERROR — if you edited this template, Meta put it back\n' +
            '     into review. These were failed permanently instead of waiting.',
        ),
      );
    }
  }

  /* ------------------------------------------------- how to fix routing */

  const placeholders = placeholderAssigned;

  if (placeholders.length > 0) {
    console.log(head('7. Fixing a placeholder phone_number_id'));
    console.log(
      '  Get the real id: business.facebook.com → WhatsApp Manager → API Setup.\n' +
        '  "Phone number ID" is the numeric one BELOW the phone number itself.\n' +
        '  It is not the WABA id and not the number.\n',
    );

    if (strandedReal.length > 0) {
      /**
       * Renaming the placeholder cannot work here — phone_number_id is globally
       * unique and the real id is already taken by the orphaned row. The
       * hospital has to move to that row instead.
       */
      console.log(
        '  The real id is ALREADY a row in this table, so a rename would fail\n' +
          '  on whatsapp_numbers_phone_number_id_unique. Move the hospital across\n' +
          '  and drop the placeholder, in one transaction:\n',
      );
      const real = strandedReal[0].phone_number_id;
      const ph = placeholders[0].phone_number_id;
      console.log(`    BEGIN;`);
      console.log(`    UPDATE whatsapp_numbers SET`);
      console.log(
        `      hospital_id = (SELECT hospital_id FROM whatsapp_numbers\n` +
          `                     WHERE phone_number_id = '${ph}'),`,
      );
      console.log(`      status = 'registered', registered_at = COALESCE(registered_at, now())`);
      console.log(`    WHERE phone_number_id = '${real}';`);
      console.log(`    DELETE FROM whatsapp_numbers WHERE phone_number_id = '${ph}';`);
      console.log(`    COMMIT;\n`);
    } else {
      for (const n of placeholders) {
        console.log(`  For ${n.display_phone_number ?? n.hospital_name}:`);
        console.log(
          `    update whatsapp_numbers set phone_number_id = '<REAL_NUMERIC_ID>'\n` +
            `    where phone_number_id = '${n.phone_number_id}';\n`,
        );
      }
    }
  }

  /* ------------------------------------------------------------ verdict */

  console.log(head('Verdict'));
  if (blocking === 0) {
    console.log(ok('No blocking condition found. The pipeline looks healthy.'));
    console.log(
      '  If a reply still did not arrive, send a NEW message from a number that\n' +
        '  is not in cooldown, then re-run this immediately.',
    );
  } else {
    console.log(bad(`${blocking} blocking condition(s) above.`));
  }

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
