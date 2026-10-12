import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { ALLERGY_CATEGORIES, ALLERGY_SEVERITIES, ALLERGY_SOURCES, DRUG_CLASSES } from '@/lib/domain/allergy';
import { can } from '@/lib/domain/permissions';
import { moduleAllows } from '@/lib/modules/registry';
import { getAllergies } from '@/lib/services/allergy';
import { loadAdmission } from '../data';
import { recordAllergyAction, reviewAllergiesAction, strikeOutAllergyAction } from './actions';

export const metadata = { title: 'Allergies · IPD' };

const field = 'mt-1 block h-11 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300';

/**
 * The Allergies tab (IPD sheets plan B2): what the patient reacts to — kept
 * with the patient for every stay — and whether anyone has asked. Medicine
 * allergies are checked, by name and drug class, when a doctor writes a line
 * on the treatment card.
 */
export default async function AllergiesPage({ params, searchParams }: PageProps<'/ipd/admissions/[id]/allergies'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'allergy');
  const { id } = await params;
  const query = await searchParams;
  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();
  const view = await getAllergies(session.hospitalId, admission.patientId);
  const canWrite = can(session.role, 'ipd.allergy') && !session.readOnly && moduleAllows(states, 'allergy', 'write') && admission.status !== 'cancelled';
  const date = (at: Date) =>
    new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: session.timezone }).format(at);

  return (
    <div className="space-y-4">
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <Card>
        <CardHeader
          title="Allergies"
          hint={
            view.lastReview
              ? `Last asked ${date(view.lastReview.at)}${view.lastReview.by ? ` by ${view.lastReview.by}` : ''}${view.lastReview.note ? ` — “${view.lastReview.note}”` : ''}`
              : 'Not asked yet'
          }
        />
        {view.allergies.length === 0 ? (
          <EmptyState
            title={view.status.kind === 'nkda' ? 'No known drug allergies' : view.status.kind === 'unable' ? 'Could not be asked' : 'None recorded'}
            hint={view.status.kind === 'not_asked' ? 'Ask the patient or family, then record what they say — or that there are none.' : undefined}
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {view.allergies.map((a) => (
              <li key={a.id} className="space-y-1 px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-base font-semibold text-ink-900">
                    {a.substance}
                    <span
                      className={cn(
                        'ml-2 rounded px-1.5 py-0.5 align-middle text-xs font-semibold',
                        a.severity === 'severe' ? 'bg-red-600 text-white' : a.severity === 'moderate' ? 'bg-amber-100 text-amber-900' : 'bg-ink-100 text-ink-700',
                      )}
                    >
                      {ALLERGY_SEVERITIES[a.severity]}
                    </span>
                  </p>
                  <span className="text-xs text-ink-500">{ALLERGY_CATEGORIES[a.category]}</span>
                </div>
                <p className="text-sm text-ink-700">
                  {a.reaction ? `${a.reaction} · ` : ''}
                  {ALLERGY_SOURCES[a.source]}
                  {a.drugClass ? ` · checked as ${DRUG_CLASSES[a.drugClass].label}` : ''}
                </p>
                <p className="text-xs text-ink-500">
                  Recorded {date(a.recordedAt)} by {a.recordedBy ?? 'staff'}
                </p>
                {canWrite ? (
                  <details className="text-xs">
                    <summary className="inline-flex min-h-11 cursor-pointer items-center text-ink-500 hover:text-ink-800">Strike out</summary>
                    <form action={strikeOutAllergyAction} className="mt-1 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="admissionId" value={id} />
                      <input type="hidden" name="allergyId" value={a.id} />
                      <input name="reason" required minLength={3} maxLength={200} placeholder="Why (e.g. recorded in error, tested: not allergic)" className={cn(field, 'mt-0 min-w-0 flex-1')} />
                      <Button type="submit" variant="danger" size="sm" className="h-11">
                        Strike out
                      </Button>
                    </form>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canWrite ? (
        <>
          <Card>
            <CardHeader title="Record an allergy" hint="As the patient or family says it. Medicine allergies are checked against the treatment card." />
            <form action={recordAllergyAction} className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5">
              <input type="hidden" name="admissionId" value={id} />
              <input type="hidden" name="clientId" value={crypto.randomUUID()} />
              <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
                Allergic to
                <input name="substance" required minLength={2} maxLength={80} placeholder="e.g. Penicillin, sulfa drugs, Brufen, peanuts" className={field} />
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Kind
                <select name="category" defaultValue="drug" className={field}>
                  {Object.entries(ALLERGY_CATEGORIES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-ink-700">
                How severe
                <select name="severity" defaultValue="unknown" className={field}>
                  {Object.entries(ALLERGY_SEVERITIES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-ink-700">
                What happens
                <input name="reaction" maxLength={120} placeholder="e.g. rash, swelling of face" className={field} />
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Who said so
                <select name="source" defaultValue="patient" className={field}>
                  {Object.entries(ALLERGY_SOURCES).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="sm:col-span-2">
                <Button type="submit" variant="primary" className="h-11">
                  Save allergy
                </Button>
              </div>
            </form>
          </Card>

          <Card>
            <CardHeader title="Asked, and none known?" hint="Say so, so the next person knows it was asked." />
            <div className="flex flex-wrap gap-2 px-4 pb-4 sm:px-5">
              <form action={reviewAllergiesAction}>
                <input type="hidden" name="admissionId" value={id} />
                <input type="hidden" name="outcome" value="nkda" />
                <Button type="submit" variant="secondary" className="h-11">
                  No known drug allergies
                </Button>
              </form>
              <form action={reviewAllergiesAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="admissionId" value={id} />
                <input type="hidden" name="outcome" value="unable" />
                <input name="note" required maxLength={200} placeholder="Could not ask: why (e.g. unconscious, no family)" className={cn(field, 'mt-0 w-72 max-w-full')} />
                <Button type="submit" variant="ghost" className="h-11">
                  Could not ask
                </Button>
              </form>
            </div>
          </Card>
        </>
      ) : null}

      <p className="text-xs text-ink-500">
        The check on the treatment card matches names and these drug classes: {Object.values(DRUG_CLASSES).map((c) => c.label).join(', ')}. It is a
        reminder, not a full interaction database.
      </p>
    </div>
  );
}
