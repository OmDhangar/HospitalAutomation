import Link from 'next/link';
import { Card, EmptyState } from '@/components/ui';
import { TraceView, type TraceFilters } from '@/components/booking-trace/trace-view';
import { requireSession } from '@/lib/auth/session';
import { serviceDateIn } from '@/lib/domain/time';
import { canConfigureHospital } from '@/lib/services/auth';
import { getBookingTrace } from '@/lib/services/booking-trace';

export const metadata = { title: 'Booking trace · OPD Queue' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The hospital owner's own booking trace: the same evidence the platform
 * console sees, so a dispute about a token is settled by the owner looking,
 * not by anyone sending database output.
 */
export default async function HospitalTracePage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requireSession();
  if (!canConfigureHospital(session.role)) {
    return (
      <Card>
        <EmptyState
          title="Only the hospital owner can view the booking trace"
          hint="It shows every booking with the staff member who created it."
        />
      </Card>
    );
  }

  const params = await searchParams;
  const date = one(params.date);
  const filters: TraceFilters = {
    date: DATE.test(date) ? date : serviceDateIn(session.timezone),
    doctor: one(params.doctor),
    token: one(params.token),
    phone: one(params.phone),
  };
  const trace = await getBookingTrace({
    hospitalId: session.hospitalId,
    serviceDate: filters.date,
    doctorId: filters.doctor || null,
    tokenNumber: Number(filters.token) || null,
    phoneDigits: filters.phone || null,
  });

  return (
    <div className="space-y-4">
      <Link href="/audit" className="text-sm font-medium text-brand-700 hover:text-brand-900 print:hidden">
        ← Activity &amp; audit log
      </Link>
      <TraceView trace={trace} timezone={session.timezone} filters={filters} heading="Booking trace" />
    </div>
  );
}
