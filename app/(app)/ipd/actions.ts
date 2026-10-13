'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { parseDepositRupees, parsePayerInput } from '@/lib/domain/payer';
import { can, type Permission } from '@/lib/domain/permissions';
import { normalizeStaffPhone } from '@/lib/domain/phone';
import {
  AdmissionError,
  assignBed,
  cancelAdmission,
  createDirectAdmission,
  setDischargeReady,
  transferBed,
  type AdmissionExtras,
} from '@/lib/services/admissions';
import { CareEntryError, undoCareEntry, voidCareEntry } from '@/lib/services/care-entries';
import {
  UndoError,
  undoAssignBed,
  undoCancelAdmission,
  undoDirectAdmission,
  undoTransfer,
  undoVoidCareEntry,
} from '@/lib/services/ipd-undo';
import { formatUndoToken, idList, isId, parseUndoToken } from '@/lib/domain/undo';
import { PatientBillingError } from '@/lib/services/patient-billing';
import { DoctorIpdError, orderTests } from '@/lib/services/doctor-ipd';
import { withTenant } from '@/lib/db';
import { admissions, doctors, vitalsReadings, intakeOutput, clinicalAuditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  recordAllergyAssessment,
  saveRoundDraft,
  type AllergenItem,
} from '@/lib/services/ipd-rounding-cockpit';
import {
  signRoundOrders,
  adjustMedicationScheduleTimes,
  executeOrderAction,
  AuthorNotLinkedDoctorError,
  type OrderResolution,
} from '@/lib/services/ipd-medication-orders';
import {
  recordAdministration,
  recordException,
  voidAdministration,
  recordNurseUrgentAdministration,
  type RecordAdministrationInput,
  type RecordExceptionInput,
  type RecordNurseUrgentAdminInput,
} from '@/lib/services/ipd-emar';

/**
 * The desk's IPD actions (IPD plan §5.3–5.5, task T1.6). Form posts that
 * redirect with a message, like Settings, so the admission sheet works on a
 * slow connection before any script has loaded.
 */

async function authorize(permission: Permission) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) throw new Error('You cannot do this from your login');
  return session;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '');

const go = (path: string, params: Record<string, string> = {}): never => {
  revalidatePath('/ipd');
  revalidatePath('/dashboard');
  const query = new URLSearchParams(params).toString();
  redirect(`${path}${query ? `?${query}` : ''}`);
};

const isActionError = (err: unknown) => err instanceof AdmissionError || err instanceof PatientBillingError;

/**
 * Reads the optional "Add details" block. The deposit is taken only from a
 * role that may take money; anyone else's deposit field is ignored, not
 * trusted (and the sheet never shows it to them).
 */
function readExtras(form: FormData, canCollect: boolean): AdmissionExtras | { error: string } {
  const payer = parsePayerInput({
    kind: text(form, 'payerKind'),
    payerName: text(form, 'payerName'),
    policyNumber: text(form, 'policyNumber'),
    preauthRupees: text(form, 'preauthRupees'),
  });
  if (!payer.ok) return { error: payer.error };
  const deposit = canCollect ? parseDepositRupees(text(form, 'depositRupees')) : { ok: true as const, value: null };
  if (!deposit.ok) return { error: deposit.error };
  const method = text(form, 'depositMethod');
  return {
    reason: text(form, 'reason'),
    payer: payer.value,
    depositPaise: deposit.value,
    depositMethod: method === 'upi' || method === 'card' || method === 'bank' ? method : 'cash',
  };
}

export async function assignBedAction(form: FormData) {
  const session = await authorize('ipd.admit');
  const admissionId = text(form, 'admissionId');
  const sheet = `/ipd/admissions/${admissionId}/assign`;
  const bedId = text(form, 'bedId');
  if (!bedId) go(sheet, { error: 'Tap a bed first' });

  const extras = readExtras(form, can(session.role, 'billing.collect'));
  if ('error' in extras) go(sheet, { error: extras.error, bed: bedId });
  let depositId: string | null = null;
  try {
    ({ depositId } = await assignBed({
      hospitalId: session.hospitalId,
      admissionId,
      bedId,
      extras: extras as AdmissionExtras,
      actorUserId: session.userId,
    }));
  } catch (err) {
    if (isActionError(err)) go(sheet, { error: (err as Error).message });
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, {
    saved: 'Admitted. The bed is on the ward grid.',
    undo: formatUndoToken('assign', admissionId, depositId),
  });
}

export async function transferBedAction(form: FormData) {
  const session = await authorize('ipd.admit');
  const admissionId = text(form, 'admissionId');
  const page = `/ipd/admissions/${admissionId}/transfer`;
  const bedId = text(form, 'bedId');
  if (!bedId) go(page, { error: 'Tap the new bed first' });
  let previousBedId: string | null = null;
  try {
    ({ previousBedId } = await transferBed({ hospitalId: session.hospitalId, admissionId, bedId, actorUserId: session.userId }));
  } catch (err) {
    if (isActionError(err)) go(page, { error: (err as Error).message });
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, {
    saved: 'Moved to the new bed. Everything recorded stays with the stay.',
    ...(previousBedId ? { undo: formatUndoToken('transfer', admissionId, previousBedId) } : {}),
  });
}

export async function cancelAdmissionAction(form: FormData) {
  const session = await authorize('ipd.admit');
  const admissionId = text(form, 'admissionId');
  try {
    await cancelAdmission({
      hospitalId: session.hospitalId,
      admissionId,
      reason: text(form, 'reason'),
      actorUserId: session.userId,
    });
  } catch (err) {
    if (isActionError(err)) go(`/ipd/admissions/${admissionId}`, { error: (err as Error).message });
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, {
    saved: 'Admission cancelled.',
    undo: formatUndoToken('cancel', admissionId),
  });
}

/** Emergency admission: no OPD token (IPD plan §5.4). */
export async function createDirectAdmissionAction(form: FormData) {
  const session = await authorize('ipd.admit');
  const keep = { phone: text(form, 'phone'), name: text(form, 'name') };
  const back = (error: string): never => go('/ipd/new', { error, ...keep });

  const phoneE164 = normalizeStaffPhone(text(form, 'phone'))?.phoneE164;
  if (!phoneE164) back('Enter a valid 10-digit mobile number, or 0000000000 for no phone');
  const name = text(form, 'name').trim();
  if (!name) back('Enter the patient’s name');
  const rawAge = text(form, 'age').trim();
  const age = rawAge === '' ? null : Number(rawAge);
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 120)) back('Enter the age in years');
  const gender = text(form, 'gender');
  const doctorId = text(form, 'doctorId');
  if (!doctorId) back('Choose the doctor');

  const extras = readExtras(form, can(session.role, 'billing.collect'));
  if ('error' in extras) back(extras.error);

  let admissionId = '';
  let depositId: string | null = null;
  try {
    const result = await createDirectAdmission({
      hospitalId: session.hospitalId,
      branchId: text(form, 'branchId'),
      doctorId,
      patient: {
        phoneE164: phoneE164!,
        name,
        age,
        gender: gender === 'male' || gender === 'female' || gender === 'other' ? gender : null,
        address: text(form, 'address').trim() || null,
      },
      bedId: text(form, 'bedId') || null,
      extras: extras as AdmissionExtras,
      actorUserId: session.userId,
    });
    admissionId = result.admissionId;
    depositId = result.depositId;
  } catch (err) {
    if (isActionError(err)) back((err as Error).message);
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, {
    saved: text(form, 'bedId') ? 'Admitted.' : 'Admitted. Assign a bed when one is free.',
    undo: formatUndoToken('direct', admissionId, depositId),
  });
}

/** The doctor's Discharge ready, and taking it back (also the phone view's button). */
export async function setDischargeReadyAction(form: FormData) {
  const session = await authorize('ipd.dischargeReady');
  const admissionId = text(form, 'admissionId');
  const ready = text(form, 'ready') === 'true';
  const back = text(form, 'back') || `/ipd/admissions/${admissionId}`;
  const safeBack = back.startsWith('/ipd') ? back : `/ipd/admissions/${admissionId}`;
  try {
    await setDischargeReady({ hospitalId: session.hospitalId, admissionId, ready, actorUserId: session.userId });
  } catch (err) {
    if (isActionError(err)) go(safeBack, { error: (err as Error).message });
    throw err;
  }
  go(safeBack, {
    saved: ready ? 'Marked ready to go home. The desk will prepare the bill.' : 'No longer marked ready.',
    undo: formatUndoToken('ready', admissionId, String(ready)),
  });
}

/** The desk's correction of a bedside entry after the undo window, with a reason (D-UN). */
export async function voidCareEntryAction(form: FormData) {
  const session = await authorize('ipd.correct');
  const admissionId = text(form, 'admissionId');
  const entryId = text(form, 'entryId');
  try {
    await voidCareEntry({
      hospitalId: session.hospitalId,
      entryId,
      reason: text(form, 'reason'),
      actorUserId: session.userId,
    });
  } catch (err) {
    if (err instanceof CareEntryError) go(`/ipd/admissions/${admissionId}`, { error: err.message });
    throw err;
  }
  go(`/ipd/admissions/${admissionId}`, {
    saved: 'Entry removed. Its bill line is voided with your reason.',
    undo: formatUndoToken('void-entry', entryId),
  });
}

/** The doctor's Tests button (T3.1): each tapped test becomes an entry, billed like any other. */
export async function orderTestsAction(form: FormData) {
  const session = await authorize('ipd.orderTests');
  const admissionId = text(form, 'admissionId');
  const ids = form.getAll('test').map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  let ordered = 0;
  let firstError = '';
  let entryIds: string[] = [];
  try {
    const results = await orderTests({
      hospitalId: session.hospitalId,
      admissionId,
      chargeItemIds: ids,
      formKey: text(form, 'formKey'),
      actorUserId: session.userId,
      // The person running the hospital may order for any patient.
      seeAll: can(session.role, 'hospital.configure'),
    });
    ordered = results.filter((result) => result.ok).length;
    entryIds = results.flatMap((result) => (result.ok && !result.repeat ? [result.entryId] : []));
    const refused = results.find((result) => !result.ok);
    firstError = refused && !refused.ok ? refused.error : '';
  } catch (err) {
    if (err instanceof DoctorIpdError) go('/ipd/my-patients', { error: err.message });
    throw err;
  }
  go(
    '/ipd/my-patients',
    firstError
      ? { error: firstError }
      : {
          saved: `${ordered} test${ordered === 1 ? '' : 's'} sent.`,
          ...(entryIds.length > 0 ? { undo: formatUndoToken('tests', entryIds.join(',')) } : {}),
        },
  );
}

/* ------------------------------------------------------------------ undo */

/**
 * The Undo button on the IPD screens. Each kind needs the permission its
 * original action needed; the undo service re-checks the window and that
 * nothing has happened to the patient since.
 */
export async function undoIpdAction(form: FormData) {
  const token = parseUndoToken(text(form, 'undo'));
  const back = text(form, '_back').startsWith('/ipd') ? text(form, '_back') : '/ipd';
  if (!token) go(back, { error: 'Nothing to undo.' });
  const { kind, args } = token!;
  const permission: Permission =
    kind === 'ready' ? 'ipd.dischargeReady' : kind === 'tests' ? 'ipd.orderTests' : kind === 'void-entry' ? 'ipd.correct' : 'ipd.admit';
  const session = await authorize(permission);
  const base = { hospitalId: session.hospitalId, actorUserId: session.userId };
  let message = 'Undone.';
  try {
    if (kind === 'assign' && isId(args[0])) {
      await undoAssignBed({ ...base, admissionId: args[0], depositId: isId(args[1]) ? args[1] : null });
      message = 'Undone: the patient is back on Awaiting bed.';
    } else if (kind === 'transfer' && isId(args[0]) && isId(args[1])) {
      await undoTransfer({ ...base, admissionId: args[0], previousBedId: args[1] });
      message = 'Undone: back in the previous bed.';
    } else if (kind === 'direct' && isId(args[0])) {
      await undoDirectAdmission({ ...base, admissionId: args[0], depositId: isId(args[1]) ? args[1] : null });
      go('/ipd', { tab: 'awaiting' });
    } else if (kind === 'cancel' && isId(args[0])) {
      await undoCancelAdmission({ ...base, admissionId: args[0] });
      message = 'Undone: the patient is back on Awaiting bed.';
    } else if (kind === 'ready' && isId(args[0])) {
      await setDischargeReady({ ...base, admissionId: args[0], ready: args[1] !== 'true' });
    } else if (kind === 'void-entry' && isId(args[0])) {
      await undoVoidCareEntry({ ...base, entryId: args[0] });
      message = 'Undone: the entry is back on the record and the bill.';
    } else if (kind === 'tests') {
      for (const entryId of idList(args[0])) await undoCareEntry({ ...base, entryId });
      message = 'Undone: the tests were taken back.';
    } else {
      go(back, { error: 'Nothing to undo.' });
    }
  } catch (err) {
    if (err instanceof UndoError || err instanceof CareEntryError || isActionError(err)) {
      go(back, { error: (err as Error).message });
    }
    throw err;
  }
  go(back, { saved: message });
}

/* ---------------------------------------------------- doctor rounding cockpit */

export async function recordAllergyAssessmentAction(args: {
  admissionId: string;
  status: 'unreviewed' | 'nkda' | 'allergies_documented';
  allergens?: Array<string | AllergenItem>;
  doctorId?: string;
}): Promise<{ ok: boolean; status: string }> {
  const session = await authorize('ipd.prescribe');
  const res = await recordAllergyAssessment({
    hospitalId: session.hospitalId,
    admissionId: args.admissionId,
    status: args.status,
    allergens: args.allergens,
    doctorId: args.doctorId,
    actorUserId: session.userId,
  });
  revalidatePath(`/ipd/admissions/${args.admissionId}`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/rounds`);
  return { ok: true, status: res.status };
}

async function resolveDoctorId(
  hospitalId: string,
  userId: string,
  admissionId: string,
  requestedDoctorId?: string,
): Promise<string> {
  return withTenant(hospitalId, async (tx) => {
    const [linked] = await tx
      .select({ id: doctors.id })
      .from(doctors)
      .where(eq(doctors.userId, userId));

    if (!linked) {
      throw new AuthorNotLinkedDoctorError();
    }

    if (requestedDoctorId && requestedDoctorId !== linked.id) {
      throw new Error('Doctor ID mismatch: cannot sign orders or notes on behalf of another practitioner');
    }

    return linked.id;
  });
}

export async function saveRoundDraftAction(args: {
  admissionId: string;
  notes?: string;
  doctorId?: string;
}): Promise<{ ok: boolean; roundId: string }> {
  const session = await authorize('ipd.prescribe');
  const docId = await resolveDoctorId(session.hospitalId, session.userId, args.admissionId, args.doctorId);

  const res = await saveRoundDraft({
    hospitalId: session.hospitalId,
    admissionId: args.admissionId,
    doctorId: docId,
    authorUserId: session.userId,
    notes: args.notes,
  });

  revalidatePath(`/ipd/admissions/${args.admissionId}/rounds`);
  return { ok: true, roundId: res.roundId };
}

export async function signRoundOrdersAction(args: {
  admissionId: string;
  notes: string;
  resolutions: OrderResolution[];
  doctorId?: string;
}): Promise<{ ok: boolean; roundId: string; signedOrderIds: string[] }> {
  const session = await authorize('ipd.prescribe');
  const docId = await resolveDoctorId(session.hospitalId, session.userId, args.admissionId, args.doctorId);

  const res = await signRoundOrders({
    hospitalId: session.hospitalId,
    admissionId: args.admissionId,
    doctorId: docId,
    authorUserId: session.userId,
    notes: args.notes,
    resolutions: args.resolutions,
  });

  revalidatePath(`/ipd/admissions/${args.admissionId}`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/rounds`);
  revalidatePath('/ipd/my-patients');
  return { ok: true, roundId: res.roundId, signedOrderIds: res.signedOrderIds };
}

export async function recordAdministrationAction(args: {
  admissionId: string;
  orderId: string;
  input: RecordAdministrationInput;
}): Promise<{ ok: boolean; administrationId: string }> {
  const session = await authorize('ipd.administer');

  const res = await recordAdministration({
    hospitalId: session.hospitalId,
    admissionId: args.admissionId,
    orderId: args.orderId,
    input: args.input,
    actorUserId: session.userId,
  });

  revalidatePath(`/ipd/admissions/${args.admissionId}`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/treatment`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/emar`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/rounds`);
  revalidatePath('/ipd');
  return { ok: true, administrationId: res.administrationId };
}

export async function recordExceptionAction(args: {
  admissionId: string;
  orderId: string;
  input: RecordExceptionInput;
}): Promise<{ ok: boolean; administrationId: string }> {
  const session = await authorize('ipd.administer');

  const res = await recordException({
    hospitalId: session.hospitalId,
    admissionId: args.admissionId,
    orderId: args.orderId,
    input: args.input,
    actorUserId: session.userId,
  });

  revalidatePath(`/ipd/admissions/${args.admissionId}`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/treatment`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/emar`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/rounds`);
  revalidatePath('/ipd');
  return { ok: true, administrationId: res.administrationId };
}

export async function voidAdministrationAction(args: {
  admissionId: string;
  administrationId: string;
  reason: string;
}): Promise<{ ok: boolean }> {
  const session = await authorize('ipd.administer');

  await voidAdministration({
    hospitalId: session.hospitalId,
    administrationId: args.administrationId,
    reason: args.reason,
    actorUserId: session.userId,
  });

  revalidatePath(`/ipd/admissions/${args.admissionId}`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/treatment`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/emar`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/rounds`);
  revalidatePath('/ipd');
  return { ok: true };
}

export async function adjustMedicationTimingAction(args: {
  admissionId: string;
  orderId: string;
  newScheduleTimes: string[];
  reason: string;
}): Promise<{ ok: boolean; orderId: string; newScheduleTimes: string[] }> {
  const session = await authorize('ipd.administer');

  const res = await adjustMedicationScheduleTimes({
    hospitalId: session.hospitalId,
    orderId: args.orderId,
    newScheduleTimes: args.newScheduleTimes,
    reason: args.reason,
    actorUserId: session.userId,
  });

  revalidatePath(`/ipd/patients/${args.admissionId}`);
  revalidatePath(`/ipd/patients/${args.admissionId}/orders`);
  revalidatePath(`/ipd/patients/${args.admissionId}/emar`);
  revalidatePath(`/ipd/admissions/${args.admissionId}`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/treatment`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/emar`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/rounds`);
  revalidatePath('/ipd');
  return { ok: true, orderId: res.orderId, newScheduleTimes: res.newScheduleTimes };
}

export async function recordNurseUrgentAdministrationAction(args: {
  admissionId: string;
  input: RecordNurseUrgentAdminInput;
}): Promise<{ ok: boolean; orderId: string; administrationId: string }> {
  const session = await authorize('ipd.administer');

  const res = await recordNurseUrgentAdministration({
    hospitalId: session.hospitalId,
    admissionId: args.admissionId,
    input: args.input,
    actorUserId: session.userId,
  });

  revalidatePath(`/ipd/admissions/${args.admissionId}`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/treatment`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/emar`);
  revalidatePath(`/ipd/admissions/${args.admissionId}/rounds`);
  revalidatePath('/ipd');
  return { ok: true, orderId: res.orderId, administrationId: res.administrationId };
}

export async function stopMedicationOrderAction(args: {
  admissionId: string;
  orderId: string;
  reason: string;
}): Promise<{ ok: boolean }> {
  const session = await authorize('ipd.prescribe');
  const docId = await resolveDoctorId(session.hospitalId, session.userId, args.admissionId);
  await executeOrderAction({
    hospitalId: session.hospitalId,
    orderId: args.orderId,
    action: 'discontinue',
    reason: args.reason,
    actorUserId: session.userId,
    doctorId: docId,
  });
  revalidatePath(`/ipd/patients/${args.admissionId}/orders`);
  return { ok: true };
}

export async function toggleDischargeReadyClientAction(args: {
  admissionId: string;
  ready: boolean;
}): Promise<{ ok: boolean; ready: boolean }> {
  const session = await authorize('ipd.dischargeReady');
  await setDischargeReady({
    hospitalId: session.hospitalId,
    admissionId: args.admissionId,
    ready: args.ready,
    actorUserId: session.userId,
  });
  revalidatePath(`/ipd/patients/${args.admissionId}/discharge`);
  revalidatePath(`/ipd/patients/${args.admissionId}`);
  return { ok: true, ready: args.ready };
}

export async function recordVitalReadingAction(args: {
  admissionId: string;
  temperatureF?: number | string | null;
  pulseBpm?: number | null;
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  respiratoryRate?: number | null;
  spo2Percent?: number | null;
  painScore?: number | null;
  avpu?: 'A' | 'V' | 'P' | 'U';
  o2Support?: string | null;
  news2Score?: number | null;
  bsl?: number | null;
  scheduledSlot?: string | null;
}): Promise<{ ok: boolean; id: string }> {
  const session = await authorize('ipd.view');
  const tempStr = args.temperatureF != null ? String(args.temperatureF) : null;
  const res = await withTenant(
    session.hospitalId,
    async (tx) => {
      const [inserted] = await tx
        .insert(vitalsReadings)
        .values({
          hospitalId: session.hospitalId,
          admissionId: args.admissionId,
          temperatureF: tempStr,
          pulseBpm: args.pulseBpm ?? null,
          bpSystolic: args.bpSystolic ?? null,
          bpDiastolic: args.bpDiastolic ?? null,
          respiratoryRate: args.respiratoryRate ?? null,
          spo2Percent: args.spo2Percent ?? null,
          painScore: args.painScore ?? null,
          avpu: args.avpu ?? null,
          o2Support: args.o2Support ?? null,
          news2Score: args.news2Score ?? null,
          bsl: args.bsl ?? null,
          scheduledSlot: args.scheduledSlot ?? null,
          recordedByUserId: session.userId,
        })
        .returning({ id: vitalsReadings.id });
      return inserted;
    },
    { clinical: true },
  );
  revalidatePath(`/ipd/patients/${args.admissionId}/vitals`);
  revalidatePath(`/ipd/patients/${args.admissionId}/summary`);
  return { ok: true, id: res.id };
}

export async function recordIntakeOutputAction(args: {
  admissionId: string;
  kind: 'ORAL' | 'IV' | 'URINE' | 'DRAIN' | 'RT_ASPIRATE';
  ml: number;
  notes?: string | null;
}): Promise<{ ok: boolean; id: string }> {
  const session = await authorize('ipd.view');
  const res = await withTenant(
    session.hospitalId,
    async (tx) => {
      const [inserted] = await tx
        .insert(intakeOutput)
        .values({
          hospitalId: session.hospitalId,
          admissionId: args.admissionId,
          kind: args.kind,
          ml: args.ml,
          notes: args.notes ?? null,
          recordedByUserId: session.userId,
        })
        .returning({ id: intakeOutput.id });
      return inserted;
    },
    { clinical: true },
  );
  revalidatePath(`/ipd/patients/${args.admissionId}/vitals`);
  revalidatePath(`/ipd/patients/${args.admissionId}/summary`);
  return { ok: true, id: res.id };
}

export async function recordClinicalNoteAction(args: {
  admissionId: string;
  noteType: 'SOAP' | 'NURSING' | 'HANDOVER';
  soapS?: string | null;
  soapO?: string | null;
  soapA?: string | null;
  soapP?: string | null;
  body?: string | null;
}): Promise<{ ok: boolean; id: string }> {
  const session = await authorize('ipd.view');
  const res = await withTenant(
    session.hospitalId,
    async (tx) => {
      const [inserted] = await tx
        .insert(clinicalAuditLogs)
        .values({
          hospitalId: session.hospitalId,
          tableName: 'clinical_notes',
          recordId: args.admissionId,
          action: 'NOTE_RECORDED',
          newValue: {
            noteType: args.noteType,
            soapS: args.soapS ?? null,
            soapO: args.soapO ?? null,
            soapA: args.soapA ?? null,
            soapP: args.soapP ?? null,
            body: args.body ?? null,
          },
          reason: args.noteType,
          userId: session.userId,
        })
        .returning({ id: clinicalAuditLogs.id });
      return inserted;
    },
    { clinical: true },
  );
  revalidatePath(`/ipd/patients/${args.admissionId}/notes`);
  return { ok: true, id: res.id };
}


