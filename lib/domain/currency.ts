/**
 * Converts a non-negative integer amount in Indian Rupees to its words representation.
 * E.g., 5000 -> "Rupees Five Thousand Only"
 * E.g., 25500 -> "Rupees Twenty Five Thousand Five Hundred Only"
 */
export function numberToIndianRupeesInWords(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return 'Rupees Zero Only';
  const integerPart = Math.floor(amount);
  if (integerPart === 0) return 'Rupees Zero Only';

  const ones = [
    '',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
    'Thirteen',
    'Fourteen',
    'Fifteen',
    'Sixteen',
    'Seventeen',
    'Eighteen',
    'Nineteen',
  ];

  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function convertTwoDigits(num: number): string {
    if (num === 0) return '';
    if (num < 20) return ones[num];
    const t = Math.floor(num / 10);
    const o = num % 10;
    return `${tens[t]}${o > 0 ? ` ${ones[o]}` : ''}`;
  }

  function convertThreeDigits(num: number): string {
    const h = Math.floor(num / 100);
    const rem = num % 100;
    let res = '';
    if (h > 0) res += `${ones[h]} Hundred`;
    if (rem > 0) {
      if (res.length > 0) res += ' ';
      res += convertTwoDigits(rem);
    }
    return res;
  }

  let num = integerPart;
  const parts: string[] = [];

  const crore = Math.floor(num / 10000000);
  num %= 10000000;

  const lakh = Math.floor(num / 100000);
  num %= 100000;

  const thousand = Math.floor(num / 1000);
  num %= 1000;

  const hundred = num;

  if (crore > 0) parts.push(`${convertTwoDigits(crore)} Crore`);
  if (lakh > 0) parts.push(`${convertTwoDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${convertTwoDigits(thousand)} Thousand`);
  if (hundred > 0) parts.push(convertThreeDigits(hundred));

  return `Rupees ${parts.join(' ')} Only`;
}
