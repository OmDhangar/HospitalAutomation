import React from 'react';
import { BadgeColors, BadgeColorKey } from '@/constants/clinical';

export interface StatusBadgeProps {
  status: string;
  variant?: BadgeColorKey;
  className?: string;
}

export function StatusBadge({ status, variant = 'neutral', className = '' }: StatusBadgeProps) {
  const colorClasses = BadgeColors[variant] || BadgeColors.neutral;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ring-1 ring-inset ${colorClasses} ${className}`}
    >
      {status}
    </span>
  );
}
