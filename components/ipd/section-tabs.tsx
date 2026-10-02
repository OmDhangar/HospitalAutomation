'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui';

export type SectionTab = { label: string; href: string };

/**
 * The IPD section's own tabs, under its header strip. On a phone they scroll
 * sideways rather than wrap, so the header stays one line tall.
 */
export function SectionTabs({ tabs }: { tabs: readonly SectionTab[] }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/ipd' ? pathname === '/ipd' || pathname.startsWith('/ipd/admissions') : pathname.startsWith(href);

  return (
    <nav aria-label="IPD sections" className="-mb-px flex gap-1 overflow-x-auto scrollbar-none">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={isActive(tab.href) ? 'page' : undefined}
          className={cn(
            'inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-semibold transition-colors',
            isActive(tab.href)
              ? 'border-brand-600 text-brand-800'
              : 'border-transparent text-ink-600 hover:text-ink-900',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
