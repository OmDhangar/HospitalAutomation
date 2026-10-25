'use client';

import { useEffect, useRef, useState } from 'react';
import { MenuIcon } from '@/components/icons';
import { cn } from '@/components/ui';

export interface RowMenuItem {
  label: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

export function RowMenu({
  items,
  ariaLabel = 'Row actions',
}: {
  items: RowMenuItem[];
  ariaLabel?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative inline-block text-left">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className="rounded p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        <MenuIcon className="size-4" />
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label={ariaLabel}
          className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] rounded-xl border border-ink-200 bg-white p-1 shadow-lg"
        >
          {items.map((item, idx) => (
            <button
              key={idx}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setIsOpen(false);
                item.onClick();
              }}
              className={cn(
                'block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-40',
                item.tone === 'danger'
                  ? 'text-rose-700 hover:bg-rose-50'
                  : 'text-ink-900 hover:bg-ink-50',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
