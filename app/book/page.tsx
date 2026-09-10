import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui';
import { isLocale, type Locale } from '@/lib/i18n/patient';
import { getDoctorBookingDetails } from '@/lib/services/web-booking';
import { BookSlotForm } from './book-form';

export const metadata = { title: 'Book Doctor Appointment Slot' };
export const dynamic = 'force-dynamic';

export default async function BookSlotPage({
  searchParams,
}: {
  searchParams: Promise<{ doctor?: string; hospital?: string; phone?: string; locale?: string; date?: string }>;
}) {
  const query = await searchParams;
  const doctorId = query.doctor;
  const hospitalId = query.hospital;
  const phone = query.phone ?? '';
  const date = query.date;
  const locale: Locale = isLocale(query.locale) ? query.locale : 'en';

  if (!doctorId || !hospitalId) {
    return (
      <main className="min-h-screen bg-ink-50 px-4 py-12">
        <div className="mx-auto max-w-md">
          <Card className="p-6 text-center">
            <h1 className="text-lg font-bold text-ink-900">Appointment Link Incomplete</h1>
            <p className="mt-2 text-sm text-ink-600">
              Please open this booking link from your WhatsApp message to choose your doctor and
              slot.
            </p>
            <div className="mt-6">
              <Link
                href="/"
                className="inline-block rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-700"
              >
                Go to Homepage
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  const details = await getDoctorBookingDetails({ hospitalId, doctorId, serviceDate: date });

  if (!details) {
    return (
      <main className="min-h-screen bg-ink-50 px-4 py-12">
        <div className="mx-auto max-w-md">
          <Card className="p-6 text-center">
            <h1 className="text-lg font-bold text-ink-900">Doctor Not Available</h1>
            <p className="mt-2 text-sm text-ink-600">
              We could not find active appointment schedules for this doctor. Please contact the
              hospital reception directly.
            </p>
            <div className="mt-6">
              <Link
                href="/"
                className="inline-block rounded-lg bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-700"
              >
                Go to Homepage
              </Link>
            </div>
          </Card>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ink-50 px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-xl mb-6 text-center">
        <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
          Online Appointment Booking
        </span>
        <h2 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl mt-1">
          Select Your Preferred Slot
        </h2>
        <p className="text-xs sm:text-sm text-ink-500 mt-1">
          Pick a time slot that suits you. The doctor will be notified to ensure availability.
        </p>
      </div>

      <BookSlotForm details={details} initialPhone={phone} locale={locale} />
    </main>
  );
}
