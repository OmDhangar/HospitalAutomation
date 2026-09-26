import Link from 'next/link';
import { Suspense } from 'react';
import { ToastProvider } from '@/components/toast';
import { ExpiryBanner } from '@/components/expiry-banner';
import { MobileNav, type NavItem } from '@/components/mobile-nav';
import { getSession, requireSession } from '@/lib/auth/session';
import { daysUntilExpiry, expiryBucket } from '@/lib/domain/subscription';
import { getCurrentSubscription } from '@/lib/services/subscriptions';
import { signOutAction } from './dashboard/actions';

/**
 * The header reads the session cookie to display user info and role-based
 * nav links. Wrapping it in Suspense allows the layout shell (and the
 * loading.tsx skeleton for the page) to render instantly while the session
 * is resolved. The redirect-to-login guard still fires during streaming.
 */
async function AppHeader() {
  const session = await requireSession();

  const navItems: NavItem[] = [
    { label: 'Queue', href: '/dashboard' },
    { label: 'Reports', href: '/reports' },
  ];

  if (session.role === 'owner') {
    navItems.push(
      { label: 'Subscription', href: '/subscription' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Activity', href: '/audit' },
      { label: 'Settings', href: '/settings' },
    );
  }

  if (session.isPlatformAdmin) {
    navItems.push({ label: 'Platform', href: '/admin' });
  }

  return (
    <header className="sticky top-0 z-40 border-b border-ink-200 bg-white shadow-xs">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-3 px-3.5 sm:px-6">
        <Link href="/dashboard" className="flex items-center gap-2.5 min-w-0 max-w-[70vw] sm:max-w-none">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white shadow-xs">
            Q
          </span>
          <span className="truncate text-sm font-bold text-ink-900">
            {session.hospitalName}
          </span>
        </Link>

        {/* Desktop Nav */}
        <nav className="ml-4 hidden items-center gap-1 sm:flex">
          {navItems.map((item) => (
            <NavLink key={item.href} href={item.href}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium leading-tight text-ink-800">
              {session.name}
            </p>
            <p className="text-xs capitalize leading-tight text-ink-500">
              {session.role}
            </p>
          </div>
          <form action={signOutAction} className="hidden sm:block">
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 cursor-pointer"
            >
              Sign out
            </button>
          </form>

          {/* Mobile Hamburger Navigation */}
          <MobileNav
            items={navItems}
            userName={session.name}
            userRole={session.role}
            hospitalName={session.hospitalName}
            signOutAction={signOutAction}
          />
        </div>
      </div>
    </header>
  );
}

/**
 * Reads the current subscription and renders the expiry strip.
 *
 * Its own component so the query lives inside the Suspense boundary above and
 * cannot delay the page shell. Returns nothing at all when the renewal is more
 * than thirty days out, which is the common case.
 */
async function PlanExpiryNotice() {
  const session = await getSession();
  if (!session) return null;

  const subscription = await getCurrentSubscription(session.hospitalId);
  if (!subscription) return null;

  const now = new Date();

  return (
    <ExpiryBanner
      bucket={expiryBucket(subscription.endsAt, now)}
      daysRemaining={daysUntilExpiry(subscription.endsAt, now)}
      canRenew={session.role === 'owner'}
    />
  );
}

/** Lightweight placeholder while the session resolves. */
function HeaderSkeleton() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink-200 bg-white">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-3 px-3.5 sm:px-6">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            Q
          </span>
          <div className="h-4 w-28 animate-pulse rounded bg-ink-200" />
        </div>

        <nav className="ml-4 hidden items-center gap-1 sm:flex">
          <div className="h-4 w-12 animate-pulse rounded bg-ink-200" />
          <div className="h-4 w-14 animate-pulse rounded bg-ink-200" />
          <div className="h-4 w-16 animate-pulse rounded bg-ink-200" />
        </nav>

        <div className="flex items-center gap-3">
          <div className="hidden sm:block space-y-1">
            <div className="h-3 w-20 animate-pulse rounded bg-ink-200" />
            <div className="h-2.5 w-12 animate-pulse rounded bg-ink-200" />
          </div>
          <div className="h-8 w-16 animate-pulse rounded-lg bg-ink-200" />
        </div>
      </div>
    </header>
  );
}

export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <ToastProvider>
      <div className="min-h-dvh w-full bg-ink-100 overflow-x-hidden">
        <Suspense fallback={<HeaderSkeleton />}>
          <AppHeader />
        </Suspense>

        {/**
         * Responsive main container with tight padding on mobile (px-3.5 py-3.5)
         * and generous padding on tablet/desktop (sm:px-6 lg:py-6).
         */}
        <main className="mx-auto w-full max-w-[1600px] px-3.5 py-3.5 sm:px-6 lg:py-6 2xl:px-10 2xl:py-8">
          {/**
           * Streamed rather than awaited. The banner needs a subscription
           * lookup, and blocking every page in the app on a billing query to
           * render a strip that is usually absent would be a poor trade — the
           * queue has to appear fast. Suspense with no fallback means the page
           * renders immediately and the banner slots in when it resolves.
           */}
          <Suspense fallback={null}>
            <PlanExpiryNotice />
          </Suspense>
          {children}
        </main>
      </div>
    </ToastProvider>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
    >
      {children}
    </Link>
  );
}
