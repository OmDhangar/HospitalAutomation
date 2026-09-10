'use server';
import { z } from 'zod';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import { isLocale, type Locale } from '@/lib/i18n/patient';
import { bookScheduledSlot } from '@/lib/services/web-booking';

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
    tokenNumber: number;
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
      tokenNumber: result.tokenNumber,
      publicToken: result.publicToken,
      slotTimeFormatted: result.slotTimeFormatted,
      doctorName: result.doctorName,
      patientName: result.patientName,
      patientAge: result.patientAge,
    };
  } catch (err) {
    console.error('Failed to book slot:', err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to book this slot. Please try another slot.',
    };
  }
}
