'use client';

import React, { useEffect } from 'react';
import { XIcon } from '@/components/icons';

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  patient?: {
    name: string;
    uhid: string;
    bedLabel?: string | null;
  };
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function Drawer({
  isOpen,
  onClose,
  title,
  patient,
  children,
  footer,
  className = '',
}: DrawerProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-ink-950/40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      <div className="fixed inset-y-0 right-0 flex max-w-full">
        <aside
          className={`w-screen max-w-full sm:w-[480px] bg-surface flex flex-col shadow-2xl border-l border-ink-100 ${className}`}
        >
          {/* Sticky Header */}
          <header className="sticky top-0 z-10 flex flex-col gap-1 border-b border-ink-100 bg-surface px-5 py-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink-900">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 focus:outline-none focus:ring-2 focus:ring-primary min-h-[44px] min-w-[44px] flex items-center justify-center"
                aria-label="Close drawer"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>
            {patient && (
              <div className="flex items-center gap-1.5 text-xs text-ink-500 font-normal">
                <span className="font-semibold text-ink-700">{patient.name}</span>
                <span>•</span>
                <span>{patient.uhid}</span>
                {patient.bedLabel && (
                  <>
                    <span>•</span>
                    <span>{patient.bedLabel}</span>
                  </>
                )}
              </div>
            )}
          </header>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {/* Sticky Footer */}
          {footer && (
            <footer className="sticky bottom-0 z-10 flex items-center justify-end gap-3 border-t border-ink-100 bg-surface px-5 py-3">
              {footer}
            </footer>
          )}
        </aside>
      </div>
    </div>
  );
}
