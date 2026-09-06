import Link from 'next/link';
import { Button, Card } from '@/components/ui';
import { getSession } from '@/lib/auth/session';
import { DemoForm } from '@/components/marketing/demo-form';
import {
  DoctorDayMock,
  HeroVisual,
  MockNudge,
  MockPatientQueue,
  MockReception,
  MockWaitingRoom,
  MockWhatsAppHello,
  MockWhatsAppMenus,
} from '@/components/marketing/mockups';

export const metadata = {
  title: 'QueueCare — OPD Queue Management for Hospitals & Clinics',
  description:
    'Turn crowded hospital corridors into an orderly digital queue. WhatsApp booking, live queue links, and one-click reception calling.',
};

export default async function HomePage() {
  const session = await getSession();

  return (
    <div className="min-h-screen bg-white text-ink-900 selection:bg-brand-100 selection:text-brand-900">
      {/* ------------------------------------------------------------- Header */}
      <header className="sticky top-0 z-40 border-b border-ink-200/80 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 font-bold text-white shadow-sm">
              Q
            </span>
            <span className="text-lg font-bold tracking-tight text-ink-900">QueueCare</span>
          </Link>

          <nav className="hidden items-center gap-7 text-xs font-semibold text-ink-600 md:flex">
            <a href="#problem" className="hover:text-ink-900 transition-colors">
              The Problem
            </a>
            <a href="#how-it-works" className="hover:text-ink-900 transition-colors">
              How It Works
            </a>
            <a href="#benefits" className="hover:text-ink-900 transition-colors">
              Benefits
            </a>
            <a href="#faq" className="hover:text-ink-900 transition-colors">
              Questions
            </a>
          </nav>

          <div className="flex items-center gap-3">
            {session ? (
              <Link href="/dashboard">
                <Button variant="primary" size="sm">
                  Go to Dashboard →
                </Button>
              </Link>
            ) : (
              <>
                <Link href="/login" className="text-xs font-semibold text-ink-700 hover:text-ink-900">
                  Sign in
                </Link>
                <a href="#demo">
                  <Button variant="primary" size="sm">
                    Book Demo
                  </Button>
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------- Hero Section */}
      <section className="relative overflow-hidden border-b border-ink-200 bg-gradient-to-b from-brand-50/50 to-white px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-100/70 px-3 py-1 text-xs font-bold uppercase tracking-wider text-brand-800">
              Built for Small & Medium Hospitals
            </span>
            <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-ink-950 sm:text-5xl sm:leading-[1.15]">
              Empty the crowded corridor outside your consulting room.
            </h1>
            <p className="mt-5 text-base sm:text-lg text-ink-600 leading-relaxed">
              Patients message your hospital on WhatsApp, receive an instant token and live queue
              tracker, and wait outside in comfort. Reception advances the line with a single button.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <a href="#demo">
                <Button variant="primary" size="xl" className="shadow-sm">
                  Schedule a Hospital Demo
                </Button>
              </a>
              <a href="#how-it-works">
                <Button variant="secondary" size="xl">
                  See How It Works
                </Button>
              </a>
            </div>

            <p className="mt-3 text-xs text-ink-500">
              Works in Marathi, Hindi & English • Zero apps for patients to install
            </p>
          </div>

          <div className="mt-14">
            <HeroVisual />
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- The Problem */}
      <section id="problem" className="border-b border-ink-200 bg-ink-50/60 px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
              Behind the Consulting Door
            </span>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
              OPD days shouldn’t feel like managing a crowd.
            </h2>
          </div>

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                title: 'Constant Interruptions',
                desc: 'Consultations interrupted every few minutes by anxious relatives knocking to ask "how much longer?".',
                icon: '🚪',
              },
              {
                title: 'Stressed Reception',
                desc: 'Your receptionist spends their entire morning answering the exact same question instead of registering patients.',
                icon: '📞',
              },
              {
                title: 'Patients Stranded',
                desc: 'Families sit in crowded corridors for hours, afraid to step out for fresh air or tea lest they lose their turn.',
                icon: '⏳',
              },
              {
                title: 'Corridor Overcrowding',
                desc: 'By 10:30 am, corridors are packed, sick patients are standing, and tempers fray in the waiting area.',
                icon: '👥',
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm"
              >
                <span className="text-2xl" aria-hidden="true">
                  {item.icon}
                </span>
                <h3 className="mt-3 text-base font-bold text-ink-900">{item.title}</h3>
                <p className="mt-2 text-xs text-ink-600 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- How It Works */}
      <section id="how-it-works" className="border-b border-ink-200 px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center max-w-2xl mx-auto">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
              The Complete Flow
            </span>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
              How QueueCare runs your physical OPD smoothly
            </h2>
            <p className="mt-2 text-sm text-ink-600">
              A patient arrives digitally before arriving physically. Here is what happens from tap
              one to the consultation.
            </p>
          </div>

          <div className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {/* Step 1 */}
            <div className="flex flex-col items-center text-center">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 mb-3">
                1
              </span>
              <h3 className="text-base font-bold text-ink-900">Patient Messages on WhatsApp</h3>
              <p className="mt-1 mb-4 text-xs text-ink-600 max-w-xs">
                They message your hospital’s number or reception adds them in five seconds as a
                walk-in.
              </p>
              <div className="w-full mt-auto">
                <MockWhatsAppHello />
              </div>
            </div>

            {/* Step 2 */}
            <div className="flex flex-col items-center text-center">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 mb-3">
                2
              </span>
              <h3 className="text-base font-bold text-ink-900">Picks Doctor & Arrival Time</h3>
              <p className="mt-1 mb-4 text-xs text-ink-600 max-w-xs">
                Two simple taps on interactive menus. No forms to fill, no app download required.
              </p>
              <div className="w-full mt-auto">
                <MockWhatsAppMenus />
              </div>
            </div>

            {/* Step 3 */}
            <div className="flex flex-col items-center text-center">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 mb-3">
                3
              </span>
              <h3 className="text-base font-bold text-ink-900">Token & Live Queue Tracker</h3>
              <p className="mt-1 mb-4 text-xs text-ink-600 max-w-xs">
                Shows exact token number and how many patients are ahead. They can wait outside
                calmly.
              </p>
              <div className="w-full mt-auto">
                <MockPatientQueue />
              </div>
            </div>

            {/* Step 4 */}
            <div className="flex flex-col items-center text-center">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 mb-3">
                4
              </span>
              <h3 className="text-base font-bold text-ink-900">Waiting-Room Live Screen</h3>
              <p className="mt-1 mb-4 text-xs text-ink-600 max-w-xs">
                A simple TV or tablet display in your waiting room displays current tokens only —
                never names.
              </p>
              <div className="w-full mt-auto">
                <MockWaitingRoom />
              </div>
            </div>

            {/* Step 5 */}
            <div className="flex flex-col items-center text-center">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 mb-3">
                5
              </span>
              <h3 className="text-base font-bold text-ink-900">Reception Presses Call Next</h3>
              <p className="mt-1 mb-4 text-xs text-ink-600 max-w-xs">
                One large button. The patient is marked called, the screen updates, and the timer
                starts.
              </p>
              <div className="w-full mt-auto">
                <MockReception />
              </div>
            </div>

            {/* Step 6 */}
            <div className="flex flex-col items-center text-center">
              <span className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800 mb-3">
                6
              </span>
              <h3 className="text-base font-bold text-ink-900">Automated WhatsApp Nudge</h3>
              <p className="mt-1 mb-4 text-xs text-ink-600 max-w-xs">
                When only two patients remain ahead, QueueCare messages them automatically to return.
              </p>
              <div className="w-full mt-auto">
                <MockNudge />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- Benefits Breakdown */}
      <section id="benefits" className="border-b border-ink-200 bg-ink-50/50 px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="text-center max-w-2xl mx-auto mb-12">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
              Designed for Everyone
            </span>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
              What each person gains from day one
            </h2>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            {/* The Doctor */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm flex flex-col justify-between">
              <div>
                <div className="inline-flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 font-bold text-lg mb-4">
                  🩺
                </div>
                <h3 className="text-lg font-bold text-ink-900">The Doctor</h3>
                <p className="mt-1 text-xs text-ink-600">
                  Peace of mind and honest insight into your OPD flow.
                </p>

                <ul className="mt-5 space-y-2.5 text-xs text-ink-700">
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>See your live queue right on your phone between patients</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>No interruptions or knocks asking for wait estimates</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>Accurate daily metrics: patients seen, median wait & consult times</span>
                  </li>
                </ul>
              </div>

              <div className="mt-6 pt-4 border-t border-ink-100">
                <DoctorDayMock />
              </div>
            </div>

            {/* Reception */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm flex flex-col justify-between">
              <div>
                <div className="inline-flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 font-bold text-lg mb-4">
                  💻
                </div>
                <h3 className="text-lg font-bold text-ink-900">Reception Staff</h3>
                <p className="mt-1 text-xs text-ink-600">
                  Less friction, no paper registers, and calm interactions.
                </p>

                <ul className="mt-5 space-y-2.5 text-xs text-ink-700">
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>Single button to advance queue: <strong>Call next patient</strong></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>Fast walk-in entry: just name and 10-digit mobile number</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>Zero repetitive arguments over who arrived first</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>Staff trained in under 15 minutes</span>
                  </li>
                </ul>
              </div>

              <div className="mt-6 rounded-xl bg-ink-50 p-4 border border-ink-200 text-xs text-ink-600">
                <p className="font-semibold text-ink-900">Reception Feedback:</p>
                <p className="mt-1 leading-relaxed">
                  Instead of fielding 50 questions an hour about delays, staff focus entirely on
                  welcoming patients and collecting fees.
                </p>
              </div>
            </div>

            {/* The Patient */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm flex flex-col justify-between">
              <div>
                <div className="inline-flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 font-bold text-lg mb-4">
                  📱
                </div>
                <h3 className="text-lg font-bold text-ink-900">The Patient & Family</h3>
                <p className="mt-1 text-xs text-ink-600">Dignity, clarity, and respect for their time.</p>

                <ul className="mt-5 space-y-2.5 text-xs text-ink-700">
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>No mobile application to download or account to register</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>Available in their mother tongue: Marathi, Hindi, or English</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>Live countdown so they know when to step back into the hospital</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✓</span>
                    <span>No need to stand in hot, crowded hallways</span>
                  </li>
                </ul>
              </div>

              <div className="mt-6 rounded-xl bg-brand-50/70 p-4 border border-brand-200 text-xs text-brand-900">
                <p className="font-semibold">Inclusive by Design:</p>
                <p className="mt-1 leading-relaxed">
                  Works on basic Android phones, 2G/3G connections, and for walk-ins without any
                  smartphone at all.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------- For Solo Doctors */}
      <section className="border-b border-ink-200 px-4 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto max-w-4xl rounded-2xl bg-ink-900 p-8 text-white shadow-lg sm:p-12">
          <div className="max-w-2xl">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-300">
              For Solo Practitioners & Small Clinics
            </span>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              No receptionist? QueueCare runs straight from your phone.
            </h2>
            <p className="mt-3 text-sm text-ink-300 leading-relaxed">
              If you practice solo or operate an evening clinic without staff, patients still book
              on WhatsApp or scan a QR code at your entrance. Between consultations, simply tap
              &quot;Next&quot; from your mobile browser to call the next patient.
            </p>
            <div className="mt-6">
              <a href="#demo">
                <Button variant="primary" size="lg">
                  Request a Clinic Demo
                </Button>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- Plain Answers */}
      <section id="faq" className="border-b border-ink-200 bg-ink-50/40 px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-4xl">
          <div className="text-center mb-12">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
              Straight Answers
            </span>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
              Frequently asked questions
            </h2>
          </div>

          <div className="space-y-4">
            {[
              {
                q: 'Do patients need to download any application?',
                a: 'No. Patients interact completely through WhatsApp and open a lightweight web page that loads in under 2 seconds on any budget smartphone.',
              },
              {
                q: 'What languages are supported?',
                a: 'Marathi, Hindi, and English are fully supported out of the box, with Devanagari typography bundled for crisp readability.',
              },
              {
                q: 'What happens when internet connection drops?',
                a: 'QueueCare is resilient. If your local internet drops, the queue numbers already issued remain valid, and reception can continue via paper fallback or offline queue sync.',
              },
              {
                q: 'What patient data is stored?',
                a: 'We strictly follow privacy-by-design. We only store a patient’s name and phone number to message their token. We never ask for or store clinical diagnoses, medical history, or prescriptions.',
              },
              {
                q: 'Does it replace our existing hospital software?',
                a: 'No. QueueCare is a dedicated queue tool that sits alongside your existing HMIS, billing, or paper registers without disrupting your clinical workflows.',
              },
              {
                q: 'How long does staff training take?',
                a: 'Fifteen minutes. The reception interface consists of essentially one primary button: Call Next. If staff know how to use a phone, they can operate QueueCare immediately.',
              },
            ].map((faq) => (
              <div
                key={faq.q}
                className="rounded-xl border border-ink-200 bg-white p-5 shadow-sm"
              >
                <h3 className="text-sm font-bold text-ink-900">{faq.q}</h3>
                <p className="mt-2 text-xs text-ink-600 leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Demo Form */}
      <section id="demo" className="px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-xl">
          <div className="text-center mb-8">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
              Get Started
            </span>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
              See QueueCare in action
            </h2>
            <p className="mt-2 text-xs sm:text-sm text-ink-600">
              Fill out this 1-minute form. We will call you to schedule a quick 10-minute demo for
              your hospital or clinic.
            </p>
          </div>

          <Card className="p-6 sm:p-8 shadow-[var(--shadow-raised)]">
            <DemoForm />
          </Card>
        </div>
      </section>

      {/* ------------------------------------------------------------- Footer */}
      <footer className="border-t border-ink-200 bg-ink-900 py-12 text-ink-400">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <div>
              <p className="text-sm font-bold text-white">QueueCare</p>
              <p className="text-xs text-ink-400 mt-0.5">
                OPD queue and patient flow management for Indian hospitals.
              </p>
            </div>

            <div className="flex items-center gap-6 text-xs">
              <Link href="/login" className="hover:text-white transition-colors">
                Hospital Sign In
              </Link>
              <Link href="/book" className="hover:text-white transition-colors">
                Patient Slot Booking
              </Link>
              <a href="#demo" className="hover:text-white transition-colors">
                Request Demo
              </a>
            </div>
          </div>

          <div className="mt-8 border-t border-ink-800 pt-6 text-center text-[11px] text-ink-500">
            © {new Date().getFullYear()} QueueCare. All rights reserved. Privacy by design.
          </div>
        </div>
      </footer>
    </div>
  );
}
