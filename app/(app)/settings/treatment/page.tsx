import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SaveButton, SaveForm } from '@/components/save-form';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { listBranches, listStaffMembers } from '@/lib/services/auth';
import { getMarConfig, listOnCall, listTimeCriticalMedicines, listWardsInCharge } from '@/lib/services/due';
import { listOrderingDoctors } from '@/lib/services/mar';
import { addOnCallAction, cancelOnCallAction, setInChargeAction, setTimeCriticalAction, signOffAction, updateSettingsAction } from './actions';

export const metadata = { title: 'Treatment and due times · Settings' };

const field = 'mt-1 block h-11 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300';

/**
 * Settings → Treatment and due times (IPD sheets plan B3b, §7.10, D-TIMECRIT,
 * D-ESCAL). We ship no clinical timings switched on: the hospital's doctor
 * marks which medicines are time-critical (a starter list is suggested for
 * review), sets their windows, and signs the list off; any later change waits
 * for a new sign-off before alerts run. The owner sets the windows for other
 * medicines, the escalation delays, the ward-tablet chime, the on-call roster
 * (level 2) and each ward's in-charge (level 1).
 */
export default async function TreatmentSettingsPage({ searchParams }: PageProps<'/settings/treatment'>) {
  const session = await requireSession();
  await requireModule(session, 'mar');
  const canList = can(session.role, 'ipd.tcList');
  const canConfigure = can(session.role, 'ipd.dueConfigure');
  if (!canList && !canConfigure) notFound();
  const query = await searchParams;
  const q = typeof query.q === 'string' ? query.q : '';

  const [config, meds, onCall, doctors, branches, wardRows, staff] = await Promise.all([
    getMarConfig(session.hospitalId),
    listTimeCriticalMedicines(session.hospitalId, q),
    canConfigure ? listOnCall(session.hospitalId) : Promise.resolve([]),
    listOrderingDoctors(session.hospitalId),
    canConfigure ? listBranches(session.hospitalId) : Promise.resolve([]),
    canConfigure ? listWardsInCharge(session.hospitalId) : Promise.resolve([]),
    canConfigure ? listStaffMembers(session.hospitalId) : Promise.resolve([]),
  ]);
  const s = config.settings;
  const amDoctor = doctors.some((d) => d.userId === session.userId);
  const clinicalStaff = staff.filter((m) => m.active && ['owner', 'doctor', 'nurse'].includes(m.role));
  const fmt = (d: Date) => d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: session.timezone });

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link href="/settings" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Settings
      </Link>
      <div>
        <h1 className="text-xl font-bold text-ink-900">Treatment and due times</h1>
        <p className="text-sm text-ink-600">
          Which medicines are time-critical, their windows, who is told when a dose is late, and the ward-tablet chime. The stage (observe, warn, enforce) is set under{' '}
          <Link href="/settings/modules" className="font-medium text-brand-700 underline">
            Modules
          </Link>
          : now <strong>{config.stage}</strong>.
        </p>
      </div>
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <Card>
        <div id="signoff" className="scroll-mt-20" />
        <CardHeader title="Sign-off" hint="Time-critical alerts run only while the list and windows are as a doctor signed them" />
        <div className="space-y-3 p-4 sm:p-5">
          <p className={cn('rounded-lg px-3 py-2 text-sm font-medium', config.signoff.current ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900')}>
            {config.signoff.current
              ? `Signed off by ${config.signoff.signedBy} on ${fmt(config.signoff.signedAt!)} · ${config.signoff.count} medicine${config.signoff.count === 1 ? '' : 's'}. Alerts are on.`
              : config.signoff.signedAt
                ? `Changed since ${config.signoff.signedBy} signed off on ${fmt(config.signoff.signedAt)}. Alerts are off until a doctor signs off again.`
                : 'Never signed off. Time-critical alerts are off; due times still show on the board.'}
          </p>
          {canList && !config.signoff.current ? (
            amDoctor ? (
              <form action={signOffAction} className="flex flex-wrap items-end gap-2">
                <label className="block min-w-0 flex-1 text-sm font-medium text-ink-700">
                  Note (optional)
                  <input name="note" maxLength={300} placeholder="e.g. Reviewed with the pharmacist" className={field} />
                </label>
                <Button type="submit" variant="primary" className="h-11">
                  I have reviewed this list and these windows: sign off
                </Button>
              </form>
            ) : (
              <p className="text-xs text-ink-500">A login linked to a doctor signs off (Settings → Doctors links a login).</p>
            )
          ) : null}
        </div>
      </Card>

      {canList ? (
        <Card>
          <div id="list" className="scroll-mt-20" />
          <CardHeader title="Time-critical medicines" hint={`Window ±${s.tcWindowMin} min unless set per medicine · suggestions are for review, never switched on by us`} />
          <form method="get" className="flex gap-2 px-4 pb-3 pt-3 sm:px-5">
            <input name="q" defaultValue={q} placeholder="Search medicines" className="h-11 flex-1 rounded-lg border-0 px-3 text-sm ring-1 ring-inset ring-ink-300" />
            <Button type="submit" variant="secondary" className="h-11">
              Search
            </Button>
          </form>
          {meds.length === 0 ? (
            <EmptyState title={q ? 'No medicine matches' : 'None marked, and no starter suggestion matches your medicine list'} />
          ) : (
            <ul className="divide-y divide-ink-100 border-t border-ink-100">
              {meds.map((m) => (
                <li key={m.id}>
                  <form action={setTimeCriticalAction} className="flex flex-wrap items-end justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                    <input type="hidden" name="medicineId" value={m.id} />
                    <input type="hidden" name="q" value={q} />
                    <input type="hidden" name="timeCritical" value={String(!m.timeCritical)} />
                    <span className="min-w-0">
                      <strong className="text-ink-900">{m.label}</strong>
                      {m.timeCritical ? <span className="ml-2 rounded bg-red-600 px-1.5 text-xs font-bold text-white">TC</span> : null}
                      {!m.timeCritical && m.starter ? <span className="ml-2 text-xs text-ink-500">Suggested: {m.starter}</span> : null}
                    </span>
                    <span className="flex flex-wrap items-end gap-2">
                      {!m.timeCritical ? (
                        <>
                          <label className="block w-24 text-xs text-ink-600">
                            Before (min)
                            <input name="before" type="number" min={5} max={240} placeholder={String(s.tcWindowMin)} className={field} />
                          </label>
                          <label className="block w-24 text-xs text-ink-600">
                            After (min)
                            <input name="after" type="number" min={5} max={240} placeholder={String(s.tcWindowMin)} className={field} />
                          </label>
                        </>
                      ) : (
                        <span className="text-xs text-ink-600">
                          −{m.before ?? s.tcWindowMin} / +{m.after ?? s.tcWindowMin} min
                        </span>
                      )}
                      <Button type="submit" variant={m.timeCritical ? 'ghost' : 'secondary'} size="sm" className="h-11">
                        {m.timeCritical ? 'Not time-critical' : 'Time-critical'}
                      </Button>
                    </span>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {canConfigure ? (
        <>
          <Card>
            <div id="settings" className="scroll-mt-20" />
            <CardHeader title="Windows, escalation and chime" hint="Changing the time-critical window or the delays needs a new sign-off" />
            <SaveForm action={updateSettingsAction} justSaved={query.settings === '1'} className="space-y-3 p-4 sm:p-5">
              <div className="grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ['tcWindowMin', 'Time-critical window ± (min)', s.tcWindowMin],
                    ['otherWindowMin', 'Other medicines window ± (min)', s.otherWindowMin],
                    ['dueSoonLeadMin', '“Due soon” before the window (min)', s.dueSoonLeadMin],
                    ['l1AfterMin', 'Level 1 after the window (min)', s.l1AfterMin],
                    ['l2AfterMin', 'Level 2 after the window (min)', s.l2AfterMin],
                  ] as const
                ).map(([name, label, value]) => (
                  <label key={name} className="block text-sm font-medium text-ink-700">
                    {label}
                    <input name={name} type="number" min={0} max={240} defaultValue={value} className={field} />
                  </label>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-ink-700">
                  <input type="checkbox" name="chime" defaultChecked={s.chime} className="size-5" />
                  Chime on ward tablets
                </label>
                <label className="block text-sm font-medium text-ink-700">
                  Quiet from
                  <input type="time" name="quietFrom" defaultValue={s.quietFrom ?? ''} className={field} />
                </label>
                <label className="block text-sm font-medium text-ink-700">
                  Quiet until
                  <input type="time" name="quietTo" defaultValue={s.quietTo ?? ''} className={field} />
                </label>
              </div>
              <SaveButton label="Save" variant="primary" size="md" />
            </SaveForm>
          </Card>

          <Card>
            <div id="oncall" className="scroll-mt-20" />
            <CardHeader title="Doctor on call" hint="Level 2 goes to the doctor on call; with nobody on call, to the doctor who ordered it" />
            {onCall.length > 0 ? (
              <ul className="divide-y divide-ink-100">
                {onCall.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                    <span>
                      <strong>{o.doctorName}</strong> · {fmt(o.startsAt)} to {fmt(o.endsAt)}
                    </span>
                    <form action={cancelOnCallAction}>
                      <input type="hidden" name="id" value={o.id} />
                      <Button type="submit" variant="ghost" size="sm" className="h-11">
                        Remove
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : null}
            <form action={addOnCallAction} className="grid gap-3 border-t border-ink-100 p-4 sm:grid-cols-4 sm:p-5">
              <label className="block text-sm font-medium text-ink-700">
                Doctor
                <select name="doctorId" required defaultValue="" className={field}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Branch
                <select name="branchId" defaultValue={session.branchId ?? branches[0]?.id} className={field}>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-ink-700">
                From
                <input type="datetime-local" name="from" required className={field} />
              </label>
              <label className="block text-sm font-medium text-ink-700">
                To
                <input type="datetime-local" name="to" required className={field} />
              </label>
              <div className="sm:col-span-4">
                <Button type="submit" variant="primary" className="h-11">
                  Add on-call
                </Button>
              </div>
            </form>
          </Card>

          <Card>
            <div id="incharge" className="scroll-mt-20" />
            <CardHeader title="Ward in-charge" hint="Level 1 goes to the ward’s in-charge; with none set, to the ward’s tablets and the owner" />
            {wardRows.length === 0 ? (
              <EmptyState title="No wards yet" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {wardRows.map((w) => (
                  <li key={w.id}>
                    <form action={setInChargeAction} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                      <input type="hidden" name="wardId" value={w.id} />
                      <strong>{w.name}</strong>
                      <span className="flex gap-2">
                        <select name="userId" defaultValue={w.inChargeUserId ?? ''} aria-label={`In-charge of ${w.name}`} className="h-11 min-w-48 rounded-lg border-0 bg-white px-2 text-sm ring-1 ring-inset ring-ink-300">
                          <option value="">Nobody</option>
                          {clinicalStaff.map((m) => (
                            <option key={m.userId} value={m.userId}>
                              {m.name} ({m.role})
                            </option>
                          ))}
                        </select>
                        <Button type="submit" variant="secondary" size="sm" className="h-11">
                          Save
                        </Button>
                      </span>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
