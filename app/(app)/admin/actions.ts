'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from '@/lib/auth/session';
import { isPlausiblePhoneNumberId } from '@/lib/domain/whatsapp-integration';
import { endImpersonation, ImpersonationError } from '@/lib/services/impersonation';
import { StaffAccountError } from '@/lib/services/auth';
import { createHospital } from '@/lib/services/platform';
import { WabaBindingError } from '@/lib/services/whatsapp-byo';
import {
  assignNumberToHospital,
  IntegrationAuthError,
  IntegrationError,
  type Actor,
} from '@/lib/services/whatsapp-integration';
import { refreshNumberHealth, returnNumberToInventory } from '@/lib/services/whatsapp-numbers';

/**
 * Platform operations, all of which cross tenant boundaries by design.
 *
 * `requirePlatformAdmin` is checked here and again inside each service
 * function. That duplication is deliberate: a server action is a POST endpoint
 * reachable without any page having rendered, so the check that matters is the
 * one in the function that runs.
 */
async function authorizePlatform(): Promise<Actor> {
  const session = await requirePlatformAdmin();
  return { userId: session.userId, role: session.role, isPlatformAdmin: true };
}

function failWith(path: string, error: unknown): never {
  if (error instanceof IntegrationError) {
    redirect(`${path}?error=${encodeURIComponent(error.errorCode)}`);
  }
  if (error instanceof IntegrationAuthError) {
    redirect(`${path}?error=PERMISSION_DENIED`);
  }
  throw error;
}

/* -------------------------------------------------------------- WhatsApp */

/**
 * Gives a hospital one of our numbers.
 *
 * The hospital id comes from a select on the console rather than from a
 * session, because this is the one flow that legitimately acts on another
 * tenant. It is safe only because the service re-checks platform admin and
 * because Meta is asked to confirm the number is in our WABA before anything
 * is written.
 */
export async function assignNumber(formData: FormData) {
  const actor = await authorizePlatform();

  const hospitalId = String(formData.get('hospitalId') ?? '').trim();
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();

  if (!hospitalId) redirect('/admin/whatsapp?error=CONFIGURATION_ERROR');
  if (!isPlausiblePhoneNumberId(phoneNumberId)) {
    redirect('/admin/whatsapp?error=INVALID_PHONE_NUMBER');
  }

  try {
    await assignNumberToHospital({ hospitalId, phoneNumberId, actor });
  } catch (error) {
    failWith('/admin/whatsapp', error);
  }

  revalidatePath('/admin/whatsapp');
  redirect('/admin/whatsapp?assigned=1');
}

/** Pulls the current quality rating and throughput tier from Meta. */
export async function refreshHealth(formData: FormData) {
  const actor = await authorizePlatform();
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();

  try {
    await refreshNumberHealth({ phoneNumberId, actor });
  } catch (error) {
    failWith('/admin/whatsapp', error);
  }

  revalidatePath('/admin/whatsapp');
  redirect('/admin/whatsapp?refreshed=1');
}

/** Takes a number back for the next customer. */
export async function releaseNumber(formData: FormData) {
  const actor = await authorizePlatform();
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();

  if (String(formData.get('confirm') ?? '').trim().toUpperCase() !== 'RELEASE') {
    redirect('/admin/whatsapp?error=CONFIRM');
  }

  try {
    await returnNumberToInventory({ phoneNumberId, actor });
  } catch (error) {
    failWith('/admin/whatsapp', error);
  }

  revalidatePath('/admin/whatsapp');
  redirect('/admin/whatsapp?released=1');
}

/* ------------------------------------------------------------- onboarding */

/**
 * Onboards a brand-new hospital tenant with owner user, initial branch,
 * plan tier, and optional doctor / WhatsApp number.
 */
export async function createHospitalAction(formData: FormData) {
  const actor = await authorizePlatform();

  const name = String(formData.get('name') ?? '').trim();
  const ownerName = String(formData.get('ownerName') ?? '').trim();
  const ownerEmail = String(formData.get('ownerEmail') ?? '').trim();
  const ownerPassword = String(formData.get('ownerPassword') ?? '').trim() || undefined;
  const ownerPhoneE164 = String(formData.get('ownerPhoneE164') ?? '').trim() || undefined;
  const branchName = String(formData.get('branchName') ?? '').trim() || 'Main Branch';
  const branchAddress = String(formData.get('branchAddress') ?? '').trim() || undefined;
  const planTierCode = String(formData.get('planTierCode') ?? '').trim() || 'free';
  const billingCycle = String(formData.get('billingCycle') ?? 'monthly') === 'annual'
    ? ('annual' as const)
    : ('monthly' as const);

  const initialDoctorName = String(formData.get('initialDoctorName') ?? '').trim() || undefined;
  const initialDoctorSpecialty =
    String(formData.get('initialDoctorSpecialty') ?? '').trim() || undefined;
  const rawMode = String(formData.get('initialDoctorMode') ?? 'both');
  const initialDoctorMode = rawMode === 'slot' ? 'slot' : rawMode === 'queue' ? 'queue' : 'both';
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim() || undefined;

  if (!name || !ownerName || !ownerEmail) {
    redirect('/admin/onboard?error=REQUIRED_FIELDS');
  }

  /**
   * The hospital's own WhatsApp Business Account. All five fields or none:
   * a partial binding produces an integration that answers Meta's handshake
   * and then rejects every message, which is harder to diagnose than an
   * integration that plainly does not exist yet.
   */
  const wabaFields = {
    phoneNumberId: String(formData.get('wabaPhoneNumberId') ?? '').trim(),
    wabaId: String(formData.get('wabaBusinessAccountId') ?? '').trim(),
    accessToken: String(formData.get('wabaAccessToken') ?? '').trim(),
    verifyToken: String(formData.get('wabaVerifyToken') ?? '').trim(),
    appSecret: String(formData.get('wabaAppSecret') ?? '').trim(),
  };
  const providedCount = Object.values(wabaFields).filter(Boolean).length;
  if (providedCount > 0 && providedCount < 5) {
    redirect('/admin/onboard?error=WABA_INCOMPLETE');
  }

  const waba =
    providedCount === 5
      ? {
          ...wabaFields,
          businessId: String(formData.get('wabaMetaBusinessId') ?? '').trim() || undefined,
          displayPhoneNumber:
            String(formData.get('wabaDisplayNumber') ?? '').trim() || undefined,
          verifiedName: String(formData.get('wabaVerifiedName') ?? '').trim() || undefined,
        }
      : undefined;

  let hospitalId: string;
  try {
    const result = await createHospital({
      name,
      ownerName,
      ownerEmail,
      ownerPassword,
      ownerPhoneE164,
      branchName,
      branchAddress,
      planTierCode,
      billingCycle,
      initialDoctorName,
      initialDoctorSpecialty,
      initialDoctorMode,
      phoneNumberId,
      waba,
      actorUserId: actor.userId,
    });
    hospitalId = result.hospitalId;
  } catch (error) {
    if (error instanceof StaffAccountError) {
      redirect(`/admin/onboard?error=${error.code}`);
    }
    if (error instanceof WabaBindingError) {
      // The hospital exists by this point; only the binding failed. Naming the
      // reason matters because every one of these is a typo in a pasted key.
      redirect(`/admin/onboard?error=${encodeURIComponent(error.code)}`);
    }
    console.error('[admin:createHospitalAction]', error);
    redirect('/admin/onboard?error=CREATION_FAILED');
  }

  revalidatePath('/admin/hospitals');
  // Straight to the new account rather than back to an empty form: the next
  // thing anyone does after onboarding is check what was actually created.
  redirect(`/admin/hospitals/${hospitalId}?done=onboarded`);
}

/* -------------------------------------------------------- impersonation */

/**
 * Ends a support session and puts the operator back in their own hospital.
 *
 * Deliberately not gated on `requirePlatformAdmin`: that helper refuses
 * impersonated sessions on purpose, and this is the one action such a session
 * must be able to reach. The authority check is the session row itself — only
 * a session marked as an impersonation can be ended by it.
 */
export async function stopImpersonationAction() {
  const token = await readSessionCookie();
  if (!token) redirect('/login');

  try {
    const { token: next } = await endImpersonation(token);
    await setSessionCookie(next);
  } catch (error) {
    if (error instanceof ImpersonationError) {
      // Nothing to return to, or not an impersonation at all. Signing out is
      // the only honest outcome; leaving a half-valid cookie in place is not.
      await clearSessionCookie();
      redirect('/login');
    }
    throw error;
  }

  redirect('/admin/hospitals');
}
