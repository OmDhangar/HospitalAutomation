/**
 * Pure calculation rules for patient body measurements.
 * Safe to import in both client and server components.
 */

export function calculateBmi(weightKg?: number | null, heightCm?: number | null): number | null {
  if (weightKg == null || heightCm == null) return null;
  if (weightKg <= 0 || heightCm <= 0) return null;
  const heightM = heightCm / 100;
  const rawBmi = weightKg / (heightM * heightM);
  if (!isFinite(rawBmi) || isNaN(rawBmi)) return null;
  return Math.round(rawBmi * 10) / 10;
}

export function getBmiCategory(bmi: number): { label: string; color: string } {
  if (bmi < 18.5) return { label: 'Underweight', color: 'text-amber-700 bg-amber-50 border-amber-200' };
  if (bmi <= 24.9) return { label: 'Normal weight', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
  if (bmi <= 29.9) return { label: 'Overweight', color: 'text-orange-700 bg-orange-50 border-orange-200' };
  return { label: 'Obese', color: 'text-rose-700 bg-rose-50 border-rose-200' };
}
