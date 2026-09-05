import Link from 'next/link';
import { requireSession } from '@/lib/auth/session';
import { signOutAction } from './dashboard/actions';

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const session = await requireSession();

  return (
    <div className="min-h-dvh bg-ink-100">
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
