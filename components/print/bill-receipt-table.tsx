import React from 'react';
import type { CategorizedBillGroup } from '@/lib/domain/bill-receipt';

export interface BillReceiptTableProps {
  groups: CategorizedBillGroup[];
  summary: {
    totalBillAmountPaise: number;
    netPaymentsPaise: number;
    balanceDuePaise: number;
    netAmountPaise: number;
  };
}

function formatAmount(paise: number): string {
  const rupees = paise / 100;
  return rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

export function BillReceiptTable({ groups, summary }: BillReceiptTableProps) {
  return (
    <div className="mt-3">
      {/* Table */}
      <table className="w-full border-collapse text-left text-[11px] leading-tight text-ink-900">
        <thead>
          <tr className="border-b-2 border-ink-950 font-bold uppercase tracking-wider text-[10px]">
            <th className="py-1.5 pr-2 w-10">S.No</th>
            <th className="py-1.5 pr-2 w-24">Date</th>
            <th className="py-1.5 pr-2">Service Particulars</th>
            <th className="py-1.5 pr-2 w-28">Description</th>
            <th className="py-1.5 pr-2 text-right w-16">Rate</th>
            <th className="py-1.5 pr-2 text-right w-10">Qty</th>
            <th className="py-1.5 pr-2 text-right w-16">Discount</th>
            <th className="py-1.5 text-right w-20">Amount</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 ? (
            <tr>
              <td colSpan={8} className="py-8 text-center text-ink-500 italic">
                No billable care items or charges recorded yet.
              </td>
            </tr>
          ) : (
            groups.map((group) => (
              <React.Fragment key={group.categoryKey}>
                {/* Category Header Row */}
                <tr className="break-inside-avoid">
                  <td colSpan={8} className="pt-2.5 pb-1 font-black uppercase tracking-wider text-ink-950">
                    {group.categoryTitle}
                  </td>
                </tr>

                {/* Item Rows */}
                {group.lines.map((item) => (
                  <tr key={item.id} className="border-b border-ink-100/70 align-top break-inside-avoid">
                    <td className="py-1 pr-2 font-mono text-ink-600">{item.sNo}.</td>
                    <td className="py-1 pr-2 font-mono text-ink-700 whitespace-nowrap">{item.date}</td>
                    <td className="py-1 pr-2 font-semibold text-ink-950 uppercase">{item.particulars}</td>
                    <td className="py-1 pr-2 text-ink-700 uppercase">{item.description}</td>
                    <td className="py-1 pr-2 text-right font-mono text-ink-900">{formatAmount(item.ratePaise)}</td>
                    <td className="py-1 pr-2 text-right font-mono font-bold text-ink-900">{item.quantity}</td>
                    <td className="py-1 pr-2 text-right font-mono text-ink-700">
                      {item.discountPaise > 0 ? formatAmount(item.discountPaise) : '0'}
                    </td>
                    <td className="py-1 text-right font-mono font-bold text-ink-950">
                      {formatAmount(item.amountPaise)}
                    </td>
                  </tr>
                ))}

                {/* Sub Total Row */}
                <tr className="border-b border-ink-300 break-inside-avoid">
                  <td colSpan={7} className="py-1 text-right font-bold text-ink-800 pr-2">
                    Sub Total:
                  </td>
                  <td className="py-1 text-right font-mono font-black text-ink-950">
                    {formatAmount(group.subtotalPaise)}
                  </td>
                </tr>
              </React.Fragment>
            ))
          )}
        </tbody>
      </table>

      {/* Financial Summary Box */}
      <div className="mt-3 flex justify-end break-inside-avoid">
        <div className="w-72 space-y-1 border-t-2 border-ink-950 pt-2 text-[11px] font-sans">
          <div className="flex justify-between py-0.5">
            <span className="font-bold text-ink-800">Total Bill Amount:</span>
            <span className="font-mono font-black text-ink-950">
              {formatAmount(summary.totalBillAmountPaise)}
            </span>
          </div>

          <div className="flex justify-between py-0.5">
            <span className="font-bold text-ink-800">Less Net Payments:</span>
            <span className="font-mono font-bold text-ink-950">
              {formatAmount(summary.netPaymentsPaise)}
            </span>
          </div>

          <div className="flex justify-between py-0.5">
            <span className="font-bold text-ink-800">Balance Due:</span>
            <span className="font-mono font-bold text-ink-950">
              {formatAmount(summary.balanceDuePaise)}
            </span>
          </div>

          <div className="flex justify-between border-t border-ink-300 pt-1 text-xs">
            <span className="font-black text-ink-950">Net Amount:</span>
            <span className="font-mono font-black text-ink-950">
              {formatAmount(summary.netAmountPaise)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
