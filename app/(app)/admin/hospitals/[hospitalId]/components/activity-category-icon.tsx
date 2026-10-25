import {
  AlertTriangleIcon,
  CreditCardIcon,
  SettingsIcon,
  ShieldIcon,
  StethoscopeIcon,
  TagIcon,
  UserIcon,
} from '@/components/icons';
import { cn } from '@/components/ui';
import type { AuditCategory } from '@/lib/domain/audit';

export function ActivityCategoryIcon({
  category,
  destructive = false,
  className,
}: {
  category: AuditCategory;
  destructive?: boolean;
  className?: string;
}) {
  const Icon = destructive
    ? AlertTriangleIcon
    : category === 'auth'
      ? UserIcon
      : category === 'session'
        ? StethoscopeIcon
        : category === 'billing'
          ? CreditCardIcon
          : category === 'subscription'
            ? TagIcon
            : category === 'support'
              ? ShieldIcon
              : SettingsIcon;

  return (
    <Icon
      className={cn(
        'size-4 shrink-0',
        destructive
          ? 'text-rose-600'
          : category === 'support'
            ? 'text-violet-600'
            : 'text-ink-400',
        className,
      )}
    />
  );
}
