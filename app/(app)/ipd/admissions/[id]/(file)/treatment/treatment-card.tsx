'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MedicinePicker } from '@/components/clinical/medicine-picker';
import { BedQrScanner } from '@/components/ipd/bed-qr-scanner';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import {
  CONTROL_FLAGS,
  DOSE_MARK,
  DOSE_STATES,
  FREQUENCY_PRESETS,
  LATE_ENTRY_MS,
  NOT_GIVEN,
  REASONS,
  ROUTES,
  type ControlFlag,
  type DoseState,
  type NotGivenChoice,
  type ReasonCode,
  type Route,
} from '@/lib/domain/mar';
import type { OrderStatus } from '@/lib/domain/mar';
import {
  askWitnessAgainDynamic,
  countersignDynamic,
  createOrderDynamic,
  giveDynamic,
  notGivenDynamic,
  proveAtBedDynamic,
  stopOrderDynamic,
  strikeOutDoseDynamic,
  strikeOutOrderDynamic,
  witnessOnDeviceDynamic,
  type Result,
} from './actions';

/**
 * The treatment card and the day's MAR for one patient (IPD sheets plan
 * B3-min). Each line of the card with today's doses under it, in the marks
 * nurses already use (✓ given, H held, R refused, ✗ not given); Give and Not
 * given on each active medicine line; the doctor's countersign, stop and
 * strike out. Risk-class lines show what they need (the bed code from a
 * personal phone, a witness) before the nurse taps Give, and what a dose was
 * missing (flags) after.
 */

export type CardOrderView = {
  id: string;
  kind: 'medicine' | 'instruction';
  description: string;
  dose: string | null;
  route: Route | null;
  frequency: string | null;
  instructions: string | null;
  orderedAt: string;
  doctorName: string;
  doctorUserId: string | null;
  enteredBy: string | null;
  enteredByUserId: string | null;
  transcribed: boolean;
  countersigned: boolean;
  stopReason: string | null;
  status: OrderStatus;
  risk: { className: string; needsWitness: boolean } | null;
  dosesRecorded: number;
};

export type CardDoseView = {
  id: string;
  orderId: string;
  state: DoseState;
  occurredAt: string;
  dose: string | null;
  quantity: number | null;
  reasonCode: ReasonCode | null;
  reasonText: string | null;
  recordedBy: string | null;
  recordedByUserId: string | null;
  witnessStatus: 'not_needed' | 'awaiting' | 'witnessed' | 'skipped';
  witnessedBy: string | null;
  flags: ControlFlag[];
  voided: boolean;
  voidReason: string | null;
  pendingRequest: { method: 'ward_device' | 'approval'; witnessName: string | null } | null;
};

export type DeviceRequestView = { id: string; description: string; dose: string | null; actorUserId: string; actorName: string; occurredAt: string };

type Person = { userId: string; name: string };

const field = 'mt-1 block h-11 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300';

const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function TreatmentCard(props: {
  admissionId: string;
  timezone: string;
  /** Doses can be recorded: today's sheet, patient in a bed, module writable, not read-only. */
  canRecord: boolean;
  canOrder: boolean;
  canTranscribe: boolean;
  canAdminister: boolean;
  canCountersign: boolean;
  isOwner: boolean;
  myUserId: string;
  channel: 'personal' | 'ward_device';
  enforce: boolean;
  doctors: { id: string; name: string; userId: string | null }[];
  defaultDoctorId: string | null;
  canQuickAddMedicine: boolean;
  orders: CardOrderView[];
  doses: CardDoseView[];
  witnessCandidates: Person[];
  deviceRequests: DeviceRequestView[];
  devicePeople: Person[];
}) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (work: () => Promise<Result>, after?: () => void) =>
    startTransition(async () => {
      const res = await work();
      if (!res.ok) toast.error('Not saved', res.error);
      else {
        toast.success(res.message);
        after?.();
        router.refresh();
      }
    });

  const time = (iso: string) =>
    new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: props.timezone }).format(new Date(iso));

  const dosesOf = useMemo(() => {
    const map = new Map<string, CardDoseView[]>();
    for (const d of props.doses) map.set(d.orderId, [...(map.get(d.orderId) ?? []), d]);
    return map;
  }, [props.doses]);

  const live = props.orders.filter((o) => o.status === 'active' || o.status === 'awaiting_countersign');
  const ended = props.orders.filter((o) => o.status === 'stopped' || o.status === 'struck_out');

  return (
    <div className="space-y-4">
      {props.channel === 'ward_device' && props.deviceRequests.length > 0 ? (
        <DeviceWitness admissionId={props.admissionId} requests={props.deviceRequests} people={props.devicePeople} time={time} act={act} pending={pending} />
      ) : null}

      {(props.canOrder || props.canTranscribe) && props.canRecord ? (
        <NewLine
          admissionId={props.admissionId}
          doctors={props.doctors}
          defaultDoctorId={props.defaultDoctorId}
          canQuickAdd={props.canQuickAddMedicine}
          transcribing={!props.canOrder}
          act={act}
          pending={pending}
        />
      ) : null}

      <Card>
        <CardHeader title="Treatment card" hint={live.length === 0 ? 'No active lines' : `${live.length} active line${live.length === 1 ? '' : 's'} · today’s doses under each`} />
        {live.length === 0 ? (
          <EmptyState title="Nothing on the card yet" hint={props.canOrder ? 'Write the first line above.' : 'The doctor writes the treatment here.'} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {live.map((order) => (
              <OrderLine key={order.id} {...props} order={order} doses={dosesOf.get(order.id) ?? []} act={act} pending={pending} time={time} />
            ))}
          </ul>
        )}
      </Card>

      {ended.length > 0 ? (
        <Card>
          <CardHeader title="Stopped and struck out" hint={`${ended.length}`} />
          <ul className="divide-y divide-ink-100">
            {ended.map((order) => (
              <OrderLine key={order.id} {...props} order={order} doses={dosesOf.get(order.id) ?? []} act={act} pending={pending} time={time} />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

type Act = (work: () => Promise<Result>, after?: () => void) => void;

function NewLine(props: {
  admissionId: string;
  doctors: { id: string; name: string; userId: string | null }[];
  defaultDoctorId: string | null;
  canQuickAdd: boolean;
  transcribing: boolean;
  act: Act;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'medicine' | 'instruction'>('medicine');
  const [medicine, setMedicine] = useState<{ id: string; label: string } | null>(null);
  const [dose, setDose] = useState('');
  const [route, setRoute] = useState<Route>('oral');
  const [frequency, setFrequency] = useState('');
  const [instructions, setInstructions] = useState('');
  const [description, setDescription] = useState('');
  const [doctorId, setDoctorId] = useState(props.defaultDoctorId ?? '');
  const [clientId, setClientId] = useState(() => crypto.randomUUID());

  const reset = () => {
    setMedicine(null);
    setDose('');
    setFrequency('');
    setInstructions('');
    setDescription('');
    setClientId(crypto.randomUUID());
  };

  if (!open) {
    return (
      <Button type="button" variant="primary" className="h-11" onClick={() => setOpen(true)}>
        {props.transcribing ? 'Write a telephone / verbal order' : 'Write a line on the card'}
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader
        title={props.transcribing ? 'Telephone or verbal order' : 'New line'}
        hint={props.transcribing ? 'It waits for the named doctor’s countersign.' : 'Signed by you when you are the doctor named.'}
        action={
          <button type="button" className="min-h-11 px-2 text-sm text-ink-500 hover:text-ink-800" onClick={() => setOpen(false)}>
            Close
          </button>
        }
      />
      <form
        className="space-y-3 p-4 sm:p-5"
        onSubmit={(e) => {
          e.preventDefault();
          props.act(
            () =>
              createOrderDynamic({
                admissionId: props.admissionId,
                clientId,
                orderingDoctorId: doctorId,
                kind,
                medicineId: medicine?.id,
                dose,
                route,
                frequency,
                instructions,
                description,
              }),
            reset,
          );
        }}
      >
        <div className="flex gap-2" role="group" aria-label="Kind of line">
          {(['medicine', 'instruction'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn('min-h-11 rounded-lg px-4 text-sm font-medium ring-1 ring-inset', kind === k ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white ring-ink-300')}
            >
              {k === 'medicine' ? 'Medicine' : 'Instruction'}
            </button>
          ))}
        </div>

        {kind === 'medicine' ? (
          <>
            {medicine ? (
              <p className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2 text-sm">
                <strong>{medicine.label}</strong>
                <button type="button" className="min-h-11 px-2 text-ink-500" onClick={() => setMedicine(null)}>
                  Change
                </button>
              </p>
            ) : (
              <MedicinePicker canQuickAdd={props.canQuickAdd} onPick={(m) => setMedicine({ id: m.id, label: m.label })} />
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm font-medium text-ink-700">
                Dose
                <input value={dose} onChange={(e) => setDose(e.target.value)} required maxLength={40} placeholder="e.g. 1 g, 2 mg" className={field} />
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Route
                <select value={route} onChange={(e) => setRoute(e.target.value as Route)} className={field}>
                  {Object.entries(ROUTES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Frequency
                <input value={frequency} onChange={(e) => setFrequency(e.target.value)} required maxLength={30} list="mar-frequencies" placeholder="BD, TDS, q8h…" className={field} />
                <datalist id="mar-frequencies">
                  {FREQUENCY_PRESETS.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </label>
            </div>
            <label className="block text-sm font-medium text-ink-700">
              Instructions (optional)
              <input value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={200} placeholder="e.g. after food, over 30 min" className={field} />
            </label>
          </>
        ) : (
          <label className="block text-sm font-medium text-ink-700">
            Instruction
            <input value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={200} placeholder="e.g. Keep head end raised 30°" className={field} />
          </label>
        )}

        <label className="block text-sm font-medium text-ink-700">
          Ordered by
          <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} required className={field}>
            <option value="" disabled>
              Choose the doctor
            </option>
            {props.doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" className="h-11" isLoading={props.pending} disabled={kind === 'medicine' && !medicine}>
          Add to the card
        </Button>
      </form>
    </Card>
  );
}

function OrderLine(props: {
  order: CardOrderView;
  timezone: string;
  doses: CardDoseView[];
  admissionId: string;
  canRecord: boolean;
  canOrder: boolean;
  canTranscribe: boolean;
  canAdminister: boolean;
  canCountersign: boolean;
  isOwner: boolean;
  myUserId: string;
  channel: 'personal' | 'ward_device';
  enforce: boolean;
  witnessCandidates: Person[];
  act: Act;
  pending: boolean;
  time: (iso: string) => string;
}) {
  const { order } = props;
  const [panel, setPanel] = useState<'give' | 'not' | 'stop' | null>(null);
  const live = order.status === 'active' || order.status === 'awaiting_countersign';
  const mine = order.doctorUserId === props.myUserId;

  return (
    <li className={cn('space-y-2 px-4 py-3 sm:px-5', !live && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cn('text-base font-semibold text-ink-900', order.status === 'struck_out' && 'line-through')}>
            {order.description}
            {order.risk ? (
              <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 align-middle text-xs font-semibold text-red-800">
                {order.risk.className}
                {order.risk.needsWitness ? ' · witness' : ''}
              </span>
            ) : null}
          </p>
          {order.kind === 'medicine' ? (
            <p className="text-sm text-ink-800">
              {order.dose} · {order.route ? ROUTES[order.route] : ''} · {order.frequency}
              {order.instructions ? <span className="text-ink-600"> · {order.instructions}</span> : null}
            </p>
          ) : null}
          <p className="text-xs text-ink-500">
            {order.doctorName}
            {order.transcribed ? ` · written by ${order.enteredBy ?? 'staff'} (telephone/verbal)` : ''} ·{' '}
            {new Date(order.orderedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: props.timezone })}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-semibold',
            order.status === 'awaiting_countersign' ? 'bg-amber-100 text-amber-900' : order.status === 'active' ? 'bg-emerald-50 text-emerald-800' : 'bg-ink-100 text-ink-700',
          )}
        >
          {order.status === 'awaiting_countersign'
            ? 'Awaiting countersign'
            : order.status === 'active'
              ? order.transcribed
                ? 'Countersigned'
                : 'Signed'
              : order.status === 'stopped'
                ? `Stopped: ${order.stopReason}`
                : 'Struck out'}
        </span>
      </div>

      {props.doses.length > 0 ? (
        <ul className="space-y-1">
          {props.doses.map((d) => (
            <DoseRow key={d.id} dose={d} {...props} />
          ))}
        </ul>
      ) : null}

      {props.canRecord ? (
        <div className="flex flex-wrap gap-2">
          {live && order.kind === 'medicine' && props.canAdminister ? (
            <>
              <Button type="button" variant={panel === 'give' ? 'primary' : 'secondary'} className="h-11" onClick={() => setPanel(panel === 'give' ? null : 'give')}>
                Give
              </Button>
              <Button type="button" variant="secondary" className="h-11" onClick={() => setPanel(panel === 'not' ? null : 'not')}>
                Not given
              </Button>
            </>
          ) : null}
          {order.status === 'awaiting_countersign' && props.canCountersign && mine ? (
            <Button type="button" variant="primary" className="h-11" isLoading={props.pending} onClick={() => props.act(() => countersignDynamic({ admissionId: props.admissionId, orderId: order.id }))}>
              Countersign
            </Button>
          ) : null}
          {live && props.canOrder ? (
            <Button type="button" variant="ghost" className="h-11" onClick={() => setPanel(panel === 'stop' ? null : 'stop')}>
              Stop
            </Button>
          ) : null}
          {live && order.dosesRecorded === 0 && (props.isOwner || order.enteredByUserId === props.myUserId) ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={() => {
                const reason = window.prompt('Why strike out this line? (written in error)');
                if (reason !== null) props.act(() => strikeOutOrderDynamic({ admissionId: props.admissionId, orderId: order.id, reason }));
              }}
            >
              Strike out
            </Button>
          ) : null}
        </div>
      ) : null}

      {panel === 'give' ? <GiveForm {...props} onDone={() => setPanel(null)} /> : null}
      {panel === 'not' ? <NotGivenForm {...props} onDone={() => setPanel(null)} /> : null}
      {panel === 'stop' ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
            props.act(() => stopOrderDynamic({ admissionId: props.admissionId, orderId: order.id, reason }), () => setPanel(null));
          }}
        >
          <label className="block min-w-0 flex-1 text-sm font-medium text-ink-700">
            Why stop?
            <input name="reason" required maxLength={200} placeholder="e.g. Course complete, changed to oral" className={field} />
          </label>
          <Button type="submit" variant="primary" className="h-11" isLoading={props.pending}>
            Stop line
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function DoseRow(props: {
  dose: CardDoseView;
  admissionId: string;
  isOwner: boolean;
  myUserId: string;
  channel: 'personal' | 'ward_device';
  canRecord: boolean;
  witnessCandidates: Person[];
  act: Act;
  pending: boolean;
  time: (iso: string) => string;
}) {
  const d = props.dose;
  const [asking, setAsking] = useState(false);
  const mine = d.recordedByUserId === props.myUserId;
  const waiting = !d.voided && (d.witnessStatus === 'awaiting' || d.witnessStatus === 'skipped');
  return (
    <li className={cn('rounded-lg px-3 py-2 text-sm', d.voided ? 'bg-ink-50 text-ink-400' : d.state === 'given' ? 'bg-emerald-50/60' : 'bg-ink-50')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cn(d.voided && 'line-through')}>
          <strong className="tabular-nums">{props.time(d.occurredAt)}</strong> <span aria-hidden>{DOSE_MARK[d.state]}</span> {DOSE_STATES[d.state]}
          {d.dose ? ` · ${d.dose}` : ''}
          {d.reasonCode && d.state !== 'given' ? ` · ${REASONS[d.reasonCode]}` : ''}
          {d.reasonText ? ` — “${d.reasonText}”` : ''}
          <span className="text-ink-500"> · {d.recordedBy ?? 'staff'}</span>
          {d.witnessStatus === 'witnessed' ? <span className="text-emerald-800"> · witnessed by {d.witnessedBy}</span> : null}
          {d.witnessStatus === 'awaiting' && d.pendingRequest ? (
            <span className="font-medium text-amber-800">
              {' '}
              · waiting for witness{d.pendingRequest.witnessName ? ` (${d.pendingRequest.witnessName})` : ' on the tablet'}
            </span>
          ) : null}
        </span>
        {!d.voided && props.canRecord && (mine || props.isOwner) ? (
          <span className="flex gap-1">
            {waiting && mine && !d.pendingRequest ? (
              <button type="button" className="min-h-11 rounded-lg px-2 text-xs font-medium text-brand-700 hover:bg-white" onClick={() => setAsking(!asking)}>
                Ask witness
              </button>
            ) : null}
            <button
              type="button"
              className="min-h-11 rounded-lg px-2 text-xs font-medium text-ink-500 hover:bg-white hover:text-ink-900"
              onClick={() => {
                const reason = window.prompt('Why strike out this dose? (recorded in error)');
                if (reason) props.act(() => strikeOutDoseDynamic({ admissionId: props.admissionId, marId: d.id, reason }));
              }}
            >
              Strike out
            </button>
          </span>
        ) : null}
      </div>
      {d.flags.length > 0 ? (
        <p className="mt-0.5 text-xs font-medium text-amber-800">⚑ {d.flags.map((f) => CONTROL_FLAGS[f]).join(' · ')}</p>
      ) : null}
      {d.voided ? <p className="text-xs">Struck out: {d.voidReason}</p> : null}
      {asking ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const witnessUserId = String(new FormData(e.currentTarget).get('witness') ?? '');
            props.act(() => askWitnessAgainDynamic({ admissionId: props.admissionId, marId: d.id, witnessUserId }), () => setAsking(false));
          }}
        >
          <label className="block min-w-0 flex-1 text-xs text-ink-700">
            Witness
            <select name="witness" defaultValue="" className={field}>
              {props.channel === 'ward_device' ? <option value="">Someone here, on this tablet</option> : <option value="" disabled>Choose</option>}
              {props.witnessCandidates.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" className="h-11" isLoading={props.pending}>
            Ask
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function GiveForm(props: {
  order: CardOrderView;
  admissionId: string;
  channel: 'personal' | 'ward_device';
  enforce: boolean;
  witnessCandidates: Person[];
  act: Act;
  pending: boolean;
  onDone: () => void;
}) {
  const { order } = props;
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [at, setAt] = useState(() => localInput(new Date()));
  const [code, setCode] = useState('');
  const [scanned, setScanned] = useState(false);
  // Measured from when the form was opened: a time typed over 2 hours before then is a late entry.
  const [openedAt] = useState(() => Date.now());
  const late = openedAt - new Date(at).getTime() > LATE_ENTRY_MS;
  const needsCode = Boolean(order.risk) && props.channel === 'personal';
  const needsWitnessPick = Boolean(order.risk?.needsWitness) && props.channel === 'personal';

  return (
    <form
      className="space-y-3 rounded-xl bg-ink-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        props.act(
          async () => {
            if (needsCode && code.trim()) {
              const proved = await proveAtBedDynamic({ admissionId: props.admissionId, code, method: scanned ? 'qr' : 'code' });
              if (!proved.ok) return proved;
            }
            return giveDynamic({
              admissionId: props.admissionId,
              orderId: order.id,
              clientId,
              occurredAt: new Date(at).toISOString(),
              dose: String(form.get('dose') ?? ''),
              quantity: Number(form.get('quantity') ?? 1),
              lateReason: String(form.get('lateReason') ?? ''),
              witnessUserId: String(form.get('witness') ?? ''),
            });
          },
          () => {
            setClientId(crypto.randomUUID());
            props.onDone();
          },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-medium text-ink-700">
          Given at
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required className={field} />
        </label>
        <label className="block text-sm font-medium text-ink-700">
          Dose
          <input name="dose" defaultValue={order.dose ?? ''} maxLength={40} className={field} />
        </label>
        <label className="block text-sm font-medium text-ink-700">
          Units billed
          <input name="quantity" type="number" inputMode="numeric" min={0} max={100} defaultValue={1} className={field} />
        </label>
      </div>
      {late ? (
        <label className="block text-sm font-medium text-ink-700">
          Over 2 hours ago: why is it written late?
          <input name="lateReason" required maxLength={200} className={field} />
        </label>
      ) : null}
      {needsCode ? (
        <label className="block text-sm font-medium text-ink-700">
          Code on the patient’s bed {props.enforce ? '' : '(asked for; recorded if missing)'}
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setScanned(false);
            }}
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={8}
            placeholder="6 letters and numbers"
            className={cn(field, 'font-mono uppercase tracking-widest')}
          />
          <span className="mt-2 block">
            <BedQrScanner
              onCode={(found) => {
                setCode(found);
                setScanned(true);
              }}
            />
          </span>
        </label>
      ) : null}
      {needsWitnessPick ? (
        <label className="block text-sm font-medium text-ink-700">
          Witness (they confirm on their own phone or login)
          <select name="witness" defaultValue="" className={field}>
            <option value="">{props.enforce ? 'Choose' : 'No witness available'}</option>
            {props.witnessCandidates.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : order.risk?.needsWitness ? (
        <p className="text-sm text-amber-800">After saving, hand the tablet to the witness: they confirm with their own PIN.</p>
      ) : null}
      <Button type="submit" variant="primary" className="h-11" isLoading={props.pending}>
        Save: given
      </Button>
    </form>
  );
}

function NotGivenForm(props: { order: CardOrderView; admissionId: string; act: Act; pending: boolean; onDone: () => void }) {
  const [clientId] = useState(() => crypto.randomUUID());
  const [choice, setChoice] = useState<NotGivenChoice>('refused');
  return (
    <form
      className="space-y-3 rounded-xl bg-ink-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        props.act(
          () =>
            notGivenDynamic({
              admissionId: props.admissionId,
              orderId: props.order.id,
              clientId,
              occurredAt: new Date(String(form.get('at'))).toISOString(),
              choice,
              reasonText: String(form.get('reasonText') ?? ''),
            }),
          props.onDone,
        );
      }}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label="Why not given">
        {Object.entries(NOT_GIVEN).map(([value, { label }]) => (
          <button
            key={value}
            type="button"
            aria-pressed={choice === value}
            onClick={() => setChoice(value as NotGivenChoice)}
            className={cn('min-h-11 rounded-lg px-2 text-sm font-medium ring-1 ring-inset', choice === value ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white ring-ink-300')}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-ink-700">
          Due / noted at
          <input type="datetime-local" name="at" defaultValue={localInput(new Date())} required className={field} />
        </label>
        <label className="block text-sm font-medium text-ink-700">
          Note {choice === 'other' ? '(needed)' : '(optional)'}
          <input name="reasonText" maxLength={200} required={choice === 'other'} className={field} />
        </label>
      </div>
      <Button type="submit" variant="primary" className="h-11" isLoading={props.pending}>
        Save: not given
      </Button>
    </form>
  );
}

function DeviceWitness(props: {
  admissionId: string;
  requests: DeviceRequestView[];
  people: Person[];
  time: (iso: string) => string;
  act: Act;
  pending: boolean;
}) {
  return (
    <Card>
      <CardHeader title="Witness needed on this tablet" hint="The witness picks their own name and types their own PIN." />
      <ul className="divide-y divide-ink-100">
        {props.requests.map((r) => (
          <li key={r.id} className="space-y-2 px-4 py-3 sm:px-5">
            <p className="text-sm">
              <strong>{r.description}</strong>
              {r.dose ? ` · ${r.dose}` : ''} · given {props.time(r.occurredAt)} by {r.actorName}
            </p>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                props.act(
                  () =>
                    witnessOnDeviceDynamic({
                      admissionId: props.admissionId,
                      requestId: r.id,
                      witnessUserId: String(data.get('witness') ?? ''),
                      pin: String(data.get('pin') ?? ''),
                    }),
                  () => form.reset(),
                );
              }}
            >
              <label className="block min-w-40 flex-1 text-xs text-ink-700">
                Witness
                <select name="witness" required defaultValue="" className={field}>
                  <option value="" disabled>
                    Choose your name
                  </option>
                  {props.people
                    .filter((p) => p.userId !== r.actorUserId)
                    .map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block w-32 text-xs text-ink-700">
                Your PIN
                <input name="pin" type="password" inputMode="numeric" autoComplete="off" required minLength={4} maxLength={6} className={cn(field, 'tracking-widest')} />
              </label>
              <Button type="submit" variant="primary" className="h-11" isLoading={props.pending}>
                Witness
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </Card>
  );
}
