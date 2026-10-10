'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { PlusIcon, XIcon } from '@/components/icons';

type Line = { key: number; medicineId: string; batchNo: string; expiry: string; quantity: string };

const input = 'mt-1 block h-12 w-full rounded-lg border-0 bg-white px-3 text-base ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 focus:outline-none';

/**
 * Stock received from a supplier, as the invoice lists it (IPD sheets plan
 * B4a): one line per medicine and batch, with the expiry printed on the strip.
 * The lines travel as JSON in one form post; the server checks every field.
 */
export function StockReceiveForm({
  action,
  clientId,
  today,
  locations,
  medicines,
}: {
  action: (form: FormData) => Promise<void>;
  clientId: string;
  today: string;
  locations: { id: string; name: string }[];
  medicines: { id: string; label: string; unit: string }[];
}) {
  const [lines, setLines] = useState<Line[]>([{ key: 1, medicineId: '', batchNo: '', expiry: '', quantity: '' }]);
  const update = (key: number, field: keyof Omit<Line, 'key'>, value: string) =>
    setLines((list) => list.map((line) => (line.key === key ? { ...line, [field]: value } : line)));

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="lines" value={JSON.stringify(lines.filter((l) => l.medicineId).map(({ medicineId, batchNo, expiry, quantity }) => ({ medicineId, batchNo, expiry, quantity })))} />

      <div className="grid gap-3 rounded-xl bg-white p-4 ring-1 ring-ink-200 sm:grid-cols-2 sm:p-5">
        <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
          Into which store
          <select name="locationId" required className={input} defaultValue={locations[0]?.id}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
          Supplier
          <input name="supplierName" required maxLength={120} className={input} />
        </label>
        <label className="block text-sm font-medium text-ink-700">
          Invoice number
          <input name="invoiceNo" required maxLength={40} className={input} />
        </label>
        <label className="block text-sm font-medium text-ink-700">
          Invoice date
          <input name="invoiceDate" type="date" required max={today} defaultValue={today} className={input} />
        </label>
      </div>

      <div className="space-y-3">
        {lines.map((line, i) => {
          const unit = medicines.find((m) => m.id === line.medicineId)?.unit;
          return (
            <fieldset key={line.key} className="relative grid gap-3 rounded-xl bg-white p-4 ring-1 ring-ink-200 sm:grid-cols-4 sm:p-5">
              <legend className="sr-only">Line {i + 1}</legend>
              {lines.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => setLines((list) => list.filter((l) => l.key !== line.key))}
                  className="absolute right-2 top-2 rounded-lg p-2 text-ink-400 hover:bg-ink-100"
                >
                  <XIcon className="size-4" />
                </button>
              ) : null}
              <label className="block text-sm font-medium text-ink-700 sm:col-span-4">
                Medicine
                <select value={line.medicineId} onChange={(e) => update(line.key, 'medicineId', e.target.value)} className={input} required={i === 0}>
                  <option value="">—</option>
                  {medicines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
                Batch number
                <input value={line.batchNo} onChange={(e) => update(line.key, 'batchNo', e.target.value)} className={`${input} uppercase`} />
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Expiry (MM/YYYY)
                <input value={line.expiry} onChange={(e) => update(line.key, 'expiry', e.target.value)} placeholder="03/2027" className={input} />
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Quantity{unit ? ` (${unit})` : ''}
                <input value={line.quantity} onChange={(e) => update(line.key, 'quantity', e.target.value)} inputMode="numeric" className={input} />
              </label>
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-11"
          onClick={() => setLines((list) => [...list, { key: Math.max(...list.map((l) => l.key)) + 1, medicineId: '', batchNo: '', expiry: '', quantity: '' }])}
        >
          <PlusIcon className="size-4" />
          Another line
        </Button>
      </div>

      <Button type="submit" variant="primary" size="lg" className="w-full">
        Receive into stock
      </Button>
    </form>
  );
}
