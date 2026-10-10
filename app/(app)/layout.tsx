import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { ToastProvider } from '@/components/toast';
import { ImpersonationBanner } from '@/components/impersonation-banner';
import { MobileNav, type NavItem } from '@/components/mobile-nav';
import { SessionGuard } from '@/components/session-guard';
import { getSession, requireSession } from '@/lib/auth/session';
import { can, homePathFor } from '@/lib/domain/permissions';
import { getModuleStatesForRequest } from '@/lib/auth/modules';
import { moduleAllows } from '@/lib/modules/registry';
import { countEscalatedTests, myServicePoints } from '@/lib/services/test-orders';
import { switchUserAction } from '../ward-device/actions';
import { signOutAction } from './dashboard/actions';

/**
 * The header reads the session cookie to display user info and role-based
 * nav links. Wrapping it in Suspense allows the layout shell (and the
 * loading.tsx skeleton for the page) to render instantly while the session
 * is resolved. The redirect-to-login guard still fires during streaming.
 */
async function AppHeader() {
  const session = await requireSession();

  /**
   * An operator-issued password is a one-use credential. Until it is replaced
   * nothing else in the app renders, because the alternative is a temporary
   * password that quietly becomes the account's permanent one.
   */
  if (session.mustChangePassword) redirect('/change-password');

  /**
   * On a shared ward tablet the person "switches user" instead of signing out:
   * the tablet stays enrolled and goes back to "Who is recording?" (ADR-022).
   */
  const onTablet = session.channel === 'ward_device';
  const endSession = onTablet ? switchUserAction : signOutAction;
  const endLabel = onTablet ? 'Switch user' : 'Sign out';

  const navItems: NavItem[] = [];

  if (can(session.role, 'queue.mutate')) {
    navItems.push({ label: 'Queue', href: '/dashboard' });
  }

  // For a nurse this is the first and only work item.
  if (can(session.role, 'ipd.view')) {
    navItems.push({ label: 'IPD', href: '/ipd' });
  }

  /**
   * Test follow-up (C4a): for the owner always, with the count of patients
   * raised to them; for anyone else only when they are on a lab's staff.
   */
  if (can(session.role, 'tests.work') && moduleAllows(await getModuleStatesForRequest(session.hospitalId), 'test_follow_up', 'read')) {
    if (can(session.role, 'tests.oversee')) {
      const escalated = await countEscalatedTests(session.hospitalId);
      navItems.push({ label: escalated > 0 ? `Tests (${escalated})` : 'Tests', href: '/tests' });
    } else if ((await myServicePoints({ hospitalId: session.hospitalId, userId: session.userId, isOwner: false })).length > 0) {
      navItems.push({ label: 'Tests', href: '/tests' });
    }
  }

  if (can(session.role, 'reports.view')) {
    navItems.push({ label: 'Reports', href: '/reports' });
  }

  if (can(session.role, 'hospital.configure')) {
    navItems.push(
      { label: 'Subscription', href: '/subscription' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Activity', href: '/audit' },
      { label: 'Settings', href: '/settings' },
    );
  }

  // The evidence log (plan §7.6); next to Activity for the owner.
  if (can(session.role, 'acct.view')) {
    const at = navItems.findIndex((item) => item.href === '/audit');
    navItems.splice(at === -1 ? navItems.length : at + 1, 0, { label: 'Accountability', href: '/accountability' });
  }

  // Hidden while impersonating: the console is not reachable from a support
  // session by design, so offering the link would only produce a dead end.
  if (session.isPlatformAdmin && session.impersonatedByUserId === null) {
    navItems.push({ label: 'Platform', href: '/admin' });
  }

  // A ward tablet is for the ward only; proxy.ts and the capped role enforce it, this keeps the menu honest.
  if (onTablet) navItems.splice(0, navItems.length, ...navItems.filter((item) => item.href === '/ipd'));

  return (
    <header className="sticky top-0 z-40 border-b border-ink-200 bg-white shadow-xs">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-3 px-3.5 sm:px-6">
        <Link href={homePathFor(session.role)} className="flex items-center gap-2.5 min-w-0 max-w-[70vw] sm:max-w-none">
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
          {!onTablet ? (
            <Link
              href="/account"
              className="hidden rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 sm:block"
            >
              My login
            </Link>
          ) : null}
          <form action={endSession} className={onTablet ? undefined : 'hidden sm:block'}>
            <button
              type="submit"
              className={
                onTablet
                  ? 'min-h-11 rounded-lg bg-brand-600 px-3 text-sm font-semibold text-white shadow-xs hover:bg-brand-700 cursor-pointer'
                  : 'rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100 cursor-pointer'
              }
            >
              {endLabel}
            </button>
          </form>

          {/* Mobile Hamburger Navigation */}
          {!onTablet ? (
            <MobileNav
              items={[...navItems, { label: 'My login and PIN', href: '/account' }]}
              userName={session.name}
              userRole={session.role}
              hospitalName={session.hospitalName}
              signOutAction={endSession}
            />
          ) : null}
          <SessionGuard
            idleMs={session.screenLock.idleMs}
            backgroundMs={session.screenLock.backgroundMs}
            channel={session.channel}
          />
        </div>
      </div>
    </header>
  );
}

/**
 * Rendered above the header's Suspense boundary rather than inside it, so the
 * warning that this is somebody else's account is never the last thing to
 * appear on the page.
 */
async function SupportNotice() {
  const session = await getSession();
  if (!session || session.impersonatedByUserId === null) return null;

  return (
    <ImpersonationBanner hospitalName={session.hospitalName} readOnly={session.readOnly} />
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

        <Suspense fallback={null}>
          <SupportNotice />
        </Suspense>

        {/**
         * Responsive main container with tight padding on mobile (px-3.5 py-3.5)
         * and generous padding on tablet/desktop (sm:px-6 lg:py-6).
         */}
        <main className="mx-auto w-full max-w-[1600px] px-3.5 py-3.5 sm:px-6 lg:py-6">
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
