import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getDoctorSummaryCockpitData } from '@/lib/services/ipd-summary';
import { getTestChips } from '@/lib/services/doctor-ipd';
import { formatDoctor } from '@/lib/domain/doctor';
import { can } from '@/lib/domain/permissions';
import { DailyMedicationMatrix } from '@/components/ipd/summary/daily-medication-matrix';
import { TprFlowsheet } from '@/components/ipd/summary/tpr-flowsheet';
import { DoctorQuickActions } from '@/components/ipd/summary/doctor-quick-actions';
import { SummaryAdministeredCard } from '@/components/ipd/summary/summary-administered-card';
import { AlertTriangleIcon } from '@/components/icons';

export default async function SummaryPage({ params }: { params: Promise<any> }) {
  const session = await requireSession();
  const resolvedParams = await params;
  const id = resolvedParams?.id as string;

  const [cockpit, testChips] = await Promise.all([
    getDoctorSummaryCockpitData({
      hospitalId: session.hospitalId,
      admissionId: id,
    }),
    getTestChips(session.hospitalId),
  ]);

  const { admission, medications, vitals, fluidBalance, attentionItems, recentHistory = [] } = cockpit;
  if (!admission) notFound();

  const formattedDoctor = formatDoctor(admission.doctorName);
  const canPrescribe = can(session.role, 'ipd.prescribe') && !session.readOnly;
  const dayOfStay = admission.admittedAt
    ? Math.max(1, Math.ceil((Date.now() - new Date(admission.admittedAt).getTime()) / (1000 * 60 * 60 * 24)))
    : 1;

  return (
    <div className="space-y-3.5">
      {/* 1. Attention Strip (Compact alert badges) */}
      {attentionItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {attentionItems.map((item) => (
            <div
              key={item.key}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border shadow-2xs ${
                item.tone === 'danger'
                  ? 'bg-rose-50 border-rose-200 text-rose-900'
                  : item.tone === 'warning'
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-sky-50 border-sky-200 text-sky-900'
              }`}
            >
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              <span>{item.label}</span>
              {item.actionHref && item.actionText && (
                <Link
                  href={item.actionHref}
                  className="font-bold underline ml-1 hover:opacity-80"
                >
                  {item.actionText}
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 2. Doctor Action Strip & Inpatient Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-surface rounded-xl border border-ink-200 p-3.5 shadow-2xs">
        <div>
          <h2 className="text-sm font-bold text-ink-950 flex items-center gap-2">
            <span>Inpatient Clinical Summary</span>
            <span className="rounded-full bg-brand-100 text-brand-900 text-[10px] font-bold px-2 py-0.5">
              Day {dayOfStay} of stay
            </span>
          </h2>
          <p className="text-xs text-ink-500 mt-0.5">
            Active treatment orders, TPR trends, 24h fluid balance, and administered medications.
          </p>
        </div>

        <DoctorQuickActions
          admissionId={id}
          patientName={admission.patientName}
          initialDiagnosis={admission.reason}
          testChips={testChips}
          canPrescribe={canPrescribe}
          activeOrders={medications.map((m) => ({
            id: m.orderId,
            medicineName: m.medicineName,
            strength: m.strength,
            form: m.form,
            route: m.route,
            frequency: m.frequency,
          }))}
        />
      </div>

      {/* 3. Main Bento Grid (8 cols / 4 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 items-start">
        {/* Left Column (8 cols): Clinical Matrix, Vitals Snapshot, Fluid Balance */}
        <div className="lg:col-span-8 space-y-3.5">
          {/* Daily Medication Fulfillment Matrix with Checkboxes */}
          <DailyMedicationMatrix
            medications={medications}
            admissionId={id}
            patientName={admission.patientName}
            initialDiagnosis={admission.reason}
            canPrescribe={canPrescribe}
          />

          {/* Embedded TPR & Vitals Flowsheet - Preserved 6-check snapshot with Full Flowsheet -> button */}
          <TprFlowsheet readings={vitals} admissionId={id} />

          {/* 24-Hour Fluid Balance Grid */}
          <div className="bg-surface rounded-lg border border-ink-200 shadow-2xs overflow-hidden">
            <div className="px-3 py-2 bg-ink-50/70 border-b border-ink-200 flex items-center justify-between">
              <span className="text-xs font-bold text-ink-900 tracking-tight">
                24-Hour Fluid Balance (Intake vs Output)
              </span>
              <span
                className={`inline-flex items-center px-1.5 py-0.2 rounded font-mono text-[11px] font-bold ${
                  fluidBalance.netBalanceMl >= 0
                    ? 'bg-emerald-50 text-emerald-800'
                    : 'bg-rose-50 text-rose-800'
                }`}
              >
                Net: {fluidBalance.netBalanceMl > 0 ? `+${fluidBalance.netBalanceMl}` : fluidBalance.netBalanceMl} ml
              </span>
            </div>

            <div className="p-2.5 grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
              {/* Intake */}
              <div className="p-2 rounded bg-slate-50 border border-ink-100 space-y-1">
                <div className="font-sans font-semibold text-[11px] text-ink-700 uppercase flex justify-between">
                  <span>Total Intake</span>
                  <span className="font-bold text-ink-900">{fluidBalance.totalInMl} ml</span>
                </div>
                <div className="flex justify-between text-[11px] text-ink-600">
                  <span className="font-sans">Oral:</span>
                  <span>{fluidBalance.breakdown.oralMl} ml</span>
                </div>
                <div className="flex justify-between text-[11px] text-ink-600">
                  <span className="font-sans">IV Infusion:</span>
                  <span>{fluidBalance.breakdown.ivMl} ml</span>
                </div>
              </div>

              {/* Output */}
              <div className="p-2 rounded bg-slate-50 border border-ink-100 space-y-1">
                <div className="font-sans font-semibold text-[11px] text-ink-700 uppercase flex justify-between">
                  <span>Total Output</span>
                  <span className="font-bold text-ink-900">{fluidBalance.totalOutMl} ml</span>
                </div>
                <div className="flex justify-between text-[11px] text-ink-600">
                  <span className="font-sans">Urine:</span>
                  <span>{fluidBalance.breakdown.urineMl} ml</span>
                </div>
                <div className="flex justify-between text-[11px] text-ink-600">
                  <span className="font-sans">Drain / Aspirate:</span>
                  <span>{fluidBalance.breakdown.drainMl} ml</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column (4 cols): Care Team, Given Medicines Today Bento Card, Chart Navigation */}
        <div className="lg:col-span-4 space-y-3.5">
          {/* Patient Stay & Care Team Card */}
          <div className="bg-surface rounded-lg border border-ink-200 shadow-2xs p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between border-b border-ink-100 pb-2">
              <span className="font-bold text-ink-900 text-xs tracking-tight">
                Admission Overview &amp; Care Team
              </span>
              <span className="text-[11px] text-ink-500">
                {admission.admittedAt
                  ? `Admitted: ${new Date(admission.admittedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
                  : 'Not formally admitted'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span className="text-ink-500 block">Admitting Consultant:</span>
                <span className="font-semibold text-ink-900">{formattedDoctor}</span>
              </div>
              <div>
                <span className="text-ink-500 block">Current Bed / Ward:</span>
                <span className="font-semibold text-ink-900">
                  {admission.bed
                    ? `${admission.bed.wardName} · Bed ${admission.bed.label}`
                    : 'Unassigned'}
                </span>
              </div>
              <div>
                <span className="text-ink-500 block">Payer Category:</span>
                <span className="font-semibold text-ink-900">
                  {admission.payer?.payerName || 'Self Pay (Cash)'}
                </span>
              </div>
              <div>
                <span className="text-ink-500 block">Admission Status:</span>
                <span className="font-semibold text-emerald-800">
                  {admission.status === 'discharge_ready' ? 'Ready for Discharge' : 'Admitted'}
                </span>
              </div>
            </div>

            <div className="pt-2 border-t border-ink-100">
              <span className="text-[11px] text-ink-500 block">Working Diagnosis / Admission Reason:</span>
              <p className="font-medium text-ink-800 mt-0.5 text-xs bg-ink-50 p-2 rounded border border-ink-200">
                {admission.reason || 'Diagnosis not recorded in admission record.'}
              </p>
            </div>
          </div>

          {/* Bento Card: Independently Scrollable Given Medicines Today */}
          <SummaryAdministeredCard
            admissionId={id}
            doses={recentHistory}
          />

          {/* Quick Chart Sheets (Simple English) */}
          <div className="bg-surface rounded-lg border border-ink-200 shadow-2xs p-3.5">
            <span className="font-bold text-ink-900 text-xs tracking-tight block mb-2">
              Patient Chart Sheets
            </span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Link
                href={`/ipd/patients/${id}/orders`}
                className="p-2 rounded border border-ink-200 bg-white hover:bg-slate-50 transition-colors"
              >
                <div className="font-semibold text-ink-900">Doctor Prescriptions</div>
                <div className="text-[10px] text-ink-500">Prescriptions &amp; IV fluids</div>
              </Link>
              <Link
                href={`/ipd/patients/${id}/emar`}
                className="p-2 rounded border border-ink-200 bg-white hover:bg-slate-50 transition-colors"
              >
                <div className="font-semibold text-ink-900">Medication Chart</div>
                <div className="text-[10px] text-ink-500">Medication timings</div>
              </Link>
              <Link
                href={`/ipd/patients/${id}/vitals`}
                className="p-2 rounded border border-ink-200 bg-white hover:bg-slate-50 transition-colors"
              >
                <div className="font-semibold text-ink-900">Vitals &amp; I/O</div>
                <div className="text-[10px] text-ink-500">Full TPR flowsheet</div>
              </Link>
              <Link
                href={`/ipd/patients/${id}/notes`}
                className="p-2 rounded border border-ink-200 bg-white hover:bg-slate-50 transition-colors"
              >
                <div className="font-semibold text-ink-900">Doctor Notes</div>
                <div className="text-[10px] text-ink-500">Clinical progress</div>
              </Link>
              <Link
                href={`/ipd/patients/${id}/billing`}
                className="p-2 rounded border border-ink-200 bg-white hover:bg-slate-50 transition-colors"
              >
                <div className="font-semibold text-ink-900">Used Items &amp; Bill</div>
                <div className="text-[10px] text-ink-500">Medicines &amp; consumables</div>
              </Link>
              <Link
                href={`/ipd/patients/${id}/discharge`}
                className="p-2 rounded border border-ink-200 bg-white hover:bg-slate-50 transition-colors"
              >
                <div className="font-semibold text-ink-900">Discharge</div>
                <div className="text-[10px] text-ink-500">Readiness &amp; bill</div>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
