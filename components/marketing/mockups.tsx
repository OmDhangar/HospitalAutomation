import type { ReactNode } from 'react';
import { Button, StatusPill, cn } from '@/components/ui';

export function PhoneFrame({
  children,
  caption,
  className,
}: {
  children: ReactNode;
  caption?: string;
  className?: string;
}) {
  return (
    <figure className={cn('mx-auto w-full max-w-[280px]', className)}>
      <div className="overflow-hidden rounded-[1.75rem] border-[10px] border-ink-900 bg-ink-50 shadow-[var(--shadow-raised)]">
        <div className="flex h-7 items-center justify-center bg-ink-900">
          <span className="h-1.5 w-16 rounded-full bg-ink-700" aria-hidden />
        </div>
        {children}
      </div>
      {caption ? (
        <figcaption className="mt-3 text-center text-xs text-ink-500">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

export function WhatsAppHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 bg-brand-800 px-3 py-2 text-white">
      <span className="flex size-7 items-center justify-center rounded-full bg-brand-600 text-xs font-bold">
        Q
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold">{title}</p>
        <p className="text-[10px] text-brand-100">WhatsApp</p>
      </div>
    </div>
  );
}

function Bubble({
  children,
  from = 'them',
}: {
  children: ReactNode;
  from?: 'them' | 'us';
}) {
  return (
    <div
      className={cn(
        'max-w-[92%] rounded-lg px-2.5 py-2 text-[11px] leading-snug shadow-sm',
        from === 'them'
          ? 'rounded-tl-sm bg-white text-ink-800'
          : 'ml-auto rounded-tr-sm bg-brand-50 text-ink-800',
      )}
    >
      {children}
    </div>
  );
}

function MenuRow({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-2.5 py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-ink-900">{label}</p>
        {hint ? <p className="text-[10px] text-ink-500">{hint}</p> : null}
      </div>
      <span className="text-[10px] text-brand-700" aria-hidden>
        ›
      </span>
    </div>
  );
}

/** Step 1 — patient messages the hospital. */
export function MockWhatsAppHello() {
  return (
    <PhoneFrame caption="The patient already has WhatsApp.">
      <WhatsAppHeader title="Patil Hospital" />
      <div className="space-y-2 bg-[#ece5dd] px-2 py-3">
        <Bubble from="us">Hi</Bubble>
        <Bubble>
          <span className="font-deva">कृपया तुमची भाषा निवडा</span>
          <div className="mt-2 overflow-hidden rounded-md bg-white ring-1 ring-ink-200">
            <MenuRow label="मराठी" />
            <MenuRow label="हिंदी" />
            <MenuRow label="English" />
          </div>
        </Bubble>
      </div>
    </PhoneFrame>
  );
}

/** Step 2 — doctor and time from tappable menus. */
export function MockWhatsAppMenus() {
  return (
    <PhoneFrame caption="Two taps. No form, no app.">
      <WhatsAppHeader title="Patil Hospital" />
      <div className="space-y-2 bg-[#ece5dd] px-2 py-3">
        <Bubble>
          Which doctor would you like to see?
          <div className="mt-2 overflow-hidden rounded-md bg-white ring-1 ring-ink-200">
            <MenuRow label="Dr. S. Patil" hint="Physician" />
            <MenuRow label="Dr. A. Deshmukh" hint="Paediatrics" />
          </div>
        </Bubble>
        <Bubble>
          When are you coming in?
          <div className="mt-2 overflow-hidden rounded-md bg-white ring-1 ring-ink-200">
            <MenuRow label="Coming now" />
            <MenuRow label="Later today" />
          </div>
        </Bubble>
      </div>
    </PhoneFrame>
  );
}

/** Step 3 — token + live queue link. */
export function MockPatientQueue() {
  return (
    <PhoneFrame caption="Token 47. Three people ahead. No app to install.">
      <div className="bg-ink-50 px-3 py-3">
        <div className="mb-2 flex justify-center gap-1">
          <span className="rounded-full bg-ink-900 px-2 py-0.5 text-[9px] font-medium text-white">
            English
          </span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[9px] font-medium text-ink-600 ring-1 ring-ink-200">
            मराठी
          </span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[9px] font-medium text-ink-600 ring-1 ring-ink-200">
            हिंदी
          </span>
        </div>
        <div className="rounded-xl bg-white p-4 text-center ring-1 ring-ink-200">
          <p className="numeric text-4xl font-bold leading-none text-brand-700">3</p>
          <p className="mt-1.5 text-[11px] font-medium text-ink-600">patients ahead of you</p>
        </div>
        <div className="mt-2 flex items-center justify-between rounded-xl bg-ink-900 px-3 py-2.5">
          <span className="text-[10px] font-medium text-ink-300">Your token number</span>
          <span className="numeric text-xl font-bold text-white">47</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <div className="rounded-xl border border-ink-200 bg-white px-2 py-2 text-center">
            <p className="text-[9px] font-medium text-ink-500">Now serving</p>
            <p className="numeric text-lg font-bold text-ink-900">44</p>
          </div>
          <div className="rounded-xl border border-ink-200 bg-white px-2 py-2 text-center">
            <p className="text-[9px] font-medium text-ink-500">Doctor</p>
            <p className="text-[11px] font-bold text-ink-900">Dr. Patil</p>
          </div>
        </div>
        <p className="mt-2 px-1 text-center text-[10px] leading-snug text-ink-500">
          You can wait outside. We will message you when your turn is close.
        </p>
      </div>
    </PhoneFrame>
  );
}

/** Step 4 — waiting-room display. */
export function MockWaitingRoom() {
  return (
    <div className="overflow-hidden rounded-2xl bg-ink-900 p-4 text-white shadow-[var(--shadow-raised)] ring-1 ring-white/10 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between border-b border-white/10 pb-3">
        <div>
          <p className="text-sm font-semibold sm:text-lg">Patil Hospital</p>
          <p className="text-xs text-white/50">Main OPD</p>
        </div>
        <p className="numeric text-sm font-semibold text-white/70 sm:text-lg">10:42 am</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <p className="text-sm font-medium text-white/70">Dr. S. Patil</p>
          <p className="numeric mt-2 text-5xl font-bold leading-none text-brand-300">44</p>
          <dl className="mt-3 flex gap-6 border-t border-white/10 pt-3 text-white/60">
            <div>
              <dt className="text-[10px]">Waiting</dt>
              <dd className="numeric text-lg font-semibold text-white">12</dd>
            </div>
            <div>
              <dt className="text-[10px]">Seen today</dt>
              <dd className="numeric text-lg font-semibold text-white">31</dd>
            </div>
          </dl>
        </div>
        <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <p className="text-sm font-medium text-white/70">Dr. A. Deshmukh</p>
          <p className="numeric mt-2 text-5xl font-bold leading-none text-brand-300">18</p>
          <dl className="mt-3 flex gap-6 border-t border-white/10 pt-3 text-white/60">
            <div>
              <dt className="text-[10px]">Waiting</dt>
              <dd className="numeric text-lg font-semibold text-white">6</dd>
            </div>
            <div>
              <dt className="text-[10px]">Seen today</dt>
              <dd className="numeric text-lg font-semibold text-white">14</dd>
            </div>
          </dl>
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-white/40">Token numbers only — never names.</p>
    </div>
  );
}

/** Step 5 — reception Call next. */
export function MockReception() {
  return (
    <div className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between border-b border-ink-200 px-4 py-2.5">
        <p className="text-sm font-semibold text-ink-900">Now serving</p>
        <p className="text-xs text-ink-500">Dr. S. Patil</p>
      </div>
      <div className="flex items-center gap-4 p-4">
        <div className="pulse-ring flex size-16 shrink-0 items-center justify-center rounded-2xl bg-brand-600 text-white sm:size-20">
          <span className="numeric text-3xl font-bold sm:text-4xl">44</span>
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-ink-900">Ramesh Kulkarni</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusPill status="CALLED" />
            <span className="text-xs text-ink-500">called 1 min ago</span>
          </div>
        </div>
      </div>
      <div className="border-t border-ink-200 bg-ink-50 px-4 py-3">
        <Button type="button" variant="primary" size="lg" tabIndex={-1} className="pointer-events-none">
          Call next patient
        </Button>
      </div>
      <ul className="divide-y divide-ink-200">
        {[
          { token: 45, name: 'Savitri Jadhav', pos: 1 },
          { token: 46, name: 'Imran Shaikh', pos: 2 },
          { token: 47, name: 'Meena Joshi', pos: 3 },
        ].map((row) => (
          <li key={row.token} className="flex items-center gap-3 px-4 py-2.5">
            <span className="numeric w-8 text-base font-semibold text-ink-900">{row.token}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink-800">{row.name}</p>
              <p className="text-xs text-ink-500">#{row.pos} in line</p>
            </div>
            <StatusPill status="WAITING" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Step 6 — nudge when close. */
export function MockNudge() {
  return (
    <PhoneFrame caption="They come back when it is actually their turn.">
      <WhatsAppHeader title="Patil Hospital" />
      <div className="space-y-2 bg-[#ece5dd] px-2 py-3">
        <Bubble>
          Only 2 patients are ahead of you (Dr. S. Patil). Please return to the hospital.
        </Bubble>
      </div>
    </PhoneFrame>
  );
}

/** Hero pairing: patient phone + a slice of reception. */
export function HeroVisual() {
  return (
    <div className="relative mx-auto grid max-w-2xl items-end gap-4 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)] sm:gap-6">
      <MockPatientQueue />
      <div className="hidden sm:block">
        <MockReception />
      </div>
    </div>
  );
}

export function DoctorDayMock() {
  return (
    <div className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-ink-200 px-4 py-2.5">
        <p className="text-sm font-semibold text-ink-900">Today</p>
        <p className="text-xs text-ink-500">Your queue, on your phone</p>
      </div>
      <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200">
        <div className="px-4 py-3">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
            Patients seen
          </dt>
          <dd className="numeric mt-1 text-2xl font-semibold text-brand-700">31</dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-ink-500">No shows</dt>
          <dd className="numeric mt-1 text-2xl font-semibold text-ink-900">2</dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
            Median wait
          </dt>
          <dd className="numeric mt-1 text-2xl font-semibold text-ink-900">18m</dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
            Median consult
          </dt>
          <dd className="numeric mt-1 text-2xl font-semibold text-ink-900">9m</dd>
        </div>
      </dl>
    </div>
  );
}
