import { Card, EmptyState, Field } from '@/components/ui';
import { TraceView, type TraceFilters } from '@/components/booking-trace/trace-view';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { serviceDateIn } from '@/lib/domain/time';
import { getBookingTrace, listTraceHospitals } from '@/lib/services/booking-trace';

export const metadata = { title: 'Booking trace · Platform' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Booking trace across the platform: pick a hospital and a day, and see how
 * every token was allocated — the answer to "the system gave an online patient
 * a reserved token" without opening psql.
 */
export default async function AdminTracePage({ searchParams }: { searchParams: SearchParams }) {
  await requirePlatformAdmin();
  const params = await searchParams;
  const hospitals = await listTraceHospitals();
  const hospital = hospitals.find((h) => h.id === one(params.hospital)) ?? null;

  const picker = (
    <Field label="Hospital">
      <select
        name="hospital"
        defaultValue={hospital?.id ?? ''}
        required
        className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none"
      >
        <option value="" disabled>
          Choose a hospital
        </option>
        {hospitals.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
          </option>
        ))}
      </select>
    </Field>
  );

  if (!hospital) {
    return (
      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-64">{picker}</div>
          <button
            type="submit"
            className="h-10 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 cursor-pointer"
          >
            Open trace
          </button>
        </form>
        <EmptyState title="Choose a hospital" hint="Then pick a day to see how each of its tokens was allocated." />
      </Card>
    );
  }

  const date = one(params.date);
  const filters: TraceFilters = {
    date: DATE.test(date) ? date : serviceDateIn(hospital.timezone),
    doctor: one(params.doctor),
    token: one(params.token),
    phone: one(params.phone),
  };
  const trace = await getBookingTrace({
    hospitalId: hospital.id,
    serviceDate: filters.date,
    doctorId: filters.doctor || null,
    tokenNumber: Number(filters.token) || null,
    phoneDigits: filters.phone || null,
  });

  return (
    <TraceView
      trace={trace}
      timezone={hospital.timezone}
      filters={filters}
      leadingFilter={picker}
      heading={`Booking trace · ${hospital.name}`}
    />
  );
}
