'use client';

import { useActionState } from 'react';
import { submitDemoRequest, type DemoFormState } from '@/app/(marketing)/actions';
import { Button, Field, Input, Alert } from '@/components/ui';

const initialState: DemoFormState = { status: 'idle' };

export function DemoForm() {
  const [state, formAction, isPending] = useActionState(submitDemoRequest, initialState);

  if (state.status === 'ok') {
    return (
      <div className="rounded-2xl border border-brand-200 bg-brand-50/70 p-6 text-center sm:p-8">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-brand-600 text-xl font-bold text-white mb-3">
          ✓
        </span>
        <h3 className="text-xl font-bold text-ink-900">Demo Request Received</h3>
        <p className="mt-2 text-sm text-ink-600 leading-relaxed max-w-md mx-auto">
          Thank you! We will call you on your mobile number today to schedule a brief 10-minute
          walkthrough of QueueCare for your hospital or clinic.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

      {/* Honeypot for spam bots */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input type="text" id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <Field label="Your Name">
        <Input name="name" required placeholder="Dr. Satish Kulkarni" autoComplete="name" />
      </Field>

      <Field label="Hospital or Clinic Name">
        <Input
          name="organisation"
          required
          placeholder="Kulkarni Multispeciality Hospital"
          autoComplete="organization"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile Number" hint="WhatsApp number preferred">
          <Input
            type="tel"
            name="phone"
            required
            placeholder="98765 43210"
            autoComplete="tel"
            inputMode="numeric"
          />
        </Field>

        <Field label="City / Town">
          <Input name="city" required placeholder="Satara, Maharashtra" autoComplete="address-level2" />
        </Field>
      </div>

      <div>
        <label htmlFor="patientsPerDay" className="block text-sm font-medium text-ink-900 mb-1.5">
          Expected OPD Patients per Day <span className="text-brand-700">*</span>
        </label>
        <select
          id="patientsPerDay"
          name="patientsPerDay"
          required
          className="w-full rounded-xl border border-ink-200 bg-white px-3.5 py-2.5 text-sm text-ink-900 shadow-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
          defaultValue=""
        >
          <option value="" disabled>
            Select approximate daily patients
          </option>
          <option value="under 50">Under 50 patients / day</option>
          <option value="50-100">50 to 100 patients / day</option>
          <option value="100-200">100 to 200 patients / day</option>
          <option value="over 200">Over 200 patients / day</option>
        </select>
      </div>

      <p className="text-[11px] text-ink-500 pt-1 leading-tight">
        No credit card required. Zero software to install. We will call you to arrange your demo.
      </p>

      <Button
        type="submit"
        variant="primary"
        size="xl"
        className="w-full mt-2"
        disabled={isPending}
      >
        {isPending ? 'Sending Request...' : 'Schedule Hospital Demo'}
      </Button>
    </form>
  );
}
