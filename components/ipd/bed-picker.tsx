import { cn } from '@/components/ui';

export type FreeWard = { wardId: string; wardName: string; beds: { id: string; label: string }[] };

/**
 * Pick one free bed (IPD plan §5.3). Radio buttons dressed as tiles: one tap
 * selects, the selection is plain form state, and it works before any script
 * has loaded on a slow ward connection.
 */
export function BedPicker({
  wards,
  selectedBedId,
  name = 'bedId',
  optional = false,
  compact = false,
  onChange,
}: {
  wards: readonly FreeWard[];
  selectedBedId?: string | null;
  name?: string;
  /** Offers "Assign later": the patient joins Awaiting bed instead. */
  optional?: boolean;
  compact?: boolean;
  onChange?: (bedId: string) => void;
}) {
  if (wards.length === 0) {
    return (
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 ring-1 ring-amber-200">
        Every bed is taken. Discharge or move a patient, or add beds in Settings → IPD.
      </p>
    );
  }
  return (
    <div className={compact ? 'space-y-2.5' : 'space-y-4'}>
      {optional ? (
        <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg bg-white px-3 py-2 ring-1 ring-inset ring-ink-300 has-[:checked]:bg-brand-50 has-[:checked]:ring-brand-600">
          <input type="radio" name={name} value="" defaultChecked={!selectedBedId} className="size-4 accent-brand-600" />
          <span className="text-xs font-semibold text-ink-800">Assign a bed later</span>
          <span className="text-[11px] text-ink-500">The patient waits on Awaiting bed</span>
        </label>
      ) : null}
      {wards.map((ward) => (
        <fieldset key={ward.wardId}>
          <legend className={cn('font-semibold text-ink-800', compact ? 'mb-1 text-xs' : 'mb-2 text-sm')}>
            {ward.wardName}{' '}
            <span className="font-normal text-ink-500">
              · {ward.beds.length} free
            </span>
          </legend>
          <div className={cn(
            'grid gap-2',
            compact
              ? 'grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))]'
              : 'grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))]',
          )}>
            {ward.beds.map((bed) => (
              <label key={bed.id} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name={name}
                  value={bed.id}
                  checked={selectedBedId !== undefined ? bed.id === selectedBedId : undefined}
                  defaultChecked={selectedBedId === undefined ? false : undefined}
                  onChange={(e) => {
                    if (e.target.checked && onChange) onChange(bed.id);
                  }}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    'numeric flex items-center justify-center rounded-lg bg-white font-bold text-ink-800 ring-1 ring-inset ring-ink-300 transition-colors',
                    compact
                      ? 'h-10 px-2 text-sm'
                      : 'aspect-square min-h-18 text-xl rounded-xl',
                    'hover:ring-brand-500 peer-checked:bg-brand-600 peer-checked:text-white peer-checked:ring-brand-700',
                    'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-700',
                  )}
                >
                  {bed.label}
                </span>
                <span className="sr-only">
                  {ward.wardName}, bed {bed.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
