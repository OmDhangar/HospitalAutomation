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
}: {
  wards: readonly FreeWard[];
  selectedBedId?: string | null;
  name?: string;
  /** Offers "Assign later": the patient joins Awaiting bed instead. */
  optional?: boolean;
}) {
  if (wards.length === 0) {
    return (
      <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
        Every bed is taken. Discharge or move a patient, or add beds in Settings → IPD.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {optional ? (
        <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl bg-white px-4 ring-1 ring-inset ring-ink-300 has-[:checked]:bg-brand-50 has-[:checked]:ring-brand-600">
          <input type="radio" name={name} value="" defaultChecked={!selectedBedId} className="size-4 accent-brand-600" />
          <span className="text-sm font-semibold text-ink-800">Assign a bed later</span>
          <span className="text-xs text-ink-500">The patient waits on Awaiting bed</span>
        </label>
      ) : null}
      {wards.map((ward) => (
        <fieldset key={ward.wardId}>
          <legend className="mb-2 text-sm font-semibold text-ink-800">
            {ward.wardName}{' '}
            <span className="font-normal text-ink-500">
              · {ward.beds.length} free
            </span>
          </legend>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
            {ward.beds.map((bed) => (
              <label key={bed.id} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name={name}
                  value={bed.id}
                  required={!optional}
                  defaultChecked={bed.id === selectedBedId}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    'numeric flex aspect-square min-h-18 items-center justify-center rounded-xl bg-white text-xl font-bold text-ink-800 ring-1 ring-inset ring-ink-300 transition-colors',
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
