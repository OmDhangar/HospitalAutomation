import { and, count, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { demoRequests } from '@/lib/db/schema';
import {
  MAX_DEMO_REQUESTS_PER_PHONE_PER_DAY,
  startOfDayIn,
  type DemoRequestInput,
} from '@/lib/domain/demo-request';

const PRODUCT_TIMEZONE = 'Asia/Kolkata';

export type CreateDemoRequestResult = { ok: true } | { ok: false; reason: 'throttled' };

/**
 * Public write path. The table has no RLS because it belongs to no hospital;
 * the cap below is what stops the form becoming a spam target.
 */
export async function createDemoRequest(
  input: DemoRequestInput,
): Promise<CreateDemoRequestResult> {
  const db = getDb();
  const since = startOfDayIn(PRODUCT_TIMEZONE);

  const [row] = await db
    .select({ n: count() })
    .from(demoRequests)
    .where(
      and(eq(demoRequests.phoneE164, input.phoneE164), gte(demoRequests.createdAt, since)),
    );

  if ((row?.n ?? 0) >= MAX_DEMO_REQUESTS_PER_PHONE_PER_DAY) {
    return { ok: false, reason: 'throttled' };
  }

  await db.insert(demoRequests).values({
    name: input.name,
    organisation: input.organisation,
    phoneE164: input.phoneE164,
    city: input.city,
    patientsPerDay: input.patientsPerDay,
  });

  return { ok: true };
}

export async function listDemoRequests(limit = 50) {
  return getDb()
    .select()
    .from(demoRequests)
    .orderBy(desc(demoRequests.createdAt))
    .limit(limit);
}
