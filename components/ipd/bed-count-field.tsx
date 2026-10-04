'use client';

import { useId, useState } from 'react';
import { Field, Input } from '@/components/ui';
import { parseBedLabels } from '@/lib/domain/ipd-config';

/**
 * "How many beds?" with a live preview of exactly which beds will be made,
 * so "12" visibly means beds 1–12 (or 13–24 in a ward that has 1–12) before
 * anyone presses Save. Uses the same rule the server applies.
 */
export function BedCountField({
  name,
  label,
  existingLabels = [],
  required = false,
  placeholder = '12',
}: {
  name: string;
  label: string;
  existingLabels?: readonly string[];
  required?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState('');
  const previewId = useId();
  const parsed = value.trim() ? parseBedLabels(value, existingLabels) : null;

  let preview: string;
  if (!parsed) {
    preview = existingLabels.length > 0 ? 'Type how many more, like 4, or exact numbers like 20-24.' : 'Type how many, like 12. Or exact numbers: 1-6, ICU-1.';
  } else if (!parsed.ok) {
    preview = parsed.error;
  } else {
    const beds = parsed.value;
    const shown =
      beds.length <= 6 ? beds.join(', ') : `${beds.slice(0, 3).join(', ')} … ${beds.slice(-2).join(', ')}`;
    preview = `Will add ${beds.length} bed${beds.length === 1 ? '' : 's'}: ${shown}`;
  }

  return (
    <Field label={label}>
      <Input
        name={name}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        required={required}
        placeholder={placeholder}
        inputMode="text"
        autoComplete="off"
        aria-describedby={previewId}
      />
      <span
        id={previewId}
        aria-live="polite"
        className={parsed && !parsed.ok ? 'mt-1 block text-xs text-rose-700' : 'mt-1 block text-xs text-ink-500'}
      >
        {preview}
      </span>
    </Field>
  );
}
