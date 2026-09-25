'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui';

export type NavItem = {
  label: string;
  href: string;
};

const NAV_ICONS: Record<string, string> = {
  '/dashboard': '🩺',
  '/reports': '📊',
  '/subscription': '💳',
  '/pricing': '🏷️',
  '/audit': '📜',
  '/settings': '⚙️',
  '/admin': '🛡️',
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
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex size-10 items-center justify-center rounded-xl border border-ink-200 bg-white text-ink-700 shadow-xs hover:bg-ink-50 active:bg-ink-100 focus:outline-none cursor-pointer"
        aria-label="Toggle navigation menu"
        aria-expanded={isOpen}
      >
        <span className="text-xl leading-none">{isOpen ? '✕' : '☰'}</span>
      </button>

      {/* Slide-out Mobile Navigation Drawer */}
      {isOpen ? (
        <div className="fixed inset-0 z-50 flex animate-fadeIn">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-ink-950/60 backdrop-blur-xs transition-opacity"
            onClick={() => setIsOpen(false)}
          />

          {/* Drawer Panel */}
          <div className="relative ml-auto flex w-[85%] max-w-xs flex-col bg-white shadow-2xl transition-transform duration-200">
            <div className="flex items-center justify-between border-b border-ink-200 px-5 py-4 bg-ink-50/50">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white shadow-xs">
                  Q
                </span>
                <span className="truncate text-sm font-bold text-ink-900">{hospitalName}</span>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="size-8 flex items-center justify-center rounded-lg text-ink-500 hover:bg-ink-100 hover:text-ink-900 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Navigation Links */}
            <nav className="flex-1 overflow-y-auto px-3.5 py-4 space-y-1.5">
              {items.map((item) => {
                const isActive = pathname === item.href;
                const icon = NAV_ICONS[item.href] || '📌';
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setIsOpen(false)}
                    className={cn(
                      'flex items-center justify-between rounded-xl px-3.5 py-3 text-sm font-semibold transition-all',
                      isActive
                        ? 'bg-brand-50 text-brand-700 shadow-xs border border-brand-200'
                        : 'text-ink-700 hover:bg-ink-50 hover:text-ink-900 border border-transparent',
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-base">{icon}</span>
                      <span>{item.label}</span>
                    </div>
                    {isActive ? (
                      <span className="rounded-full bg-brand-600 size-2" />
                    ) : null}
                  </Link>
                );
              })}
            </nav>

            {/* User Profile & Sign Out Footer */}
            <div className="border-t border-ink-200 p-4 bg-ink-50/80">
              <div className="mb-3 px-1 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-ink-900 truncate">{userName}</p>
                  <p className="text-xs text-ink-500 capitalize">{userRole}</p>
                </div>
                <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold text-brand-800">
                  Doctor / Staff
                </span>
              </div>
              <form action={signOutAction}>
                <button
                  type="submit"
                  className="w-full rounded-xl bg-white border border-ink-200 py-2.5 px-3 text-center text-sm font-semibold text-rose-700 shadow-xs hover:bg-rose-50 active:bg-rose-100 transition-colors cursor-pointer"
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
