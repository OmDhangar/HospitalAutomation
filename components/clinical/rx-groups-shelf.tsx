'use client';

import React, { useState } from 'react';
import type { RxGroupView } from '@/lib/services/rx-groups';
import { cn } from '@/components/ui';

export interface RxGroupsShelfProps {
  groups: RxGroupView[];
  isLoading?: boolean;
  onApplyGroup: (group: RxGroupView) => void;
  onOpenSaveModal?: () => void;
  canSaveCurrentAsGroup?: boolean;
  className?: string;
}

export function RxGroupsShelf({
  groups = [],
  isLoading = false,
  onApplyGroup,
  onOpenSaveModal,
  canSaveCurrentAsGroup = false,
  className = '',
}: RxGroupsShelfProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Extract unique categories from available groups
  const categories = [
    'all',
    ...Array.from(new Set(groups.map((g) => g.category || 'general'))),
  ];
  if (groups.some((g) => g.isPersonal) && !categories.includes('personal')) {
    categories.push('personal');
  }

  const filteredGroups = groups.filter((g) => {
    if (selectedCategory === 'all') return true;
    if (selectedCategory === 'personal') return g.isPersonal;
    return g.category === selectedCategory;
  });

  return (
    <div className={cn('rounded-lg border border-brand-200 bg-brand-50/50 p-3 space-y-2.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white text-[11px] font-bold">
            ⚡
          </span>
          <span className="text-xs font-bold text-brand-950 uppercase tracking-wide">
            Rx-Groups (1-Click Protocols)
          </span>
          <span className="text-[11px] text-brand-700 font-normal">
            — Pre-bundled medication regimens
          </span>
        </div>

        {canSaveCurrentAsGroup && onOpenSaveModal && (
          <button
            type="button"
            onClick={onOpenSaveModal}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded border border-brand-300 bg-white text-brand-800 hover:bg-brand-50 shadow-2xs transition-colors"
          >
            <span>+ Save as Rx-Group</span>
          </button>
        )}
      </div>

      {/* Category Filter Pills (if multiple categories exist) */}
      {groups.length > 0 && categories.length > 2 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px]">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={cn(
                'rounded-full px-2 py-0.5 font-medium transition-colors capitalize',
                selectedCategory === cat
                  ? 'bg-brand-600 text-white font-semibold'
                  : 'bg-white text-brand-900 border border-brand-200 hover:bg-brand-100/60',
              )}
            >
              {cat === 'personal' ? '★ My Personal Groups' : cat}
            </button>
          ))}
        </div>
      )}

      {/* Group Badges */}
      {isLoading ? (
        <div className="text-xs text-brand-700 italic py-1">Loading clinical bundles...</div>
      ) : filteredGroups.length === 0 ? (
        <div className="text-xs text-brand-700 py-1">
          {groups.length === 0
            ? 'No Rx-Groups available for this clinic.'
            : 'No Rx-Groups in this category.'}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {filteredGroups.map((group) => {
            const previewText = group.items
              .map((i) => `${i.medicineName} (${i.dose} · ${i.frequency})`)
              .join('; ');

            return (
              <button
                key={group.id}
                type="button"
                onClick={() => onApplyGroup(group)}
                title={previewText || group.description || group.name}
                className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 bg-white hover:bg-brand-100/80 px-2.5 py-1.5 text-xs font-medium text-brand-950 shadow-2xs transition-all active:scale-98 group"
              >
                <span className="font-bold text-brand-600 group-hover:text-brand-700">+</span>
                <span>{group.name}</span>
                <span className="rounded-full bg-brand-100 text-brand-800 px-1.5 py-0.2 text-[10px] font-bold">
                  {group.items.length}
                </span>
                {group.isPersonal && (
                  <span className="text-[10px] text-amber-600 font-semibold ml-0.5">
                    ★ My Group
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
