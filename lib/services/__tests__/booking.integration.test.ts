import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { appointments, notificationOutbox } from '@/lib/db/schema';
import type {
  InteractiveListMessage,
  NotificationProvider,
  SendResult,
  TemplateMessage,
  TextMessage,
} from '@/lib/notify/provider';
import { setProvider } from '@/lib/notify/provider';
import { DAILY_PROMPT_CAP } from '@/lib/domain/booking';
import { handleInboundMessage } from '@/lib/services/booking';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const uuid = () => crypto.randomUUID();

/** Counts what the business actually sends, which is what it actually pays for. */
class SpyProvider implements NotificationProvider {
  readonly name = 'spy';
  templates: TemplateMessage[] = [];
  lists: InteractiveListMessage[] = [];
  texts: TextMessage[] = [];

  async sendTemplate(message: TemplateMessage): Promise<SendResult> {
    this.templates.push(message);
    return { providerMessageId: `spy-t-${this.templates.length}` };
  }

  async sendText(message: TextMessage): Promise<SendResult> {
    this.texts.push(message);
    return { providerMessageId: `spy-x-${this.texts.length}` };
  }

  async sendInteractiveList(message: InteractiveListMessage): Promise<SendResult> {
    this.lists.push(message);
    return { providerMessageId: `spy-l-${this.lists.length}` };
  }

  get totalSent() {
    return this.templates.length + this.lists.length + this.texts.length;
  }
}

describe.skipIf(!enabled)('whatsapp booking', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 3 }) : (null as never);
  let hospitalId: string;
  let doctorId: string;
  let phoneNumberId: string;
  let spy: SpyProvider;

  const inbound = (n: number, message: { text?: string; replyId?: string }) =>
    handleInboundMessage({
      phoneNumberId,
      messageId: `wamid-${uuid()}`,
      fromPhone: '919876500001',
      ...message,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

  beforeEach(async () => {
    spy = new SpyProvider();
    setProvider(spy);

    hospitalId = uuid();
    doctorId = uuid();
    phoneNumberId = `pn-${uuid()}`;
    const branchId = uuid();

    await admin`
      insert into hospitals (id, name, slug)
      values (${hospitalId}, 'WA Hospital', ${'wa-' + hospitalId.slice(0, 10)})
    `;
    await admin`
      insert into whatsapp_numbers (hospital_id, phone_number_id, status, verified_name)
      values (${hospitalId}, ${phoneNumberId}, 'registered', 'WA Hospital')
    `;
    await admin`
      insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Kulkarni')
    `;
  });

  afterAll(async () => {
    if (!enabled) return;
    setProvider(undefined);
    await admin`delete from hospitals where name = 'WA Hospital'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  const appointmentsFor = () =>
    withTenant(hospitalId, (tx) =>
      tx.select().from(appointments).where(eq(appointments.hospitalId, hospitalId)),
    );

  it('books a first-time patient in four business messages', async () => {
    await inbound(1, { text: 'Hi' });
    await inbound(2, { replyId: 'lang:mr' });
    await inbound(3, { replyId: `doc:${doctorId}` });
    await inbound(4, { replyId: 'slot:now' });

    // Three interactive prompts, then the confirmation with the queue link.
    expect(spy.lists).toHaveLength(3);
    expect(spy.texts).toHaveLength(1);
    expect(spy.totalSent).toBe(4);

    const created = await appointmentsFor();
    expect(created).toHaveLength(1);
    expect(created[0].source).toBe('whatsapp');

    // The link is in the confirmation the patient actually received.
    expect(spy.texts[0].body).toContain(created[0].publicToken);
    expect(spy.texts[0].body).toContain(String(created[0].tokenNumber));
  });

  /**
   * The confirmation goes out in-session, so the queued template must be closed
   * out or the worker would send the patient a second copy of the same link.
   */
  it('does not leave the queue link template pending after confirming', async () => {
    await inbound(1, { text: 'Hi' });
    await inbound(2, { replyId: 'lang:en' });
    await inbound(3, { replyId: `doc:${doctorId}` });
    await inbound(4, { replyId: 'slot:now' });

    const [created] = await appointmentsFor();
    const queued = await withTenant(hospitalId, (tx) =>
      tx
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.appointmentId, created.id)),
    );

    const links = queued.filter((row) => row.milestone === 'queue_link');
    expect(links).toHaveLength(1);
    expect(links[0].status).toBe('sent');
  });

  /**
   * The whole cost model rests on this. Language is stored against the patient
   * after the first booking, so the second one skips that question entirely.
   */
  it('books a returning patient in three, having remembered their language', async () => {
    await inbound(1, { text: 'Hi' });
    await inbound(2, { replyId: 'lang:mr' });
    await inbound(3, { replyId: `doc:${doctorId}` });
    await inbound(4, { replyId: 'slot:now' });

    const firstVisitSends = spy.lists.length;
    spy.lists = [];
    spy.texts = [];

    // Same patient, a later visit. Clear the day's appointment first so the
    // one-active-token constraint does not reject the second booking.
    await admin`delete from appointments where hospital_id = ${hospitalId}`;

    await inbound(5, { text: 'Hi' });
    await inbound(6, { replyId: `doc:${doctorId}` });
    await inbound(7, { replyId: 'slot:now' });

    expect(firstVisitSends).toBe(3);
    expect(spy.lists).toHaveLength(2);
    expect(spy.lists.some((m) => m.rows.some((r) => r.id.startsWith('lang:')))).toBe(false);
  });

  /**
   * Every tap of "Hi" arrives as a distinct Meta message with its own id, so
   * replay protection does not touch it. Before the prompt budget, five taps
   * bought five identical menus — five billable messages for one intention.
   */
  it('answers five taps of "Hi" with a single menu', async () => {
    for (let i = 0; i < 5; i += 1) await inbound(i, { text: 'Hi' });

    expect(spy.lists).toHaveLength(1);
    expect(spy.totalSent).toBe(1);
  });

  it('still lets the patient progress immediately after a suppressed repeat', async () => {
    await inbound(1, { text: 'Hi' });
    await inbound(2, { text: 'Hi' });
    expect(spy.lists).toHaveLength(1);

    // Suppression must never block forward movement, only repetition.
    await inbound(3, { replyId: 'lang:en' });
    expect(spy.lists).toHaveLength(2);

    await inbound(4, { replyId: `doc:${doctorId}` });
    expect(spy.lists).toHaveLength(3);

    await inbound(5, { replyId: 'slot:now' });
    expect(await appointmentsFor()).toHaveLength(1);
    expect(spy.texts).toHaveLength(1);
  });

  it('never exceeds the daily prompt budget however hard it is pushed', async () => {
    for (let i = 0; i < 16; i += 1) {
      await inbound(i, i % 2 === 0 ? { text: 'Hi' } : { replyId: 'lang:en' });
    }

    expect(spy.lists.length).toBeLessThanOrEqual(DAILY_PROMPT_CAP);
  });

  it('ignores a redelivered webhook instead of issuing a second token', async () => {
    const messageId = `wamid-${uuid()}`;
    const payload = {
      phoneNumberId,
      messageId,
      fromPhone: '919876500001',
      text: 'Hi',
    };

    await handleInboundMessage(payload);
    await handleInboundMessage(payload);
    await handleInboundMessage(payload);

    // Meta retries aggressively on any non-2xx; only the first may take effect.
    expect(spy.totalSent).toBe(1);
  });

  it('ignores a message for a WhatsApp number we do not know', async () => {
    await handleInboundMessage({
      phoneNumberId: 'pn-not-ours',
      messageId: `wamid-${uuid()}`,
      fromPhone: '919876500001',
      text: 'Hi',
    });

    expect(spy.totalSent).toBe(0);
    expect(await appointmentsFor()).toHaveLength(0);
  });

  it('refuses a doctor id belonging to another hospital', async () => {
    await inbound(1, { text: 'Hi' });
    await inbound(2, { replyId: 'lang:en' });
    const doctorMenus = spy.lists.length;

    await inbound(3, { replyId: `doc:${uuid()}` });

    // Nothing is booked against an id we cannot vouch for. No new menu goes out
    // either: the transition falls back to ask_doctor, which the patient was
    // just sent and still has on screen.
    expect(await appointmentsFor()).toHaveLength(0);
    expect(spy.lists).toHaveLength(doctorMenus);
    expect(spy.lists.at(-1)?.rows.every((r) => r.id.startsWith('doc:'))).toBe(true);
  });
});
