import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { ADMISSION_DECISIONS, DISCHARGE_DECISIONS, MED_REC_SOURCES, type MedRecDecision, type MedRecPhase } from '@/lib/domain/medrec';
import { can } from '@/lib/domain/permissions';
import { moduleAllows } from '@/lib/modules/registry';
import { getMedRec, type MedRecItemView, type MedRecView } from '@/lib/services/medrec';
import { loadAdmission } from '../data';
import { addMedRecItemAction, decideMedRecItemAction, prepareDischargeAction, signMedRecAction, strikeOutMedRecItemAction } from './actions';

export const metadata = { title: 'Home medicines · IPD' };

const field = 'mt-1 block h-11 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300';

/**
 * Medication reconciliation (IPD sheets plan B2, NABH): what the patient was
 * taking at home and the doctor's decision on each; at discharge, what goes
 * home. The discharge list prints on the discharge summary.
 */
export default async function MedicinesPage({ params, searchParams }: PageProps<'/ipd/admissions/[id]/medicines'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'med_reconciliation');
  const { id } = await params;
  const query = await searchParams;
  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();
  const view = await getMedRec(session.hospitalId, id);
  const open = admission.status !== 'discharged' && admission.status !== 'cancelled' && !session.readOnly && moduleAllows(states, 'med_reconciliation', 'write');
  const canRecord = open && can(session.role, 'ipd.medrecRecord');
  const canDecide = open && can(session.role, 'ipd.medrecDecide');
  const date = (at: Date) =>
    new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: session.timezone }).format(at);

  return (
    <div className="space-y-4">
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <Section
        phase="admission"
        title="At admission: medicines taken at home"
        hint="Ask the patient or family; look at old prescriptions. The doctor decides each: continue, hold, stop or change."
        part={view.admission}
        admissionId={id}
        canRecord={canRecord}
        canDecide={canDecide}
        date={date}
      />

      <Section
        phase="discharge"
        title="At discharge: medicines to take at home"
        hint="Start from the treatment card and the home medicines, then decide each. This list prints on the discharge summary."
        part={view.discharge}
        admissionId={id}
        canRecord={canRecord}
        canDecide={canDecide}
        date={date}
        cardLinesNotListed={view.cardLinesNotListed.length}
      />
    </div>
  );
}

function Section(props: {
  phase: MedRecPhase;
  title: string;
  hint: string;
  part: MedRecView['admission'] | MedRecView['discharge'];
  admissionId: string;
  canRecord: boolean;
  canDecide: boolean;
  date: (at: Date) => string;
  cardLinesNotListed?: number;
}) {
  const { part, phase } = props;
  const decisions: Record<string, string> = phase === 'admission' ? ADMISSION_DECISIONS : DISCHARGE_DECISIONS;
  return (
    <Card>
      <div id={phase} className="scroll-mt-24" />
      <CardHeader
        title={props.title}
        hint={
          part.signoff
            ? `Completed by ${part.signoff.doctorName} · ${props.date(part.signoff.signedAt)}${part.signoff.noneAtHome ? ' · takes nothing at home' : ''}`
            : part.progress.total > 0
              ? `${part.progress.decided} of ${part.progress.total} decided · not completed yet`
              : props.hint
        }
      />
      {phase === 'discharge' && props.canRecord && (props.cardLinesNotListed ?? 0) > 0 ? (
        <form action={prepareDischargeAction} className="px-4 pb-3 sm:px-5">
          <input type="hidden" name="admissionId" value={props.admissionId} />
          <Button type="submit" variant="secondary" className="h-11">
            Start from the card ({props.cardLinesNotListed} line{props.cardLinesNotListed === 1 ? '' : 's'} not listed yet)
          </Button>
        </form>
      ) : null}
      {part.items.length === 0 ? (
        <EmptyState title="Nothing listed" />
      ) : (
        <ul className="divide-y divide-ink-100">
          {part.items.map((item) => (
            <ItemRow key={item.id} {...props} item={item} phase={phase} decisions={decisions} />
          ))}
        </ul>
      )}
      {props.canRecord ? (
        <details className="border-t border-ink-100">
          <summary className="flex min-h-12 cursor-pointer items-center px-4 text-sm font-semibold text-brand-700 sm:px-5">
            {phase === 'admission' ? '+ Add a home medicine' : '+ Add a new medicine for home'}
          </summary>
          <form action={addMedRecItemAction} className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5">
            <input type="hidden" name="admissionId" value={props.admissionId} />
            <input type="hidden" name="phase" value={phase} />
            <input type="hidden" name="clientId" value={crypto.randomUUID()} />
            <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
              Medicine
              <input name="name" required minLength={2} maxLength={120} placeholder="As on the strip, e.g. Tab Metformin 500 mg" className={field} />
            </label>
            <label className="block text-sm font-medium text-ink-700">
              Dose
              <input name="dose" maxLength={40} placeholder="1 tab" className={field} />
            </label>
            <label className="block text-sm font-medium text-ink-700">
              How often
              <input name="frequency" maxLength={40} placeholder="BD after food" className={field} />
            </label>
            {phase === 'admission' ? (
              <label className="block text-sm font-medium text-ink-700">
                From
                <select name="source" defaultValue="patient" className={field}>
                  {(['patient', 'family', 'prescription', 'records'] as const).map((s) => (
                    <option key={s} value={s}>
                      {MED_REC_SOURCES[s]}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="block text-sm font-medium text-ink-700">
                For how long
                <input name="duration" maxLength={40} placeholder="5 days / continue" className={field} />
              </label>
            )}
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" className="h-11">
                Add
              </Button>
            </div>
          </form>
        </details>
      ) : null}
      {props.canDecide ? (
        <form action={signMedRecAction} className="flex flex-wrap items-center gap-3 border-t border-ink-100 px-4 py-3 sm:px-5">
          <input type="hidden" name="admissionId" value={props.admissionId} />
          <input type="hidden" name="phase" value={phase} />
          {phase === 'admission' && part.items.length === 0 ? (
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-ink-800">
              <input type="checkbox" name="noneAtHome" className="size-5" /> Takes nothing at home
            </label>
          ) : null}
          <Button type="submit" variant={part.progress.complete && !part.signoff ? 'primary' : 'secondary'} className="h-11">
            {part.signoff ? 'Complete again (list changed)' : phase === 'admission' ? 'Complete admission reconciliation' : 'Complete discharge medicines'}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function ItemRow(props: {
  item: MedRecItemView;
  phase: MedRecPhase;
  decisions: Record<string, string>;
  admissionId: string;
  canRecord: boolean;
  canDecide: boolean;
}) {
  const { item } = props;
  const tone = (d: MedRecDecision | null) =>
    d === null ? 'bg-amber-100 text-amber-900' : d === 'stop' ? 'bg-ink-200 text-ink-700' : d === 'hold' ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800';
  const choices = Object.entries(props.decisions).filter(([value]) => value !== 'new' || item.source === 'new');
  return (
    <li className="space-y-2 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink-900">{item.name}</p>
          <p className="text-sm text-ink-700">
            {[item.dose, item.frequency, item.route, item.duration].filter(Boolean).join(' · ') || '—'}
            {item.source ? <span className="text-ink-500"> · {MED_REC_SOURCES[item.source]}</span> : null}
          </p>
        </div>
        <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', tone(item.decision))}>
          {item.decision ? props.decisions[item.decision] : 'To decide'}
        </span>
      </div>
      {item.decisionNote ? (
        <p className="text-sm text-ink-700">
          “{item.decisionNote}”{item.decidedBy ? <span className="text-ink-500"> — {item.decidedBy}</span> : null}
        </p>
      ) : item.decidedBy ? (
        <p className="text-xs text-ink-500">Decided by {item.decidedBy}</p>
      ) : null}
      {props.canDecide && item.source !== 'new' ? (
        <form action={decideMedRecItemAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="admissionId" value={props.admissionId} />
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="phase" value={props.phase} />
          <select name="decision" defaultValue={item.decision ?? ''} required aria-label="Decision" className={cn(field, 'mt-0 w-44')}>
            <option value="" disabled>
              Decide…
            </option>
            {choices.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input name="note" maxLength={200} defaultValue={item.decisionNote ?? ''} placeholder="Why / what changes (needed for change, hold, stop)" className={cn(field, 'mt-0 min-w-0 flex-1')} />
          <Button type="submit" variant="secondary" size="sm" className="h-11">
            Save
          </Button>
        </form>
      ) : null}
      {props.canRecord ? (
        <details className="text-xs">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-ink-500 hover:text-ink-800">Strike out</summary>
          <form action={strikeOutMedRecItemAction} className="mt-1 flex flex-wrap items-end gap-2">
            <input type="hidden" name="admissionId" value={props.admissionId} />
            <input type="hidden" name="itemId" value={item.id} />
            <input name="reason" required minLength={3} maxLength={200} placeholder="Why (e.g. listed twice)" className={cn(field, 'mt-0 min-w-0 flex-1')} />
            <Button type="submit" variant="danger" size="sm" className="h-11">
              Strike out
            </Button>
          </form>
        </details>
      ) : null}
    </li>
  );
}
