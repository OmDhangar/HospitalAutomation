'use server';

import { isHoneypotFilled, parseDemoRequest } from '@/lib/domain/demo-request';
import { createDemoRequest } from '@/lib/services/demo-requests';

export type DemoFormState =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; message: string };

export async function submitDemoRequest(
  _prev: DemoFormState,
  formData: FormData,
): Promise<DemoFormState> {
  if (isHoneypotFilled(formData.get('website'))) {
    return { status: 'ok' };
  }

  const parsed = parseDemoRequest({
    name: formData.get('name'),
    organisation: formData.get('organisation'),
    phone: formData.get('phone'),
    city: formData.get('city'),
    patientsPerDay: formData.get('patientsPerDay'),
  });

  if (!parsed.ok) {
    return { status: 'error', message: parsed.error };
  }

  const result = await createDemoRequest(parsed.value);
  if (!result.ok) {
    return {
      status: 'error',
      message: 'This number has already sent a few requests today. We will call you shortly.',
    };
  }

  return { status: 'ok' };
}
