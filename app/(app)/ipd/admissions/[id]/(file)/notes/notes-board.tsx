'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { GENERAL_SIGNS, SYSTEMS, generalExamText, vitalsText, type GeneralSign, type NoteKind, type NoteVitals, type SystemKey } from '@/lib/domain/notes';
import { countersignNoteDynamic, strikeOutNoteDynamic, writeNoteDynamic, type NoteResult } from './actions';

/**
 * The doctor's notes on one patient (IPD sheets plan C3): the case sheet in
 * the paper's sections, then progress notes, newest first. The O/E vitals
 * start from a chart reading under 2 hours old; changing them puts the new
 * values on the chart when the note is saved.
 */

export type NoteCardView = {
  id: string;
  kind: NoteKind;
  seenAt: string;
  caseOf: string | null;
  complaints: { text: string; duration: string | null }[];
  history: string | null;
  pastHistory: string | null;
  generalExam: Record<string, string>;
  vitals: NoteVitals;
  systemicExam: Record<string, string>;
  progress: string | null;
  advice: string | null;
  doctorName: string;
  doctorUserId: string | null;
  writtenBy: string | null;
  writtenByUserId: string | null;
  transcribed: boolean;
  countersignedAt: string | null;
  countersignedBy: string | null;
  chartLinked: boolean;
  voided: boolean;
  voidReason: string | null;
};

const field = 'mt-1 block w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300';

const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function NotesBoard(props: {
  admissionId: string;
  timezone: string;
  notes: NoteCardView[];
  recent: { observedAt: string; vitals: NoteVitals } | null;
  hasAdmissionNote: boolean;
  doctors: { id: string; name: string; userId: string | null }[];
  defaultDoctorId: string | null;
  canWrite: boolean;
  transcribing: boolean;
  canCountersign: boolean;
  myUserId: string;
  isOwner: boolean;
}) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const act = (work: () => Promise<NoteResult>, after?: () => void) =>
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
    new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: props.timezone }).format(new Date(iso));

  const live = props.notes.filter((n) => !n.voided);
  const struck = props.notes.filter((n) => n.voided);

  return (
    <div className="space-y-4">
      {props.canWrite ? <NoteForm {...props} act={act} pending={pending} /> : null}
      <Card>
        <CardHeader title="Notes" hint={live.length === 0 ? 'None yet' : `${live.length} note${live.length === 1 ? '' : 's'}`} />
        {live.length === 0 ? (
          <EmptyState title="No notes yet" hint={props.canWrite ? 'Write the case sheet above.' : 'The doctor writes the case sheet and daily notes here.'} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {live.map((note) => (
              <NoteCard key={note.id} note={note} {...props} act={act} pending={pending} time={time} />
            ))}
          </ul>
        )}
      </Card>
      {struck.length > 0 ? (
        <details className="rounded-xl bg-white ring-1 ring-ink-200">
          <summary className="flex min-h-12 cursor-pointer items-center px-4 text-sm font-semibold text-ink-600 sm:px-5">Struck out ({struck.length})</summary>
          <ul className="divide-y divide-ink-100 opacity-70">
            {struck.map((note) => (
              <NoteCard key={note.id} note={note} {...props} canWrite={false} canCountersign={false} act={act} pending={pending} time={time} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

type Act = (work: () => Promise<NoteResult>, after?: () => void) => void;

function NoteForm(props: {
  admissionId: string;
  recent: { observedAt: string; vitals: NoteVitals } | null;
  hasAdmissionNote: boolean;
  doctors: { id: string; name: string; userId: string | null }[];
  defaultDoctorId: string | null;
  transcribing: boolean;
  timezone: string;
  act: Act;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<NoteKind>(props.hasAdmissionNote ? 'progress' : 'admission');
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [doctorId, setDoctorId] = useState(props.defaultDoctorId ?? '');
  const [complaints, setComplaints] = useState([{ text: '', duration: '' }]);
  const [systems, setSystems] = useState<Record<SystemKey, string>>({ cns: '', rs: '', pa: '', cvs: '' });
  const r = props.recent?.vitals;
  const [vitals, setVitals] = useState({
    pulse: r?.pulse?.toString() ?? '',
    bp: r?.bpSystolic !== undefined ? `${r.bpSystolic}/${r.bpDiastolic}` : '',
    temp: r?.tempFTenths !== undefined ? (r.tempFTenths / 10).toFixed(1) : '',
    spo2: r?.spo2?.toString() ?? '',
    rr: r?.respRate?.toString() ?? '',
  });

  if (!open) {
    return (
      <Button type="button" variant="primary" className="h-11" onClick={() => setOpen(true)}>
        {props.hasAdmissionNote ? 'Write a progress note' : 'Write the case sheet'}
        {props.transcribing ? ' (for the doctor)' : ''}
      </Button>
    );
  }

  const admission = kind === 'admission';
  return (
    <Card>
      <CardHeader
        title={admission ? 'Case sheet (admission note)' : 'Progress note'}
        hint={props.transcribing ? 'Written for the doctor: it waits for their countersign.' : 'Signed by you when you are the doctor named.'}
        action={
          <button type="button" className="min-h-11 px-2 text-sm text-ink-500 hover:text-ink-800" onClick={() => setOpen(false)}>
            Close
          </button>
        }
      />
      <form
        className="space-y-4 px-4 pb-4 sm:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const g: Record<string, string> = { other: String(form.get('other') ?? '') };
          for (const key of Object.keys(GENERAL_SIGNS)) g[key] = String(form.get(`sign_${key}`) ?? '');
          props.act(
            () =>
              writeNoteDynamic({
                admissionId: props.admissionId,
                clientId,
                seenByDoctorId: doctorId,
                note: {
                  kind,
                  seenAt: new Date(String(form.get('seenAt'))).toISOString(),
                  caseOf: form.get('caseOf'),
                  complaints,
                  history: form.get('history'),
                  pastHistory: form.get('pastHistory'),
                  generalExam: g,
                  vitals,
                  systemicExam: systems,
                  progress: form.get('progress'),
                  advice: form.get('advice'),
                },
              }),
            () => {
              setClientId(crypto.randomUUID());
              setOpen(false);
            },
          );
        }}
      >
        {!props.hasAdmissionNote ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Kind of note">
            {(['admission', 'progress'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn('min-h-11 rounded-lg px-3 text-sm font-semibold', kind === k ? 'bg-brand-600 text-white' : 'bg-ink-100 text-ink-700')}
              >
                {k === 'admission' ? 'Case sheet' : 'Progress note'}
              </button>
            ))}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-ink-700">
            Seen at
            <input type="datetime-local" name="seenAt" defaultValue={localInput(new Date())} required className={cn(field, 'h-11')} />
          </label>
          <label className="block text-sm font-medium text-ink-700">
            Seen by
            <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} required className={cn(field, 'h-11')}>
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
        </div>

        {admission ? (
          <>
            <label className="block text-sm font-medium text-ink-700">
              Case of
              <input name="caseOf" maxLength={300} placeholder="e.g. Acute gastroenteritis with dehydration" className={cn(field, 'h-11')} />
            </label>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink-700">C/O (complaints)</legend>
              {complaints.map((c, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={c.text}
                    onChange={(e) => setComplaints(complaints.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                    maxLength={120}
                    placeholder="Complaint, e.g. Fever"
                    aria-label={`Complaint ${i + 1}`}
                    className={cn(field, 'mt-0 h-11 min-w-0 flex-1')}
                  />
                  <input
                    value={c.duration}
                    onChange={(e) => setComplaints(complaints.map((x, j) => (j === i ? { ...x, duration: e.target.value } : x)))}
                    maxLength={40}
                    placeholder="Since"
                    aria-label={`Complaint ${i + 1}: since`}
                    className={cn(field, 'mt-0 h-11 w-28')}
                  />
                </div>
              ))}
              {complaints.length < 20 ? (
                <button type="button" className="min-h-11 text-sm font-semibold text-brand-700" onClick={() => setComplaints([...complaints, { text: '', duration: '' }])}>
                  + Another complaint
                </button>
              ) : null}
            </fieldset>
            <label className="block text-sm font-medium text-ink-700">
              H/O (history of present illness)
              <textarea name="history" rows={3} maxLength={2000} className={cn(field, 'py-2')} />
            </label>
            <label className="block text-sm font-medium text-ink-700">
              P/H (past history: DM, HTN, TB, surgery…)
              <textarea name="pastHistory" rows={2} maxLength={1000} className={cn(field, 'py-2')} />
            </label>
            <fieldset>
              <legend className="text-sm font-medium text-ink-700">O/E: general examination</legend>
              <div className="mt-1 grid gap-2 sm:grid-cols-3">
                {(Object.keys(GENERAL_SIGNS) as GeneralSign[]).map((key) => (
                  <label key={key} className="flex items-center justify-between gap-2 rounded-lg bg-ink-50 px-3 py-1 text-sm">
                    {GENERAL_SIGNS[key]}
                    <select name={`sign_${key}`} defaultValue="" className="h-11 rounded-lg border-0 bg-white px-2 text-sm ring-1 ring-inset ring-ink-300">
                      <option value="">—</option>
                      <option value="absent">Absent</option>
                      <option value="present">Present</option>
                    </select>
                  </label>
                ))}
              </div>
              <input name="other" maxLength={300} placeholder="Other findings" className={cn(field, 'h-11')} />
            </fieldset>
          </>
        ) : (
          <label className="block text-sm font-medium text-ink-700">
            Progress (how the patient is today)
            <textarea name="progress" rows={3} maxLength={2000} placeholder="e.g. Afebrile since morning, tolerating orally" className={cn(field, 'py-2')} />
          </label>
        )}

        <fieldset>
          <legend className="text-sm font-medium text-ink-700">
            Vitals{' '}
            <span className="font-normal text-ink-500">
              {props.recent
                ? `from the chart at ${new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: props.timezone }).format(new Date(props.recent.observedAt))} — change them and the new values go on the chart`
                : 'no chart reading in the last 2 hours — what you type goes on the chart'}
            </span>
          </legend>
          <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {(
              [
                ['pulse', 'Pulse', '88'],
                ['bp', 'B.P.', '120/80'],
                ['temp', 'Temp', '98.6'],
                ['spo2', 'SpO2', '98'],
                ['rr', 'R.R.', '18'],
              ] as const
            ).map(([key, label, ph]) => (
              <label key={key} className="block text-xs font-medium text-ink-700">
                {label}
                <input
                  value={vitals[key]}
                  onChange={(e) => setVitals({ ...vitals, [key]: e.target.value })}
                  inputMode={key === 'bp' ? 'text' : 'decimal'}
                  placeholder={ph}
                  className={cn(field, 'h-11')}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-ink-700">S/E (systemic examination)</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {(Object.keys(SYSTEMS) as SystemKey[]).map((key) => (
              <div key={key} className="text-xs font-medium text-ink-700">
                <div className="flex items-center justify-between">
                  <span id={`se-${key}`}>{SYSTEMS[key]}</span>
                  <button
                    type="button"
                    aria-label={`${SYSTEMS[key]}: no abnormality detected`}
                    className="min-h-8 px-2 font-semibold text-brand-700"
                    onClick={() => setSystems((current) => ({ ...current, [key]: 'NAD' }))}
                  >
                    NAD
                  </button>
                </div>
                <input
                  aria-labelledby={`se-${key}`}
                  value={systems[key]}
                  onChange={(e) => setSystems((current) => ({ ...current, [key]: e.target.value }))}
                  maxLength={500}
                  className={cn(field, 'h-11')}
                />
              </div>
            ))}
          </div>
        </fieldset>

        <label className="block text-sm font-medium text-ink-700">
          Adv (plan and advice)
          <textarea name="advice" rows={3} maxLength={2000} className={cn(field, 'py-2')} />
        </label>
        <Button type="submit" variant="primary" className="h-11" isLoading={props.pending} disabled={!doctorId}>
          Save note
        </Button>
      </form>
    </Card>
  );
}

function NoteCard(props: {
  note: NoteCardView;
  admissionId: string;
  canWrite: boolean;
  canCountersign: boolean;
  myUserId: string;
  isOwner: boolean;
  act: Act;
  pending: boolean;
  time: (iso: string) => string;
}) {
  const n = props.note;
  const awaiting = n.transcribed && !n.countersignedAt && !n.voided;
  const general = generalExamText(n.generalExam as never);
  const vitals = vitalsText(n.vitals);
  const systems = (Object.keys(SYSTEMS) as SystemKey[]).filter((k) => n.systemicExam[k]);
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className={cn('text-base font-bold text-ink-900', n.voided && 'line-through')}>{n.kind === 'admission' ? 'Case sheet' : 'Progress note'}</p>
          <p className="text-xs text-ink-500">
            Seen {props.time(n.seenAt)} by {n.doctorName}
            {n.transcribed ? ` · written by ${n.writtenBy ?? 'staff'}` : ''}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-semibold',
            awaiting ? 'bg-amber-100 text-amber-900' : n.voided ? 'bg-ink-100 text-ink-600' : 'bg-emerald-50 text-emerald-800',
          )}
        >
          {n.voided ? 'Struck out' : awaiting ? 'Awaiting countersign' : n.transcribed ? `Countersigned by ${n.countersignedBy ?? 'the doctor'}` : 'Signed'}
        </span>
      </div>
      <dl className="space-y-2">
        {n.caseOf ? <Row label="Case of">{n.caseOf}</Row> : null}
        {n.complaints.length > 0 ? (
          <Row label="C/O">
            {n.complaints.map((c, i) => (
              <span key={i} className="block">
                {c.text}
                {c.duration ? ` × ${c.duration}` : ''}
              </span>
            ))}
          </Row>
        ) : null}
        {n.history ? <Row label="H/O">{n.history}</Row> : null}
        {n.pastHistory ? <Row label="P/H">{n.pastHistory}</Row> : null}
        {n.progress ? <Row label="Progress">{n.progress}</Row> : null}
        {general || vitals ? (
          <Row label="O/E">
            {[general, vitals].filter(Boolean).join(' · ')}
            {n.chartLinked ? <span className="text-xs text-ink-500"> (on the chart)</span> : null}
          </Row>
        ) : null}
        {systems.length > 0 ? (
          <Row label="S/E">
            {systems.map((k) => (
              <span key={k} className="block">
                {SYSTEMS[k]}: {n.systemicExam[k]}
              </span>
            ))}
          </Row>
        ) : null}
        {n.advice ? <Row label="Adv">{n.advice}</Row> : null}
      </dl>
      {n.voided ? <p className="text-xs text-ink-600">Struck out: {n.voidReason}</p> : null}
      {!n.voided ? (
        <div className="flex flex-wrap gap-2">
          {awaiting && props.canCountersign && n.doctorUserId === props.myUserId ? (
            <Button type="button" variant="primary" className="h-11" isLoading={props.pending} onClick={() => props.act(() => countersignNoteDynamic({ admissionId: props.admissionId, noteId: n.id }))}>
              Countersign
            </Button>
          ) : null}
          {props.canWrite && (props.isOwner || n.writtenByUserId === props.myUserId) ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={() => {
                const reason = window.prompt('Why strike out this note? (written in error)');
                if (reason) props.act(() => strikeOutNoteDynamic({ admissionId: props.admissionId, noteId: n.id, reason }));
              }}
            >
              Strike out
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-3 sm:grid-cols-[6rem_1fr]">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="whitespace-pre-line text-sm text-ink-900">{children}</dd>
    </div>
  );
}
