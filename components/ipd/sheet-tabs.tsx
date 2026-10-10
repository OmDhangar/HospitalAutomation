'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui';

export type SheetTab = { label: string; href: string };

/**
 * The patient file's sheets, in the order of the paper file (IPD sheets plan
 * §4.1): Summary, TPR chart, Treatment card… Generated from the module
 * registry, so a sheet the hospital has switched off is not listed. Summary is
 * active only on its own page; every other sheet also on its sub-pages.
 */
export function SheetTabs({ tabs, base }: { tabs: readonly SheetTab[]; base: string }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === base ? pathname === base : pathname.startsWith(href));

  return (
    <nav aria-label="Patient file sheets" className="flex gap-1 overflow-x-auto scrollbar-none border-b border-ink-200">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={isActive(tab.href) ? 'page' : undefined}
          className={cn(
            '-mb-px inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm font-semibold transition-colors',
            isActive(tab.href) ? 'border-brand-600 text-brand-800' : 'border-transparent text-ink-600 hover:text-ink-900',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
