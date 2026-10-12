'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PrinterIcon } from '@/components/icons';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, cn } from '@/components/ui';
import { DISCHARGE_TYPES, SECTIONS, type DischargeType, type SummaryContent, type SummaryMedicine } from '@/lib/domain/discharge-summary';
import { countersignSummaryDynamic, finaliseSummaryDynamic, refreshSummaryDynamic, saveSummaryDraftDynamic, type SummaryResult } from './actions';

/**
 * The discharge summary editor (IPD sheets plan B5): every section as plain
 * text, started from the record; the medicines going home as a table; Save
 * draft, Fill again from the record, and Finalise (signed by the doctor
 * named, or waiting for their signature).
 */

type VersionView = {
  id: string;
  version: number;
  doctorName: string;
  doctorUserId: string | null;
  finalisedAt: string;
  finalisedBy: string | null;
  transcribed: boolean;
  signedAt: string | null;
  signedBy: string | null;
  changeReason: string | null;
};

const field = 'mt-1 block w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300';

export function SummaryEditor(props: {
  admissionId: string;
  timezone: string;
  draft: SummaryContent;
  draftSaved: { at: string; by: string | null } | null;
  versions: VersionView[];
  doctorId: string;
  doctors: { id: string; name: string; userId: string | null }[];
  canEdit: boolean;
  canSign: boolean;
  myUserId: string;
}) {
  const toast = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [content, setContent] = useState<SummaryContent>(props.draft);
  const [doctorId, setDoctorId] = useState(props.doctorId);
  const [changeReason, setChangeReason] = useState('');
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const latest = props.versions[0] ?? null;
  const time = (iso: string) =>
    new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: props.timezone }).format(new Date(iso));

  const act = (work: () => Promise<SummaryResult>, after?: (res: SummaryResult & { ok: true }) => void) =>
    startTransition(async () => {
      const res = await work();
      if (!res.ok) toast.error('Not saved', res.error);
      else {
        toast.success(res.message);
        after?.(res);
        router.refresh();
      }
    });

  const setMedicine = (i: number, patch: Partial<SummaryMedicine>) =>
    setContent({ ...content, medicines: content.medicines.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  return (
    <div className="space-y-4">
      {props.versions.length > 0 ? (
        <Card>
          <CardHeader
            title="Finalised versions"
            hint="Only a signed version prints without DRAFT."
            action={
              <Link
                href={`/print/ipd-file/${props.admissionId}?sheets=discharge_summary`}
                target="_blank"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
              >
                <PrinterIcon className="size-4" />
                Print
              </Link>
            }
          />
          <ul className="divide-y divide-ink-100">
            {props.versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm sm:px-5">
                <span>
                  <strong>Version {v.version}</strong> · {v.doctorName} · finalised {time(v.finalisedAt)}
                  {v.transcribed ? ` by ${v.finalisedBy ?? 'staff'}` : ''}
                  {v.changeReason ? <span className="block text-ink-600">Changed: “{v.changeReason}”</span> : null}
                </span>
                {v.signedAt ? (
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                    Signed{v.transcribed ? ` by ${v.signedBy ?? 'the doctor'}` : ''} · {time(v.signedAt)}
                  </span>
                ) : props.canSign && v.doctorUserId === props.myUserId ? (
                  <Button type="button" variant="primary" className="h-11" isLoading={pending} onClick={() => act(() => countersignSummaryDynamic({ admissionId: props.admissionId, summaryId: v.id }))}>
                    Sign
                  </Button>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">Waiting for the doctor’s signature</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title={latest ? `Next version (${latest.version + 1})` : 'Draft'}
          hint={
            props.draftSaved
              ? `Draft saved ${time(props.draftSaved.at)}${props.draftSaved.by ? ` by ${props.draftSaved.by}` : ''}`
              : latest
                ? `Starts from version ${latest.version}`
                : 'Started from the record: check every section'
          }
        />
        <form
          className="space-y-4 px-4 pb-4 sm:px-5"
          onSubmit={(e) => {
            e.preventDefault();
            act(
              () =>
                finaliseSummaryDynamic({
                  admissionId: props.admissionId,
                  content: content as unknown as Record<string, unknown>,
                  doctorId,
                  changeReason,
                  clientId,
                }),
              () => {
                setClientId(crypto.randomUUID());
                setChangeReason('');
              },
            );
          }}
        >
          <fieldset disabled={!props.canEdit} className="space-y-4">
            <label className="block text-sm font-medium text-ink-700">
              How the patient left
              <select
                value={content.dischargeType}
                onChange={(e) => setContent({ ...content, dischargeType: e.target.value as DischargeType })}
                className={cn(field, 'h-11')}
              >
                {Object.entries(DISCHARGE_TYPES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {SECTIONS.map((section) => (
              <label key={section.key} className="block text-sm font-medium text-ink-700">
                {section.label}
                <textarea
                  value={content[section.key]}
                  onChange={(e) => setContent({ ...content, [section.key]: e.target.value })}
                  rows={section.rows}
                  maxLength={section.max}
                  className={cn(field, 'py-2')}
                />
              </label>
            ))}

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink-700">Medicines to continue at home</legend>
              {content.medicinesUnreconciled ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Taken from the treatment card: the discharge medicines were not reconciled. Check each, or complete them under Home medicines and fill again.
                </p>
              ) : null}
              {content.medicines.map((m, i) => (
                <div key={i} className="grid gap-2 rounded-lg bg-ink-50 p-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
                  <input value={m.name} onChange={(e) => setMedicine(i, { name: e.target.value })} aria-label="Medicine" placeholder="Medicine" maxLength={120} className={cn(field, 'mt-0 h-11')} />
                  <input value={m.dose} onChange={(e) => setMedicine(i, { dose: e.target.value })} aria-label="Dose" placeholder="Dose" maxLength={40} className={cn(field, 'mt-0 h-11')} />
                  <input value={m.frequency} onChange={(e) => setMedicine(i, { frequency: e.target.value })} aria-label="How often" placeholder="How often" maxLength={40} className={cn(field, 'mt-0 h-11')} />
                  <input value={m.duration} onChange={(e) => setMedicine(i, { duration: e.target.value })} aria-label="How long" placeholder="How long" maxLength={40} className={cn(field, 'mt-0 h-11')} />
                  <button
                    type="button"
                    className="min-h-11 px-2 text-xs font-medium text-ink-500 hover:text-ink-900"
                    onClick={() => setContent({ ...content, medicines: content.medicines.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="min-h-11 text-sm font-semibold text-brand-700"
                onClick={() => setContent({ ...content, medicines: [...content.medicines, { name: '', dose: '', frequency: '', duration: '', note: '' }] })}
              >
                + Add a medicine
              </button>
            </fieldset>
          </fieldset>

          {props.canEdit ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11"
                  isLoading={pending}
                  onClick={() => act(() => saveSummaryDraftDynamic({ admissionId: props.admissionId, content: content as unknown as Record<string, unknown> }))}
                >
                  Save draft
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11"
                  isLoading={pending}
                  onClick={() =>
                    act(
                      () => refreshSummaryDynamic({ admissionId: props.admissionId, content: content as unknown as Record<string, unknown> }),
                      (res) => res.content && setContent(res.content),
                    )
                  }
                >
                  Fill again from the record
                </Button>
              </div>
              <div className="grid gap-3 rounded-xl bg-ink-50 p-3 sm:grid-cols-2">
                <label className="block text-sm font-medium text-ink-700">
                  Doctor responsible
                  <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} required className={cn(field, 'h-11')}>
                    {props.doctors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
                {latest ? (
                  <label className="block text-sm font-medium text-ink-700">
                    What changed from version {latest.version}
                    <input value={changeReason} onChange={(e) => setChangeReason(e.target.value)} required minLength={3} maxLength={200} className={cn(field, 'h-11')} />
                  </label>
                ) : null}
                <div className="sm:col-span-2">
                  <Button type="submit" variant="primary" className="h-11" isLoading={pending}>
                    Finalise {latest ? `version ${latest.version + 1}` : 'the summary'}
                  </Button>
                  <p className="mt-1 text-xs text-ink-600">Signed now when you are the doctor named; otherwise it waits for their signature.</p>
                </div>
              </div>
            </>
          ) : null}
        </form>
      </Card>
    </div>
  );
}
