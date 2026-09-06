import Link from 'next/link';
import { Suspense } from 'react';
import { requireSession } from '@/lib/auth/session';
import { signOutAction } from './dashboard/actions';

/**
 * The header reads the session cookie to display user info and role-based
 * nav links. Wrapping it in Suspense allows the layout shell (and the
 * loading.tsx skeleton for the page) to render instantly while the session
 * is resolved. The redirect-to-login guard still fires during streaming.
 */
async function AppHeader() {
  const session = await requireSession();

  return (
    <header className="sticky top-0 z-40 border-b border-ink-200 bg-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            Q
          </span>
          <span className="truncate text-sm font-semibold text-ink-900">
            {session.hospitalName}
          </span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 sm:flex">
          <NavLink href="/dashboard">Queue</NavLink>
          <NavLink href="/reports">Reports</NavLink>
          {session.role === 'owner' ? (
            <>
              <NavLink href="/subscription">Subscription</NavLink>
              <NavLink href="/audit">Activity</NavLink>
              <NavLink href="/settings">Settings</NavLink>
            </>
          ) : null}
          {session.isPlatformAdmin ? <NavLink href="/admin">Platform</NavLink> : null}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium leading-tight text-ink-800">
              {session.name}
            </p>
            <p className="text-xs capitalize leading-tight text-ink-500">
              {session.role}
            </p>
          </div>
          <form action={signOutAction}>
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-100"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

/** Lightweight placeholder while the session resolves. */
function HeaderSkeleton() {
  return (
    <header className="sticky top-0 z-40 border-b border-ink-200 bg-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            Q
          </span>
          <div className="h-4 w-28 animate-pulse rounded bg-ink-200" />
        </div>

        <nav className="ml-4 hidden items-center gap-1 sm:flex">
          <div className="h-4 w-12 animate-pulse rounded bg-ink-200" />
          <div className="h-4 w-14 animate-pulse rounded bg-ink-200" />
          <div className="h-4 w-16 animate-pulse rounded bg-ink-200" />
        </nav>

        <div className="ml-auto flex items-center gap-3">
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
    <div className="min-h-dvh bg-ink-100">
      <Suspense fallback={<HeaderSkeleton />}>
        <AppHeader />
      </Suspense>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
    </div>
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
