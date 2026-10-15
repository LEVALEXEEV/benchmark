/**
 * Медиана внутри страницы нужна только S5 — решить, где остановить свип.
 * Метрики считает анализ по сырым рядам.
 */

/** отбрасывает NaN (кадры без замера) и сортирует по возрастанию */
function sortedFinite(xs: readonly number[]): number[] {
  return xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

/** медиана с линейной интерполяцией (как numpy.median); NaN для пустого ряда */
export function median(xs: readonly number[]): number {
  const s = sortedFinite(xs);
  const n = s.length;
  if (n === 0) return NaN;
  const h = (n - 1) / 2;
  const lo = Math.floor(h);
  return s[lo]! + (h - lo) * (s[Math.min(n - 1, lo + 1)]! - s[lo]!);
}
