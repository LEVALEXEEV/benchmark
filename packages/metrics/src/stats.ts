/**
 * Описательная статистика внутри страницы — для оперативной сводки прогона.
 * Инференциальная статистика считается отдельно (Python) по сырым рядам,
 * поэтому определения здесь выбраны совместимыми с numpy/pandas.
 */

/** отбрасывает NaN (кадры без замера фазы) — иначе они отравляют среднее */
function finite(xs: readonly number[]): number[] {
  const out: number[] = [];
  for (const x of xs) if (Number.isFinite(x)) out.push(x);
  return out;
}

export function mean(xs: readonly number[]): number {
  const v = finite(xs);
  if (v.length === 0) return NaN;
  let sum = 0;
  for (const x of v) sum += x;
  return sum / v.length;
}

/** выборочное стандартное отклонение (ddof = 1) */
export function stddev(xs: readonly number[]): number {
  const v = finite(xs);
  if (v.length < 2) return NaN;
  const m = mean(v);
  let acc = 0;
  for (const x of v) acc += (x - m) ** 2;
  return Math.sqrt(acc / (v.length - 1));
}

export function sortedFinite(xs: readonly number[]): number[] {
  return finite(xs).sort((a, b) => a - b);
}

/**
 * Перцентиль с линейной интерполяцией между соседними рангами
 * (тип 7 по Hyndman–Fan, дефолт numpy.percentile). В НИР2 использовался
 * nearest-rank «вниз», что на малых выборках (p99 из ~100 значений)
 * систематически занижало хвост.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0]!;
  const h = (n - 1) * (p / 100);
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sortedAsc[lo]! + (h - lo) * (sortedAsc[hi]! - sortedAsc[lo]!);
}

export function median(xs: readonly number[]): number {
  return percentile(sortedFinite(xs), 50);
}

/** округление для сериализации сырых рядов: 0,1 мкс ниже точности таймера (5 мкс) */
export function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : NaN;
}
