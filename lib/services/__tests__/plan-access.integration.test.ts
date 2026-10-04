import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { LAPSE_GRACE_DAYS, addDays } from '@/lib/domain/subscription';
import {
  SubscriptionAdminError,
  clearPlanAccessCache,
  expireLapsedSubscriptions,
  getPlanAccess,
  renewSubscription,
  restoreSubscription,
  revokeSubscription,
  startTrial,
} from '@/lib/services/subscriptions';
import { BookingError, bookScheduledSlot } from '@/lib/services/web-booking';

/**
 * Trials of any length, revoking a plan, and what each does to a hospital's
 * access, against a real database.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Plan Access Test Hospital';

describe.skipIf(!enabled)('plan access', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  let hospitalId = '';

  beforeEach(async () => {
    hospitalId = uuid();
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'pa-' + hospitalId.slice(0, 12)})`;
    clearPlanAccessCache();
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await Promise.all([admin.end(), closeDb()]);
  });

  const access = async (now?: Date) => {
    clearPlanAccessCache(hospitalId);
    return getPlanAccess(hospitalId, now);
  };

  it('starts a 15-day trial at nothing, on the chosen tier', async () => {
    const startsAt = new Date();
    const trial = await startTrial({ hospitalId, tierCode: 'solo', days: 15, startsAt });
    expect(trial).toMatchObject({ status: 'trial', pricePaise: 0, setupFeePaise: 0, planTierCode: 'solo' });
    expect(trial.endsAt.getTime()).toBe(addDays(startsAt, 15).getTime());
    expect(await access()).toEqual({ state: 'open' });
  });

  it('refuses a trial of no days or more than ninety', async () => {
    await expect(startTrial({ hospitalId, tierCode: 'solo', days: 0 })).rejects.toBeInstanceOf(SubscriptionAdminError);
    await expect(startTrial({ hospitalId, tierCode: 'solo', days: 91 })).rejects.toBeInstanceOf(SubscriptionAdminError);
  });

  it('ends a trial by itself, gives grace days, then locks', async () => {
    const startsAt = addDays(new Date(), -16);
    await startTrial({ hospitalId, tierCode: 'solo', days: 15, startsAt });

    await expireLapsedSubscriptions();
    const [row] = await admin`select status from subscriptions where hospital_id = ${hospitalId}`;
    expect(row.status).toBe('expired');

    expect((await access()).state).toBe('grace');
    expect(await access(addDays(new Date(), LAPSE_GRACE_DAYS))).toMatchObject({ state: 'locked', reason: 'lapsed' });
  });

  it('renews a trial at the tier price, not at the trial’s nil', async () => {
    await startTrial({ hospitalId, tierCode: 'solo', days: 20 });
    const paid = await renewSubscription({ hospitalId });
    const [tier] = await admin`select monthly_price_paise from plan_tiers where code = 'solo'`;
    expect(paid).toMatchObject({ status: 'active', changeReason: 'trial_converted', pricePaise: tier.monthly_price_paise });
  });

  it('revokes a plan now, and restores it exactly as it was', async () => {
    await startTrial({ hospitalId, tierCode: 'solo', days: 20 });

    await expect(revokeSubscription({ hospitalId, reason: ' ' })).rejects.toBeInstanceOf(SubscriptionAdminError);
    await revokeSubscription({ hospitalId, reason: 'Trial misuse' });
    expect(await access()).toMatchObject({ state: 'locked', reason: 'revoked' });
    await expect(revokeSubscription({ hospitalId, reason: 'Again' })).rejects.toBeInstanceOf(SubscriptionAdminError);

    const [audit] = await admin`
      select metadata from audit_logs where hospital_id = ${hospitalId} and action = 'subscription.revoked'`;
    expect(audit.metadata).toMatchObject({ reason: 'Trial misuse' });

    await restoreSubscription({ hospitalId });
    const [row] = await admin`select status, cancelled_at from subscriptions where hospital_id = ${hospitalId}`;
    expect(row).toMatchObject({ status: 'trial', cancelled_at: null });
    expect(await access()).toEqual({ state: 'open' });
    await expect(restoreSubscription({ hospitalId })).rejects.toBeInstanceOf(SubscriptionAdminError);
  });

  it('refuses online bookings while the plan is revoked', async () => {
    await startTrial({ hospitalId, tierCode: 'solo', days: 20 });
    await revokeSubscription({ hospitalId, reason: 'Unpaid' });
    clearPlanAccessCache(hospitalId);

    const booking = bookScheduledSlot({
      hospitalId,
      doctorId: uuid(),
      patientName: 'Walk Up',
      phoneE164: '+919800000001',
      slotDatetimeIso: addDays(new Date(), 1).toISOString(),
    });
    await expect(booking).rejects.toMatchObject({ code: 'NOT_TAKING_BOOKINGS' });
    await expect(booking).rejects.toBeInstanceOf(BookingError);
  });

  it('never locks a hospital that was never put on a plan', async () => {
    expect(await access()).toEqual({ state: 'open' });
  });
});
