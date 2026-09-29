'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui';

const TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/hospitals', label: 'Accounts' },
  { href: '/admin/onboard', label: 'Onboard' },
  { href: '/admin/plans', label: 'Plans' },
  { href: '/admin/leads', label: 'Leads' },
  { href: '/admin/revenue', label: 'Revenue' },
  { href: '/admin/whatsapp', label: 'WhatsApp' },
] as const;

/**
 * A client component only because the active tab depends on the current path.
 * Everything under it stays a server component.
 */
export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="-mx-3.5 overflow-x-auto px-3.5 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max items-center gap-1 border-b border-ink-200 pb-px">
        {TABS.map((tab) => {
          // Overview matches exactly; the rest match their subtree, so a
          // hospital detail page keeps "Accounts" lit.
          const active =
            tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href);

          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-9 items-center rounded-t-lg border-b-2 px-3 text-sm font-medium transition-colors',
                  active
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-800',
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
