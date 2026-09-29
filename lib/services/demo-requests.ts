import { and, count, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
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

export const DEMO_REQUEST_STATUSES = [
  'new',
  'contacted',
  'demoed',
  'won',
  'lost',
] as const;
export type DemoRequestStatus = (typeof DEMO_REQUEST_STATUSES)[number];

/**
 * Moves a lead along the pipeline.
 *
 * The status column has existed since the table did, with nothing able to
 * change it — so every lead has sat on `new` regardless of what happened to
 * it, and the list has been a log rather than a pipeline. This is the missing
 * write.
 *
 * On the admin connection because `demo_requests` belongs to no hospital and
 * there is no tenant context to open. Access is gated by the caller.
 */
export async function setDemoRequestStatus(args: {
  id: string;
  status: DemoRequestStatus;
  notes?: string | null;
}) {
  const patch: { status: DemoRequestStatus; notes?: string | null } = { status: args.status };
  if (args.notes !== undefined) patch.notes = args.notes?.trim() || null;

  const [row] = await getAdminDb()
    .update(demoRequests)
    .set(patch)
    .where(eq(demoRequests.id, args.id))
    .returning({ id: demoRequests.id });

  return row ?? null;
}
