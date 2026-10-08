'use server';
import { z } from 'zod';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import { isLocale, type Locale } from '@/lib/i18n/patient';
import { clientIp, consumeThrottle, ipRules } from '@/lib/security/throttle';
import { bookScheduledSlot, BookingError } from '@/lib/services/web-booking';

const HOUR_MS = 60 * 60 * 1000;

const bookSlotSchema = z.object({
  hospitalId: z.string().uuid(),
  doctorId: z.string().uuid(),
  patientName: z.string().trim().min(2, 'Name is required (at least 2 characters)'),
  patientAge: z.coerce.number().int().min(0).max(125).optional(),
  phone: z.string().trim().min(10, 'Valid phone number is required'),
  slotDatetimeIso: z.string().datetime(),
  locale: z.string().optional(),
});

export type BookSlotResult =
  | {
    ok: true;
    /** "S3" for an evening slot-session booking, the plain number otherwise. */
    tokenNumber: string;
    publicToken: string;
    slotTimeFormatted: string;
    doctorName: string;
    patientName: string;
    patientAge?: number | null;
  }
  | {
    ok: false;
    error: string;
  };

export async function submitSlotBooking(formData: FormData): Promise<BookSlotResult> {
  const parsed = bookSlotSchema.safeParse({
    hospitalId: formData.get('hospitalId'),
    doctorId: formData.get('doctorId'),
    patientName: formData.get('patientName'),
    patientAge: formData.get('patientAge') ? formData.get('patientAge') : undefined,
    phone: formData.get('phone'),
    slotDatetimeIso: formData.get('slotDatetimeIso'),
    locale: formData.get('locale'),
  });

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid input provided';
    return { ok: false, error: message };
  }

  const phoneE164 = normalizeIndianPhone(parsed.data.phone);
  if (!phoneE164) {
    return { ok: false, error: 'Please enter a valid 10-digit Indian mobile number' };
  }

  const locale: Locale = isLocale(parsed.data.locale) ? parsed.data.locale : 'en';

  /**
   * This form is public and every booking it accepts sends WhatsApp messages
   * to the number typed in — so unthrottled, it was a way to make us message
   * any Indian number on our bill, at whatever rate a script could manage,
   * until recipients reported the number and Meta restricted it for every
   * hospital on it.
   *
   * Counted in the database, per phone (a real patient books once or twice a
   * day) and per IP (a script cycling numbers still comes from somewhere). A
   * family booking for several members from one phone fits comfortably.
   */
  const allowed = await consumeThrottle([
    { key: `book:phone:${phoneE164}`, limit: 4, windowMs: 24 * HOUR_MS },
    ...ipRules(await clientIp(), { prefix: 'book:ip', limit: 10, windowMs: HOUR_MS }),
  ]);
  if (!allowed) {
    return {
      ok: false,
      error: 'Too many bookings from here. Please call the hospital to book.',
    };
  }

  try {
    const result = await bookScheduledSlot({
      hospitalId: parsed.data.hospitalId,
      doctorId: parsed.data.doctorId,
      patientName: parsed.data.patientName,
      patientAge: parsed.data.patientAge,
      phoneE164,
      slotDatetimeIso: parsed.data.slotDatetimeIso,
      locale,
    });

    return {
      ok: true,
      tokenNumber: result.tokenLabel,
      publicToken: result.publicToken,
      slotTimeFormatted: result.slotTimeFormatted,
      doctorName: result.doctorName,
      patientName: result.patientName,
      patientAge: result.patientAge,
    };
  } catch (err) {
    // Only a refusal written for patients is shown to one. Anything else is
    // logged and answered in general: a raw database error names tables and
    // constraints, and this page is open to anyone.
    if (err instanceof BookingError) return { ok: false, error: err.message };
    console.error('Failed to book slot:', err);
    return { ok: false, error: 'Unable to book this slot. Please try another slot.' };
  }
}
