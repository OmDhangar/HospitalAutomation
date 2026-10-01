import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { ConsultationError, getPrescriptionForPrint } from '@/lib/services/consultations';
import { PrintControls } from './print-controls';

export const metadata = { title: 'Prescription' };

/**
 * The printed prescription.
 *
 * Outside the (app) group on purpose, so the app's header and navigation are
 * never on the page to begin with — nothing to hide with print CSS. Sized for
 * A5, the common prescription pad, and fits A4 as well.
 *
 * It shows exactly what was saved: the medicine names captured at the time,
 * not whatever the catalogue calls them now, and no prices at all. A
 * superseded prescription still prints, clearly marked, so an old slip in a
 * patient's hand can be checked against the current one. Every view is
 * written to record_access_logs by the service.
 */
export default async function PrescriptionPrintPage({
  params,
  searchParams,
}: PageProps<'/print/prescription/[id]'>) {
  const session = await requireSession();
  if (session.mustChangePassword) redirect('/change-password');
  const { id } = await params;
  const query = await searchParams;

  let prescription;
  try {
    prescription = await getPrescriptionForPrint({
      hospitalId: session.hospitalId,
      prescriptionId: id,
      actor: { userId: session.userId, role: session.role },
    });
  } catch (err) {
    const message = err instanceof ConsultationError ? err.message : 'Prescription not available';
    return <main className="p-10 text-center text-ink-700">{message}</main>;
  }

  const p = prescription;
  const date = new Date(p.createdAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const followUp = p.followUpOn
    ? new Date(`${p.followUpOn}T00:00:00`).toLocaleDateString('en-IN', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null;

  return (
    <main className="min-h-dvh bg-ink-100 py-8 print:bg-white print:py-0">
      <style>{'@page { size: A5; margin: 12mm; }'}</style>
      <div className="mx-auto max-w-[148mm] print:max-w-none">
        <PrintControls autoPrint={query.print !== '0'} />

        <article className="relative bg-white p-8 text-[13px] leading-relaxed text-ink-900 shadow-sm print:p-0 print:shadow-none">
          {p.superseded ? (
            <p className="mb-4 rounded border-2 border-rose-600 px-3 py-2 text-center text-sm font-bold uppercase tracking-wide text-rose-700">
              Superseded — a revised prescription replaces this one
            </p>
          ) : null}

          <header className="border-b-2 border-ink-900 pb-3">
            <h1 className="text-lg font-bold">{p.hospital.name}</h1>
            <p className="text-xs text-ink-600">
              {p.hospital.branchName}
              {p.hospital.branchAddress ? ` · ${p.hospital.branchAddress}` : ''}
            </p>
            <p className="mt-2 font-semibold">
              {p.doctor.name}
              {p.doctor.specialty ? (
                <span className="font-normal text-ink-600"> · {p.doctor.specialty}</span>
              ) : null}
            </p>
          </header>

          <section className="flex flex-wrap justify-between gap-2 border-b border-ink-300 py-3">
            <p>
              <span className="font-semibold">{p.patient.name}</span>
              {p.patient.age ? `, ${p.patient.age} yrs` : ''}
              {p.patient.gender ? `, ${p.patient.gender}` : ''}
            </p>
            <p>Date: {date}</p>
          </section>

          {p.diagnosis ? (
            <section className="border-b border-ink-300 py-3">
              <span className="font-semibold">Diagnosis: </span>
              {p.diagnosis}
            </section>
          ) : null}

          <section className="py-3">
            <p className="mb-2 text-xl font-bold">℞</p>
            {p.items.length === 0 ? (
              <p className="text-ink-600">No medicines prescribed.</p>
            ) : (
              <ol className="space-y-2.5">
                {p.items.map((item, index) => (
                  <li key={index} className="break-inside-avoid">
                    <p className="font-semibold">
                      {index + 1}. {item.label}
                    </p>
                    <p className="pl-4 text-ink-800">
                      {item.dose} · {item.frequency}
                      {item.durationDays ? ` · ${item.durationDays} days` : ''}
                      {item.instructions ? ` · ${item.instructions}` : ''}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {p.advice ? (
            <section className="border-t border-ink-300 py-3">
              <span className="font-semibold">Advice: </span>
              <span className="whitespace-pre-line">{p.advice}</span>
            </section>
          ) : null}

          {followUp ? (
            <section className="border-t border-ink-300 py-3">
              <span className="font-semibold">Follow-up: </span>
              {followUp}
            </section>
          ) : null}

          <footer className="mt-12 flex justify-end">
            <div className="w-48 border-t border-ink-900 pt-1 text-center text-xs">{p.doctor.name}</div>
          </footer>
        </article>
      </div>
    </main>
  );
}
