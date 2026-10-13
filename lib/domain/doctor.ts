/**
 * Normalizes a doctor/consultant name, stripping any duplicate or prefixed
 * titles ("Dr.", "Dr", "Doctor", "Dr. Dr.") and prepending "Dr. " exactly once.
 * Returns "—" for missing/empty values.
 */

export function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatDoctor(name: string | null | undefined): string {
  if (!name) return '—';
  let trimmed = name.trim();
  if (!trimmed) return '—';

  const prefixRegex = /^(?:dr\.?|doctor)\b\.?\s*/i;
  while (prefixRegex.test(trimmed)) {
    trimmed = trimmed.replace(prefixRegex, '').trim();
  }

  if (!trimmed) return '—';

  const titled = toTitleCase(trimmed);
  return `Dr. ${titled}`;
}
