'use server';

import { revalidatePath } from 'next/cache';
import { ModuleUnavailableError, assertModule, getModuleStatesForRequest } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { readWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { MarError, isNotGivenChoice, parseOrder } from '@/lib/domain/mar';
import { can, type Permission } from '@/lib/domain/permissions';
import {
  askWitnessAgain,
  countersignOrder,
  createOrder,
  proveAtBed,
  recordGive,
  recordNotGiven,
  recordTaskDone,
  stopOrder,
  strikeOutDose,
  strikeOutOrder,
  witnessOnDevice,
  type Actor,
} from '@/lib/services/mar';
import { resolveWardDevice } from '@/lib/services/staff-access';
import { getMarConfig, snoozeDue } from '@/lib/services/due';
import type { DueContext } from '@/lib/services/mar';

/**
 * The treatment card's actions (IPD sheets plan B3-min). Each returns a
 * result for a toast, like the consultation screen. Permission per action,
 * module `mar` (write, and the patient's ward inside its rollout); who may
 * countersign, strike out or witness a particular line is the service's.
 */

export type Result = { ok: true; message: string } | { ok: false; error: string };

const ok = (message: string): Result => ({ ok: true, message });

async function authorize(permission: Permission, admissionId: string) {
  const session = await requireWritableSession();
  if (!can(session.role, permission)) throw new MarError('Your login cannot do this');
  await assertModule(session, 'mar', 'write');
  revalidatePath(`/ipd/admissions/${admissionId}/treatment`);
  return session;
}

const actorOf = (session: Awaited<ReturnType<typeof requireWritableSession>>): Actor => ({
  userId: session.userId,
  channel: session.channel,
  wardDeviceId: session.wardDeviceId,
});

/** The hospital's windows and stage, for a dose recorded against a due time (B3b). */
async function dueContext(session: Awaited<ReturnType<typeof requireWritableSession>>, dueAt: string | undefined, reason: string | undefined): Promise<DueContext> {
  const config = await getMarConfig(session.hospitalId);
  const at = dueAt ? new Date(dueAt) : null;
  return {
    dueAt: at && !Number.isNaN(at.getTime()) ? at : null,
    reason: reason?.trim() || null,
    settings: config.settings,
    tcActive: config.tcActive,
    timezone: session.timezone,
    enforce: config.stage === 'enforce',
  };
}

async function run(fn: () => Promise<Result>): Promise<Result> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MarError || err instanceof ModuleUnavailableError) return { ok: false, error: err.message };
    console.error('[mar] action failed', err);
    return { ok: false, error: 'Could not save. Try again.' };
  }
}

const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

export async function createOrderDynamic(args: {
  admissionId: string;
  clientId: string;
  orderingDoctorId: string;
  kind: string;
  medicineId?: string;
  dose?: string;
  route?: string;
  frequency?: string;
  instructions?: string;
  description?: string;
  taskKind?: string;
  timingMode?: string;
  clockTimes?: string;
  intervalHours?: string;
  firstDueAt?: string;
  latePolicy?: string;
}): Promise<Result> {
  return run(async () => {
    const session = await requireWritableSession();
    const mayOrder = can(session.role, 'ipd.order');
    const mayTranscribe = can(session.role, 'ipd.transcribe');
    if (!mayOrder && !mayTranscribe) throw new MarError('Your login cannot write the treatment card');
    await authorize(mayOrder ? 'ipd.order' : 'ipd.transcribe', args.admissionId);
    if (!isId(args.clientId) || !isId(args.orderingDoctorId)) throw new MarError('Choose the doctor who ordered it');
    const { transcribed } = await createOrder({
      hospitalId: session.hospitalId,
      admissionId: args.admissionId,
      input: parseOrder(args),
      orderingDoctorId: args.orderingDoctorId,
      clientId: args.clientId,
      actor: actorOf(session),
      mayTranscribe,
    });
    return ok(transcribed ? 'Written. It waits for the doctor’s countersign.' : 'Added to the treatment card');
  });
}

export async function countersignDynamic(args: { admissionId: string; orderId: string }): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.countersign', args.admissionId);
    await countersignOrder({ hospitalId: session.hospitalId, orderId: args.orderId, actorUserId: session.userId });
    return ok('Countersigned');
  });
}

export async function stopOrderDynamic(args: { admissionId: string; orderId: string; reason: string }): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.order', args.admissionId);
    await stopOrder({ hospitalId: session.hospitalId, orderId: args.orderId, actorUserId: session.userId, reason: args.reason });
    return ok('Stopped');
  });
}

export async function strikeOutOrderDynamic(args: { admissionId: string; orderId: string; reason: string }): Promise<Result> {
  return run(async () => {
    const session = await requireWritableSession();
    await authorize(can(session.role, 'ipd.order') ? 'ipd.order' : 'ipd.transcribe', args.admissionId);
    await strikeOutOrder({ hospitalId: session.hospitalId, orderId: args.orderId, actorUserId: session.userId, isOwner: session.role === 'owner', reason: args.reason });
    return ok('Struck out');
  });
}

export async function giveDynamic(args: {
  admissionId: string;
  orderId: string;
  clientId: string;
  occurredAt: string;
  dose: string;
  quantity: number;
  lateReason: string;
  witnessUserId: string;
  dueAt?: string;
  timingReason?: string;
}): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.administer', args.admissionId);
    const occurredAt = new Date(args.occurredAt);
    if (!isId(args.clientId) || Number.isNaN(occurredAt.getTime())) throw new MarError('Reload the page and try again');
    const stage = (await getModuleStatesForRequest(session.hospitalId)).get('mar')?.stage ?? 'observe';
    const outcome = await recordGive({
      hospitalId: session.hospitalId,
      orderId: args.orderId,
      occurredAt,
      dose: args.dose || null,
      quantity: Number(args.quantity),
      lateReason: args.lateReason || null,
      witnessUserId: isId(args.witnessUserId) ? args.witnessUserId : null,
      clientId: args.clientId,
      actor: actorOf(session),
      stage,
      due: await dueContext(session, args.dueAt, args.timingReason),
    });
    const witness =
      outcome.witness === 'ward_device'
        ? ' Witness needed: hand the tablet to the witness.'
        : outcome.witness === 'approval'
          ? ' Sent to the witness to confirm.'
          : outcome.witness === 'skipped'
            ? ' Recorded without a witness.'
            : '';
    return ok(`Given.${witness}`);
  });
}

export async function notGivenDynamic(args: {
  admissionId: string;
  orderId: string;
  clientId: string;
  occurredAt: string;
  choice: string;
  reasonText: string;
  dueAt?: string;
}): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.administer', args.admissionId);
    if (!isNotGivenChoice(args.choice)) throw new MarError('Choose why it was not given');
    const occurredAt = new Date(args.occurredAt);
    if (!isId(args.clientId) || Number.isNaN(occurredAt.getTime())) throw new MarError('Reload the page and try again');
    await recordNotGiven({
      hospitalId: session.hospitalId,
      orderId: args.orderId,
      occurredAt,
      choice: args.choice,
      reasonText: args.reasonText || null,
      clientId: args.clientId,
      actor: actorOf(session),
      due: await dueContext(session, args.dueAt, undefined),
    });
    return ok('Noted as not given');
  });
}

export async function strikeOutDoseDynamic(args: { admissionId: string; marId: string; reason: string }): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.administer', args.admissionId);
    await strikeOutDose({ hospitalId: session.hospitalId, marId: args.marId, actorUserId: session.userId, isOwner: session.role === 'owner', reason: args.reason });
    return ok('Dose struck out; its bill line is removed');
  });
}

export async function proveAtBedDynamic(args: { admissionId: string; code: string; method?: 'code' | 'qr' }): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.administer', args.admissionId);
    await proveAtBed({
      hospitalId: session.hospitalId,
      admissionId: args.admissionId,
      code: args.code,
      method: args.method === 'qr' ? 'qr' : 'code',
      actor: actorOf(session),
    });
    return ok('Bed code accepted for 5 minutes');
  });
}

export async function askWitnessAgainDynamic(args: { admissionId: string; marId: string; witnessUserId: string }): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.administer', args.admissionId);
    await askWitnessAgain({
      hospitalId: session.hospitalId,
      marId: args.marId,
      witnessUserId: isId(args.witnessUserId) ? args.witnessUserId : null,
      actor: actorOf(session),
    });
    return ok('Witness asked');
  });
}

/** On the ward tablet: the witness picks their name and types their own PIN (D-WITNESS (a)). */
export async function witnessOnDeviceDynamic(args: { admissionId: string; requestId: string; witnessUserId: string; pin: string }): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.administer', args.admissionId);
    if (session.channel !== 'ward_device') throw new MarError('A witness PIN is entered only on the ward tablet');
    const device = await resolveWardDevice(await readWardDeviceCookie());
    if (!device || device.id !== session.wardDeviceId) throw new MarError('Ward tablet not found');
    if (!isId(args.witnessUserId)) throw new MarError('Choose who is witnessing');
    await witnessOnDevice({
      hospitalId: session.hospitalId,
      requestId: args.requestId,
      device,
      witnessUserId: args.witnessUserId,
      pin: args.pin,
      sessionId: session.sessionId,
    });
    return ok('Witnessed');
  });
}

export async function taskDoneDynamic(args: { admissionId: string; orderId: string; clientId: string; occurredAt: string; note: string; dueAt?: string }): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.administer', args.admissionId);
    const occurredAt = new Date(args.occurredAt);
    if (!isId(args.clientId) || Number.isNaN(occurredAt.getTime())) throw new MarError('Reload the page and try again');
    await recordTaskDone({
      hospitalId: session.hospitalId,
      orderId: args.orderId,
      occurredAt,
      note: args.note || null,
      clientId: args.clientId,
      actor: actorOf(session),
      due: await dueContext(session, args.dueAt, undefined),
    });
    return ok('Marked done');
  });
}

/** Puts off a time-critical alert: a reason, up to 30 minutes, twice per dose (§7.10). */
export async function snoozeDynamic(args: { admissionId: string; orderId: string; dueAt: string; minutes: number; reason: string }): Promise<Result> {
  return run(async () => {
    const session = await authorize('ipd.dueBoard', args.admissionId);
    await snoozeDue({
      hospitalId: session.hospitalId,
      orderId: args.orderId,
      dueAt: new Date(args.dueAt),
      minutes: Number(args.minutes),
      reason: args.reason,
      actorUserId: session.userId,
    });
    return ok(`Alert put off for ${args.minutes} minutes`);
  });
}
