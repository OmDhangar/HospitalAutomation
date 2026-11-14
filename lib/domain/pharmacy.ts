/**
 * Pure domain logic for Outpatient Retail Pharmacy POS.
 *
 * Implements:
 * - Indian statutory GST tax engine (0%, 5%, 12%, 18%) with half-rate split for Intra-State CGST/SGST.
 * - Exact paise-level currency calculations.
 * - Sequential bill and return number formatters.
 * - English-only receipt and cash memo structures (Rule 2.2).
 */

export interface ItemTaxInput {
  unitPricePaise: number;
  quantity: number;
  discountPercent?: number;
  gstRate: number; // e.g. 0, 5, 12, 18
}

export interface ItemTaxBreakdown {
  grossAmountPaise: number;
  discountAmountPaise: number;
  taxableAmountPaise: number;
  cgstAmountPaise: number;
  sgstAmountPaise: number;
  totalAmountPaise: number;
}

export function calculateItemTax(input: ItemTaxInput): ItemTaxBreakdown {
  const discountPercent = Math.max(0, Math.min(100, input.discountPercent ?? 0));
  const gross = Math.max(0, input.unitPricePaise * input.quantity);
  const discount = Math.round((gross * discountPercent) / 100);
  const taxable = gross - discount;

  // For Intra-State sales, GST is split equally between CGST and SGST
  // Rate / 2 percent -> taxable * (Rate / 200)
  const halfRate = input.gstRate / 200;
  const cgst = Math.round(taxable * halfRate);
  const sgst = Math.round(taxable * halfRate);
  const total = taxable + cgst + sgst;

  return {
    grossAmountPaise: gross,
    discountAmountPaise: discount,
    taxableAmountPaise: taxable,
    cgstAmountPaise: cgst,
    sgstAmountPaise: sgst,
    totalAmountPaise: total,
  };
}

export interface SaleTotals {
  subtotalPaise: number;
  totalCgstPaise: number;
  totalSgstPaise: number;
  discountPaise: number;
  totalPaise: number;
}

export function calculateSaleTotals(
  items: Array<{
    taxableAmountPaise: number;
    cgstAmountPaise: number;
    sgstAmountPaise: number;
    totalAmountPaise: number;
  }>,
  billDiscountPaise = 0
): SaleTotals {
  const subtotal = items.reduce((sum, item) => sum + item.taxableAmountPaise, 0);
  const totalCgst = items.reduce((sum, item) => sum + item.cgstAmountPaise, 0);
  const totalSgst = items.reduce((sum, item) => sum + item.sgstAmountPaise, 0);
  const grossTotal = items.reduce((sum, item) => sum + item.totalAmountPaise, 0);
  const finalTotal = Math.max(0, grossTotal - billDiscountPaise);

  return {
    subtotalPaise: subtotal,
    totalCgstPaise: totalCgst,
    totalSgstPaise: totalSgst,
    discountPaise: billDiscountPaise,
    totalPaise: finalTotal,
  };
}

export function formatSaleNumber(prefix: string, year: number, seq: number): string {
  const cleanPrefix = (prefix || 'PH').toUpperCase();
  const padded = String(seq).padStart(5, '0');
  return `${cleanPrefix}-${year}-${padded}`;
}

export function formatReturnNumber(prefix: string, year: number, seq: number): string {
  const cleanPrefix = (prefix || 'RET').toUpperCase();
  const padded = String(seq).padStart(5, '0');
  return `${cleanPrefix}-${year}-${padded}`;
}

export interface ReceiptItemData {
  medicineName: string;
  batchNo: string;
  expiryDate: string;
  quantity: number;
  mrpPaise: number;
  unitPricePaise: number;
  discountPercent: number;
  gstRate: number;
  taxableAmountPaise: number;
  cgstAmountPaise: number;
  sgstAmountPaise: number;
  totalAmountPaise: number;
}

export interface ReceiptGenerationInput {
  hospitalName: string;
  hospitalAddress?: string;
  drugLicenseNo?: string;
  gstin?: string;
  saleNo: string;
  saleDate: Date;
  cashierName: string;
  customerName: string;
  customerPhone?: string;
  doctorName?: string;
  paymentMode: string;
  items: ReceiptItemData[];
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  discountPaise: number;
  totalPaise: number;
}

export interface FormattedReceipt {
  title: string;
  hospitalName: string;
  hospitalAddress: string;
  drugLicenseNo: string;
  gstin: string;
  saleNo: string;
  saleDateFormatted: string;
  cashierName: string;
  customerName: string;
  customerPhone: string;
  doctorName: string;
  paymentMode: string;
  items: ReceiptItemData[];
  subtotalFormatted: string;
  cgstFormatted: string;
  sgstFormatted: string;
  discountFormatted: string;
  totalFormatted: string;
  termsNotice: string;
}

export function formatCurrencyPaise(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(rupees);
}

export function generateReceiptData(input: ReceiptGenerationInput): FormattedReceipt {
  return {
    title: 'RETAIL PHARMACY CASH MEMO',
    hospitalName: input.hospitalName,
    hospitalAddress: input.hospitalAddress || 'Hospital Main Branch',
    drugLicenseNo: input.drugLicenseNo || 'N/A',
    gstin: input.gstin || 'N/A',
    saleNo: input.saleNo,
    saleDateFormatted: input.saleDate.toISOString().replace('T', ' ').substring(0, 19),
    cashierName: input.cashierName,
    customerName: input.customerName,
    customerPhone: input.customerPhone || 'N/A',
    doctorName: input.doctorName || 'Self / General OPD',
    paymentMode: input.paymentMode.toUpperCase(),
    items: input.items,
    subtotalFormatted: formatCurrencyPaise(input.subtotalPaise),
    cgstFormatted: formatCurrencyPaise(input.cgstPaise),
    sgstFormatted: formatCurrencyPaise(input.sgstPaise),
    discountFormatted: formatCurrencyPaise(input.discountPaise),
    totalFormatted: formatCurrencyPaise(input.totalPaise),
    termsNotice:
      'Medicines once sold can only be returned within 7 days with original receipt in intact packaging. Refrigerated products are non-returnable.',
  };
}
