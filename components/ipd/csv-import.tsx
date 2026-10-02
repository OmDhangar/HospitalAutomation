'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, cn } from '@/components/ui';
import { formatRupees } from '@/lib/domain/billing';
import { CHARGE_ITEM_KIND_LABELS, parseChargeItemCsv } from '@/lib/domain/ipd-config';

/**
 * Paste a price list, see exactly what will happen, then save.
 *
 * The preview runs the same pure parser the server uses, so what the owner
 * sees is what gets saved; the server still parses the text again rather
 * than trusting this one. Bad rows are listed by line and skipped — the owner
 * fixes the few, not the whole sheet.
 */
export function CsvImport({ action }: { action: (form: FormData) => Promise<void> }) {
  const [csv, setCsv] = useState('');
  const preview = useMemo(() => parseChargeItemCsv(csv), [csv]);
  const hasInput = csv.trim().length > 0;

  return (
    <form action={action} className="space-y-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink-700">
          Paste rows: name, kind, unit, price in ₹, tax %
        </span>
        <textarea
          name="csv"
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={'Syringe 5 ml, consumable, syringe, 15\nNebulisation, procedure, each, 150\nCBC, test, , 350\nGeneral ward bed, room, day, 800'}
          className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 font-mono text-sm text-ink-900 ring-1 ring-inset ring-ink-300 placeholder:text-ink-400 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none"
        />
        <span className="mt-1 block text-xs text-ink-500">
          Copy straight from Excel or Google Sheets. Only the name is required; a blank price means
          “not priced yet”. Kinds: consumable, procedure, service, test, room.
        </span>
      </label>

      {hasInput ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-700">
            <span className="font-semibold">{preview.rows.length}</span> ready to import
            {preview.errors.length > 0 ? (
              <>
                , <span className="font-semibold text-rose-700">{preview.errors.length}</span> will be skipped
              </>
            ) : null}
            .
          </p>

          {preview.errors.length > 0 ? (
            <Alert tone="error">
              <ul className="space-y-0.5">
                {preview.errors.slice(0, 20).map((error) => (
                  <li key={error.line}>
                    <span className="numeric font-semibold">Line {error.line}:</span> {error.error}
                  </li>
                ))}
                {preview.errors.length > 20 ? <li>…and {preview.errors.length - 20} more</li> : null}
              </ul>
            </Alert>
          ) : null}

          {preview.rows.length > 0 ? (
            <div className="max-h-72 overflow-auto rounded-lg ring-1 ring-ink-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Kind</th>
                    <th className="hidden px-3 py-2 font-medium sm:table-cell">Unit</th>
                    <th className="px-3 py-2 text-right font-medium">Price</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {preview.rows.slice(0, 200).map((row) => (
                    <tr key={row.line}>
                      <td className="px-3 py-1.5 text-ink-900">{row.name}</td>
                      <td className="px-3 py-1.5 text-ink-600">
                        {row.isTest ? 'Test' : CHARGE_ITEM_KIND_LABELS[row.kind]}
                      </td>
                      <td className="hidden px-3 py-1.5 text-ink-600 sm:table-cell">{row.unit}</td>
                      <td
                        className={cn(
                          'numeric px-3 py-1.5 text-right',
                          row.sellingPricePaise === null ? 'text-amber-700' : 'text-ink-900',
                        )}
                      >
                        {row.sellingPricePaise === null ? 'No price' : formatRupees(row.sellingPricePaise)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      <Button type="submit" variant="primary" size="lg" disabled={preview.rows.length === 0}>
        Import {preview.rows.length > 0 ? `${preview.rows.length} items` : ''}
      </Button>
    </form>
  );
}
