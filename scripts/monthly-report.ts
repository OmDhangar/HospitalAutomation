import 'dotenv/config';
import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import { closeAdminDb, getAdminDb } from '@/lib/db/admin';
import { appointments, hospitals, notificationOutbox } from '@/lib/db/schema';
import { getProvider } from '@/lib/notify/provider';
import type { Locale } from '@/lib/i18n/patient';

/**
 * Sends each hospital owner one summary of the month just gone.
 *
 * Run on the first of the month:
 *   tsx scripts/monthly-report.ts            (previous month)
 *   tsx scripts/monthly-report.ts 2026-08    (a specific month)
 *
 * Sent directly rather than through the outbox: the outbox exists to de-duplicate
 * per-appointment notifications, and this message belongs to no appointment. It
 * is still recorded there so it counts towards messages-per-appointment — a
 * message we do not meter is margin we cannot see.
 */
function previousMonth(at = new Date()): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const month = process.argv[2] ?? previousMonth();
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);

  const db = getAdminDb();
  const provider = getProvider();

  const targets = await db
    .select({
      id: hospitals.id,
      name: hospitals.name,
      phone: hospitals.ownerPhoneE164,
      locale: hospitals.defaultLocale,
      phoneNumberId: hospitals.whatsappPhoneNumberId,
    })
    .from(hospitals)
    .where(and(eq(hospitals.active, true), sql`${hospitals.ownerPhoneE164} is not null`));

  if (targets.length === 0) {
    console.log('No hospitals have an owner phone number configured.');
    return;
  }

  for (const hospital of targets) {
    const [seen] = await db
      .select({ value: count() })
      .from(appointments)
      .where(
        and(
          eq(appointments.hospitalId, hospital.id),
          eq(appointments.status, 'COMPLETED'),
          gte(appointments.completedAt, start),
          lt(appointments.completedAt, end),
        ),
      );

    const [noShows] = await db
      .select({ value: count() })
      .from(appointments)
      .where(
        and(
          eq(appointments.hospitalId, hospital.id),
          eq(appointments.status, 'NO_SHOW'),
          gte(appointments.createdAt, start),
          lt(appointments.createdAt, end),
        ),
      );

    const [wait] = await db
      .select({
        median: sql<number | null>`
          percentile_cont(0.5) within group (
            order by extract(epoch from (${appointments.calledAt} - ${appointments.enqueuedAt})) / 60
          )
        `,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.hospitalId, hospital.id),
          gte(appointments.calledAt, start),
          lt(appointments.calledAt, end),
          sql`${appointments.enqueuedAt} is not null`,
        ),
      );

    const patientsSeen = Number(seen?.value ?? 0);
    if (patientsSeen === 0) {
      console.log(`${hospital.name}: no completed appointments in ${month}, skipping`);
      continue;
    }

    const medianWait = wait?.median === null ? 0 : Math.round(Number(wait?.median ?? 0));
    const variables = [
      month,
      String(patientsSeen),
      String(medianWait),
      String(Number(noShows?.value ?? 0)),
    ];

    const result = await provider.sendTemplate({
      phoneNumberId: hospital.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'dev',
      toPhoneE164: hospital.phone!,
      templateCode: 'owner_monthly_report',
      locale: hospital.locale as Locale,
      variables,
    });

    await db.insert(notificationOutbox).values({
      hospitalId: hospital.id,
      milestone: `owner_report:${month}`,
      templateCode: 'owner_monthly_report',
      locale: hospital.locale,
      payload: { month, patientsSeen, medianWait },
      status: 'sent',
      providerMessageId: result.providerMessageId,
      sentAt: new Date(),
    });

    console.log(
      `${hospital.name}: ${patientsSeen} seen, median wait ${medianWait}m — report sent`,
    );
  }

  await closeAdminDb();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
