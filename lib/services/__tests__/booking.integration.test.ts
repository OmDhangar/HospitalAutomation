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
} from '@/lib/notify/provider';
import { setProvider } from '@/lib/notify/provider';
import { handleInboundMessage } from '@/lib/services/booking';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const uuid = () => crypto.randomUUID();

/** Counts what the business actually sends, which is what it actually pays for. */
class SpyProvider implements NotificationProvider {
  readonly name = 'spy';
  templates: TemplateMessage[] = [];
  lists: InteractiveListMessage[] = [];

  async sendTemplate(message: TemplateMessage): Promise<SendResult> {
    this.templates.push(message);
    return { providerMessageId: `spy-t-${this.templates.length}` };
  }

  async sendInteractiveList(message: InteractiveListMessage): Promise<SendResult> {
    this.lists.push(message);
    return { providerMessageId: `spy-l-${this.lists.length}` };
  }

  get totalSent() {
    return this.templates.length + this.lists.length;
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
      insert into hospitals (id, name, slug, whatsapp_phone_number_id)
      values (${hospitalId}, 'WA Hospital', ${'wa-' + hospitalId.slice(0, 10)}, ${phoneNumberId})
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

    // Three interactive prompts, plus the token link queued for the worker.
    expect(spy.lists).toHaveLength(3);

    const created = await appointmentsFor();
    expect(created).toHaveLength(1);
    expect(created[0].source).toBe('whatsapp');

    const queued = await withTenant(hospitalId, (tx) =>
      tx
        .select()
        .from(notificationOutbox)
        .where(eq(notificationOutbox.appointmentId, created[0].id)),
    );
    expect(queued.filter((row) => row.milestone === 'queue_link')).toHaveLength(1);
    expect(spy.lists.length + queued.length).toBe(4);
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
    spy.lists = [];

    await inbound(3, { replyId: `doc:${uuid()}` });

    // Asks again rather than booking against an id it cannot vouch for.
    expect(await appointmentsFor()).toHaveLength(0);
    expect(spy.lists[0]?.rows.every((r) => r.id.startsWith('doc:'))).toBe(true);
  });
});
