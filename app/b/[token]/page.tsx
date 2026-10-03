import { formatRupees } from '@/lib/domain/billing';
import { formatTimeIn } from '@/lib/domain/time';
import { getPublicBill } from '@/lib/services/discharge-billing';

export const metadata = { title: 'Hospital bill', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

type Lang = 'en' | 'hi' | 'mr';

/** The few words this page needs, in the three languages the hospital uses. */
const T: Record<Lang, Record<string, string>> = {
  en: {
    title: 'Hospital bill',
    running: 'Running bill — items are added as they are given.',
    final: 'Final bill',
    missing: 'This bill link is not valid.',
    missingHint: 'Check the link, or ask the hospital for a new one.',
    expired: 'This bill link has expired.',
    expiredHint: 'Ask the hospital for a copy of the bill.',
    total: 'Bill total',
    payer: 'Paid by',
    paid: 'Paid so far',
    balance: 'Balance',
    refund: 'Refund due',
    dayTotal: 'Day total',
    empty: 'Nothing has been charged yet.',
  },
  hi: {
    title: 'अस्पताल बिल',
    running: 'चालू बिल — दवाएँ और सामान देने पर जुड़ते जाते हैं।',
    final: 'अंतिम बिल',
    missing: 'यह बिल लिंक सही नहीं है।',
    missingHint: 'लिंक जाँचें, या अस्पताल से नया लिंक माँगें।',
    expired: 'इस बिल लिंक की अवधि समाप्त हो गई है।',
    expiredHint: 'बिल की प्रति के लिए अस्पताल से संपर्क करें।',
    total: 'कुल बिल',
    payer: 'भुगतानकर्ता',
    paid: 'अब तक भुगतान',
    balance: 'बकाया',
    refund: 'वापसी',
    dayTotal: 'दिन का कुल',
    empty: 'अभी तक कुछ नहीं जुड़ा है।',
  },
  mr: {
    title: 'रुग्णालय बिल',
    running: 'चालू बिल — औषधे व साहित्य दिल्यावर जोडले जाते.',
    final: 'अंतिम बिल',
    missing: 'ही बिल लिंक योग्य नाही.',
    missingHint: 'लिंक तपासा, किंवा रुग्णालयाकडून नवीन लिंक मागा.',
    expired: 'या बिल लिंकची मुदत संपली आहे.',
    expiredHint: 'बिलाच्या प्रतीसाठी रुग्णालयाशी संपर्क साधा.',
    total: 'एकूण बिल',
    payer: 'देयक',
    paid: 'आतापर्यंत भरले',
    balance: 'बाकी',
    refund: 'परतावा',
    dayTotal: 'दिवसाची एकूण रक्कम',
    empty: 'अद्याप काहीही जोडलेले नाही.',
  },
};

/**
 * The family's running bill (IPD plan §T2.4): public, opened from a WhatsApp
 * link, like the queue page. The same day-wise list the desk sees — without
 * who recorded anything, without removed lines, without any clinical note.
 */
export default async function PublicBillPage({ params, searchParams }: PageProps<'/b/[token]'>) {
  const { token } = await params;
  const query = await searchParams;
  const lang: Lang = query.lang === 'hi' || query.lang === 'mr' ? query.lang : 'en';
  const s = T[lang];
  const bill = await getPublicBill(token);

  return (
    <main className="min-h-dvh bg-ink-100 px-4 py-6">
      <div className="mx-auto max-w-lg space-y-4">
        <nav className="flex justify-end gap-1 text-sm" aria-label="Language">
          {(['en', 'hi', 'mr'] as const).map((code) => (
            <a
              key={code}
              href={`?lang=${code}`}
              aria-current={lang === code ? 'true' : undefined}
              className={lang === code ? 'rounded-md bg-white px-2.5 py-1.5 font-semibold text-ink-900 shadow-xs' : 'px-2.5 py-1.5 text-ink-600'}
            >
              {code === 'en' ? 'English' : code === 'hi' ? 'हिंदी' : 'मराठी'}
            </a>
          ))}
        </nav>

        {bill.state !== 'live' ? (
          <section className="rounded-2xl bg-white p-6 text-center shadow-xs">
            {bill.state === 'expired' ? <p className="mb-2 text-sm text-ink-500">{bill.hospitalName}</p> : null}
            <h1 className="text-lg font-bold text-ink-900">{bill.state === 'expired' ? s.expired : s.missing}</h1>
            <p className="mt-1 text-ink-600">{bill.state === 'expired' ? s.expiredHint : s.missingHint}</p>
          </section>
        ) : (
          <>
            <section className="rounded-2xl bg-white p-5 shadow-xs">
              <p className="text-sm text-ink-500">{bill.hospitalName}</p>
              <h1 className="text-xl font-bold text-ink-900">{bill.patientName}</h1>
              <p className="mt-1 text-sm text-ink-600">
                {bill.billNumber ? `${s.final} · ${bill.billNumber}` : s.running}
              </p>
            </section>

            <section className="overflow-hidden rounded-2xl bg-white shadow-xs">
              {bill.lines.length === 0 ? (
                <p className="p-5 text-ink-600">{s.empty}</p>
              ) : (
                groupDays(bill.lines).map((day) => (
                  <div key={day.date}>
                    <h2 className="flex justify-between bg-ink-50 px-4 py-2 text-sm font-bold text-ink-700">
                      <span>
                        {new Intl.DateTimeFormat(lang === 'en' ? 'en-IN' : `${lang}-IN`, {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                          timeZone: 'UTC',
                        }).format(new Date(`${day.date}T00:00:00Z`))}
                      </span>
                      <span className="numeric">{formatRupees(day.totalPaise)}</span>
                    </h2>
                    <ul className="divide-y divide-ink-100">
                      {day.lines.map((line, index) => (
                        <li key={index} className="flex justify-between gap-3 px-4 py-2.5 text-base">
                          <span className="min-w-0">
                            {line.at ? <span className="numeric mr-2 text-sm text-ink-500">{formatTimeIn(bill.timezone, line.at)}</span> : null}
                            {line.description} <span className="numeric text-ink-500">× {line.quantity}</span>
                          </span>
                          <span className="numeric shrink-0">{formatRupees(line.totalPaise)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </section>

            <section className="rounded-2xl bg-white p-5 text-base shadow-xs">
              <Line label={s.total} value={formatRupees(bill.totals.totalPaise)} strong />
              {bill.split.payerSharePaise > 0 ? (
                <Line label={`${s.payer}: ${bill.payerName ?? ''}`} value={`− ${formatRupees(bill.split.payerSharePaise)}`} />
              ) : null}
              <Line label={s.paid} value={`− ${formatRupees(bill.split.paidPaise)}`} />
              <Line
                label={bill.split.balancePaise < 0 ? s.refund : s.balance}
                value={formatRupees(Math.abs(bill.split.balancePaise))}
                strong
              />
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className={strong ? 'flex justify-between py-1.5 text-lg font-bold text-ink-900' : 'flex justify-between py-1 text-ink-700'}>
      <span>{label}</span>
      <span className="numeric">{value}</span>
    </p>
  );
}

function groupDays<T extends { day: string; totalPaise: number }>(lines: readonly T[]) {
  const days = new Map<string, { date: string; lines: T[]; totalPaise: number }>();
  for (const line of lines) {
    const day = days.get(line.day) ?? { date: line.day, lines: [], totalPaise: 0 };
    day.lines.push(line);
    day.totalPaise += line.totalPaise;
    days.set(line.day, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
