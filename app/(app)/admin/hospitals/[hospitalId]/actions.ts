'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { setSessionCookie } from '@/lib/auth/session';
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '@/lib/domain/subscription';
import { createStaffUser, type StaffRole } from '@/lib/services/auth';
import { ImpersonationError, startImpersonation } from '@/lib/services/impersonation';
import {
  AccountAdminError,
  resetUserPassword,
  setHospitalActive,
  setMembershipActive,
  setUserActive,
  updateHospitalProfile,
} from '@/lib/services/platform-admin';
import {
  changeSubscriptionTier,
  extendExpiry,
  renewSubscription,
  setSubscriptionStatus,
} from '@/lib/services/subscriptions';

/**
 * Operator actions against one hospital.
 *
 * Every export re-derives the operator from the session rather than accepting
 * one. A server action is a POST endpoint: the hospital id below arrives from
 * the page, but the authority to act on it never does.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hospitalIdFrom(formData: FormData): string {
  const value = String(formData.get('hospitalId') ?? '').trim();
  if (!UUID_RE.test(value)) redirect('/admin/hospitals');
  return value;
}

const text = (formData: FormData, key: string): string =>
  String(formData.get(key) ?? '').trim();

function back(hospitalId: string, params: Record<string, string>): never {
  const query = new URLSearchParams(params).toString();
  revalidatePath(`/admin/hospitals/${hospitalId}`);
  redirect(`/admin/hospitals/${hospitalId}${query ? `?${query}` : ''}`);
}

/**
 * Turns a thrown service error into a code the page can render.
 *
 * Codes, never messages: the page matches against a known list before
 * displaying anything, so a crafted query string cannot put arbitrary text on
 * an operator's screen.
 */
function fail(hospitalId: string, error: unknown): never {
  if (error instanceof AccountAdminError) back(hospitalId, { error: error.code });
  if (error instanceof ImpersonationError) back(hospitalId, { error: error.code });
  throw error;
}

/* ------------------------------------------------------------ lifecycle */

export async function setHospitalActiveAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);
  const active = text(formData, 'active') === 'true';
  const reason = text(formData, 'reason');

  // Switching an account off is the one irreversible-feeling action here, so
  // it is gated on typing the word rather than on a second click.
  if (!active && text(formData, 'confirm').toUpperCase() !== 'SUSPEND') {
    back(hospitalId, { error: 'CONFIRM' });
  }

  try {
    await setHospitalActive({ hospitalId, active, reason, actorUserId: session.userId });
  } catch (error) {
    fail(hospitalId, error);
  }

  back(hospitalId, { done: active ? 'activated' : 'suspended' });
}

export async function updateProfileAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);

  const discountRaw = text(formData, 'discountPercent');
  const discountPercent = discountRaw === '' ? undefined : Number(discountRaw);
  if (discountPercent !== undefined && !Number.isFinite(discountPercent)) {
    back(hospitalId, { error: 'INVALID_INPUT' });
  }

  try {
    await updateHospitalProfile({
      hospitalId,
      name: text(formData, 'name') || undefined,
      timezone: text(formData, 'timezone') || undefined,
      ownerPhoneE164: formData.has('ownerPhoneE164') ? text(formData, 'ownerPhoneE164') : undefined,
      discountPercent,
      actorUserId: session.userId,
    });
  } catch (error) {
    fail(hospitalId, error);
  }

  back(hospitalId, { done: 'profile' });
}

/* --------------------------------------------------------- subscription */

export async function changePlanAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);
  const tierCode = text(formData, 'tierCode');
  const billingCycle = text(formData, 'billingCycle') === 'annual' ? 'annual' : 'monthly';

  if (!tierCode) back(hospitalId, { error: 'INVALID_INPUT' });

  try {
    await changeSubscriptionTier({
      hospitalId,
      tierCode,
      billingCycle,
      changedByUserId: session.userId,
      reason: text(formData, 'reason') || undefined,
    });
  } catch (error) {
    // `changeSubscriptionTier` throws a plain Error for an unknown tier code,
    // which is the only way this realistically fails from a select element.
    if (error instanceof Error && error.message.startsWith('Unknown plan tier')) {
      back(hospitalId, { error: 'UNKNOWN_TIER' });
    }
    fail(hospitalId, error);
  }

  back(hospitalId, { done: 'plan' });
}

export async function setSubscriptionStatusAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);
  const raw = text(formData, 'status');

  const status = SUBSCRIPTION_STATUSES.find((value) => value === raw) as
    | SubscriptionStatus
    | undefined;
  if (!status) back(hospitalId, { error: 'INVALID_INPUT' });

  try {
    await setSubscriptionStatus({ hospitalId, status, changedByUserId: session.userId });
  } catch (error) {
    fail(hospitalId, error);
  }

  back(hospitalId, { done: 'status' });
}

export async function extendTermAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);
  const raw = text(formData, 'endsAt');

  // Parsed as end-of-day so "extend to the 31st" includes the 31st.
  const endsAt = new Date(`${raw}T23:59:59.000Z`);
  if (!raw || Number.isNaN(endsAt.getTime())) back(hospitalId, { error: 'INVALID_INPUT' });

  try {
    await extendExpiry({ hospitalId, endsAt, changedByUserId: session.userId });
  } catch (error) {
    fail(hospitalId, error);
  }

  back(hospitalId, { done: 'extended' });
}

export async function renewTermAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);

  try {
    await renewSubscription({ hospitalId, changedByUserId: session.userId });
  } catch (error) {
    if (error instanceof Error && error.message === 'No subscription to renew') {
      back(hospitalId, { error: 'NO_SUBSCRIPTION' });
    }
    fail(hospitalId, error);
  }

  back(hospitalId, { done: 'renewed' });
}

/* ---------------------------------------------------------------- users */

export type ResetPasswordState =
  | { status: 'idle' }
  | { status: 'error'; code: string }
  | { status: 'done'; email: string; temporaryPassword: string };

/**
 * Returns the new password instead of redirecting with it.
 *
 * A redirect would put a live credential in a URL, and from there into browser
 * history, the server log and whatever sits in front of the app. Returned
 * through `useActionState`, it exists in one response and nowhere else.
 */
export async function resetPasswordAction(
  _previous: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const session = await requirePlatformAdmin();
  const hospitalId = String(formData.get('hospitalId') ?? '').trim();
  const userId = String(formData.get('userId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();

  if (!UUID_RE.test(hospitalId) || !UUID_RE.test(userId)) {
    return { status: 'error', code: 'INVALID_INPUT' };
  }
  if (!reason) return { status: 'error', code: 'REASON_REQUIRED' };

  try {
    const result = await resetUserPassword({
      userId,
      hospitalId,
      reason,
      actorUserId: session.userId,
    });
    revalidatePath(`/admin/hospitals/${hospitalId}`);
    return { status: 'done', ...result };
  } catch (error) {
    if (error instanceof AccountAdminError) return { status: 'error', code: error.code };
    throw error;
  }
}

export async function setUserActiveAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);
  const userId = text(formData, 'userId');
  const active = text(formData, 'active') === 'true';

  if (!UUID_RE.test(userId)) back(hospitalId, { error: 'INVALID_INPUT' });

  try {
    await setUserActive({ userId, hospitalId, active, actorUserId: session.userId });
  } catch (error) {
    fail(hospitalId, error);
  }

  back(hospitalId, { done: active ? 'user_activated' : 'user_deactivated' });
}

export async function setMembershipActiveAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);
  const membershipId = text(formData, 'membershipId');
  const active = text(formData, 'active') === 'true';

  if (!UUID_RE.test(membershipId)) back(hospitalId, { error: 'INVALID_INPUT' });

  try {
    await setMembershipActive({
      membershipId,
      hospitalId,
      active,
      actorUserId: session.userId,
    });
  } catch (error) {
    fail(hospitalId, error);
  }

  back(hospitalId, { done: active ? 'access_restored' : 'access_revoked' });
}

const ROLES: StaffRole[] = ['owner', 'receptionist', 'doctor'];

export async function addStaffAction(formData: FormData) {
  await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);
  const email = text(formData, 'email');
  const name = text(formData, 'name');
  const rawRole = text(formData, 'role');
  const role = ROLES.find((value) => value === rawRole);

  if (!email || !name || !role) back(hospitalId, { error: 'INVALID_INPUT' });

  try {
    await createStaffUser({ email, name, hospitalId, role });
  } catch (error) {
    // The plan-limit path throws PlanLimitError; anything else is unexpected.
    if (error instanceof Error && error.name === 'PlanLimitError') {
      back(hospitalId, { error: 'PLAN_LIMIT' });
    }
    fail(hospitalId, error);
  }

  back(hospitalId, { done: 'staff_added' });
}

/* -------------------------------------------------------- impersonation */

/**
 * Opens a read-only support session inside a customer's account.
 *
 * The cookie is swapped rather than added, so there is one session at a time
 * and no way to have an operator window and a customer window disagreeing
 * about who is signed in. Ending it mints a fresh operator session.
 */
export async function startImpersonationAction(formData: FormData) {
  const session = await requirePlatformAdmin();
  const hospitalId = hospitalIdFrom(formData);
  const reason = text(formData, 'reason');

  if (!reason) back(hospitalId, { error: 'REASON_REQUIRED' });

  let token: string;
  try {
    ({ token } = await startImpersonation({
      operatorUserId: session.userId,
      hospitalId,
      returnHospitalId: session.hospitalId,
      reason,
    }));
  } catch (error) {
    fail(hospitalId, error);
  }

  await setSessionCookie(token);
  redirect('/dashboard');
}
