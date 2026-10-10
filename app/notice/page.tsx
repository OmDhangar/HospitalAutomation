import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert, Button, cn } from '@/components/ui';
import { getSessionState } from '@/lib/auth/session';
import { MONITORING_NOTICE, MONITORING_NOTICE_IS_DRAFT, isNoticeLocale, type NoticeLocale } from '@/lib/domain/monitoring-notice';
import { acceptNoticeAction } from './actions';

export const metadata = { title: 'Staff notice · QuriioHQ', robots: { index: false, follow: false } };

const LANGUAGES: { locale: NoticeLocale; label: string }[] = [
  { locale: 'mr', label: 'मराठी' },
  { locale: 'hi', label: 'हिंदी' },
  { locale: 'en', label: 'English' },
];

/**
 * The staff monitoring notice (IPD sheets plan §7.8), shown once per version
 * when the hospital requires it. Marathi first, as the pilot's staff read it.
 * Accepting is recorded with the language, the channel and the device.
 */
export default async function NoticePage({ searchParams }: PageProps<'/notice'>) {
  const session = await getSessionState();
  if (!session) redirect('/login');
  if (session.locked) redirect(session.channel === 'ward_device' ? '/ward-device' : '/unlock');
  const params = await searchParams;
  const requested = typeof params.lang === 'string' ? params.lang : 'mr';
  const locale: NoticeLocale = isNoticeLocale(requested) ? requested : 'mr';
  const text = MONITORING_NOTICE[locale];
  const devanagari = locale !== 'en';

  return (
    <main className="min-h-dvh bg-ink-100 px-4 py-8">
      <div className="mx-auto max-w-xl space-y-5">
        <nav aria-label="Language" className="flex gap-2">
          {LANGUAGES.map((language) => (
            <Link
              key={language.locale}
              href={`/notice?lang=${language.locale}`}
              className={cn(
                'inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold ring-1',
                language.locale === locale ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-ink-700 ring-ink-300',
              )}
            >
              {language.label}
            </Link>
          ))}
        </nav>
        {MONITORING_NOTICE_IS_DRAFT ? (
          <Alert tone="warn">Draft wording, awaiting the hospital’s legal review.</Alert>
        ) : null}
        <article className={cn('space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-xs', devanagari && 'font-deva')} lang={locale}>
          <h1 className="text-xl font-bold text-ink-900">{text.title}</h1>
          <ul className="list-disc space-y-3 pl-5 text-base leading-relaxed text-ink-800">
            {text.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          {session.readOnly ? (
            <p className="text-sm text-ink-500">Support sessions cannot accept on the staff member’s behalf.</p>
          ) : (
            <form action={acceptNoticeAction}>
              <input type="hidden" name="locale" value={locale} />
              <Button type="submit" variant="primary" size="lg" className="w-full">
                {text.accept}
              </Button>
            </form>
          )}
        </article>
      </div>
    </main>
  );
}
