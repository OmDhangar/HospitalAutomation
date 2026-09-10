'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui';

export type NavItem = {
  label: string;
  href: string;
};

export function MobileNav({
  items,
  userName,
  userRole,
  hospitalName,
  signOutAction,
}: {
  items: NavItem[];
  userName: string;
  userRole: string;
  hospitalName: string;
  signOutAction: (formData: FormData) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

  return (
    <div className="sm:hidden">
      {/* Hamburger Menu Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex size-9 items-center justify-center rounded-lg border border-ink-200 text-ink-700 hover:bg-ink-100 focus:outline-none"
        aria-label="Toggle navigation menu"
      >
        <span className="text-xl leading-none">{isOpen ? '✕' : '☰'}</span>
      </button>

      {/* Slide-out Mobile Navigation Drawer */}
      {isOpen ? (
        <div className="fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-ink-950/50 transition-opacity"
            onClick={() => setIsOpen(false)}
          />

          {/* Drawer Panel */}
          <div className="relative ml-auto flex w-4/5 max-w-xs flex-col bg-white shadow-2xl transition-all">
            <div className="flex items-center justify-between border-b border-ink-200 px-5 py-4">
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white">
                  Q
                </span>
                <span className="truncate text-sm font-bold text-ink-900">{hospitalName}</span>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-ink-500 hover:text-ink-900 p-1 font-bold"
              >
                ✕
              </button>
            </div>

            {/* Navigation Links */}
            <nav className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
              {items.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setIsOpen(false)}
                    className={cn(
                      'flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors',
                      isActive
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-ink-700 hover:bg-ink-100 hover:text-ink-900',
                    )}
                  >
                    <span>{item.label}</span>
                    {isActive ? <span className="text-xs text-brand-600 font-bold">●</span> : null}
                  </Link>
                );
              })}
            </nav>

            {/* User Profile & Sign Out Footer */}
            <div className="border-t border-ink-200 p-4 bg-ink-50">
              <div className="mb-3 px-1">
                <p className="text-sm font-semibold text-ink-900">{userName}</p>
                <p className="text-xs text-ink-500 capitalize">{userRole}</p>
              </div>
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="w-full rounded-lg bg-white border border-ink-200 py-2 px-3 text-center text-sm font-semibold text-rose-700 hover:bg-rose-50"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
