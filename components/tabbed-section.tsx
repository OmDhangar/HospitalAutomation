'use client';

import type { ReactNode } from 'react';
import { cn } from '@/components/ui';

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabbedSectionProps {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  children: ReactNode | ((activeId: string) => ReactNode);
}

export function TabbedSection({
  tabs,
  activeId,
  onChange,
  children,
}: TabbedSectionProps) {
  return (
    <div>
      <div role="tablist" className="flex gap-1 border-b border-ink-200">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(tab.id)}
              className={cn(
                'px-4 py-2.5 text-sm font-medium transition-colors',
                active
                  ? '-mb-px border-b-2 border-brand-600 text-brand-700 font-semibold'
                  : 'text-ink-500 hover:text-ink-800',
              )}
            >
              {tab.label}
              {typeof tab.count === 'number' && (
                <span
                  className={cn(
                    'ml-1.5 rounded-full px-1.5 py-0.5 text-xs font-normal',
                    active
                      ? 'bg-brand-50 text-brand-700'
                      : 'bg-ink-100 text-ink-600',
                  )}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-4">
        {typeof children === 'function' ? children(activeId) : children}
      </div>
    </div>
  );
}
