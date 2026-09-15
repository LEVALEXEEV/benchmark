import { S5_LEVELS } from '@bench/scene-spec';

export interface ImplTarget {
  readonly name: 'threejs' | 'r3f';
  readonly mode: 'ref' | 'state' | null;
  readonly baseUrl: string;
  /** ключ для группировки в summary: threejs | r3f-ref | r3f-state */
  readonly label: string;
}

export interface BenchConfig {
  readonly scenarioId: string;
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly iterations: number;
  /**
   * число прогонов для прогрева браузера ПЕРЕД записью, отбрасываются.
   * Снимает холодный выброс первой итерации (JIT, инициализация компилятора
   * шейдеров, дисковый кэш). Для S3 HTTP-кэш всё равно отключён покадрово,
   * поэтому page-load остаётся холодным — греется только процесс браузера.
   */
  readonly warmupRuns: number;
  /** длина "тихого окна" для TTI (только S3) */
  readonly quietWindowMs: number;
  /** предельное ожидание TTI (только S3) */
  readonly ttiTimeoutMs: number;
  /** период синтезированных кликов (только S4) */
  readonly clickIntervalMs: number;
  /** seed траектории кликов (только S4) */
  readonly seed: number;
  /** уровни свипа по числу объектов (только S5) */
  readonly levels: readonly number[];
  /** порог median FPS для фиксации деградации (только S5) */
  readonly fpsFloor: number;
  readonly targets: readonly ImplTarget[];
  readonly resultsDir: string;
}

const THREEJS_URL = 'http://localhost:5173';
const R3F_URL = 'http://localhost:5174';

const TARGETS_S1: readonly ImplTarget[] = [
  { name: 'threejs', mode: null, baseUrl: THREEJS_URL, label: 'threejs' },
  { name: 'r3f', mode: 'ref', baseUrl: R3F_URL, label: 'r3f' },
];

const TARGETS_S2: readonly ImplTarget[] = [
  { name: 'threejs', mode: null, baseUrl: THREEJS_URL, label: 'threejs' },
  { name: 'r3f', mode: 'ref', baseUrl: R3F_URL, label: 'r3f-ref' },
  { name: 'r3f', mode: 'state', baseUrl: R3F_URL, label: 'r3f-state' },
];

const TARGETS_S3: readonly ImplTarget[] = [
  { name: 'threejs', mode: null, baseUrl: THREEJS_URL, label: 'threejs' },
  { name: 'r3f', mode: null, baseUrl: R3F_URL, label: 'r3f' },
];

const TARGETS_S4: readonly ImplTarget[] = [
  { name: 'threejs', mode: null, baseUrl: THREEJS_URL, label: 'threejs' },
  { name: 'r3f', mode: 'ref', baseUrl: R3F_URL, label: 'r3f-ref' },
  { name: 'r3f', mode: 'state', baseUrl: R3F_URL, label: 'r3f-state' },
];

const TARGETS_S5: readonly ImplTarget[] = [
  { name: 'threejs', mode: null, baseUrl: THREEJS_URL, label: 'threejs' },
  { name: 'r3f', mode: 'ref', baseUrl: R3F_URL, label: 'r3f-ref' },
  { name: 'r3f', mode: 'state', baseUrl: R3F_URL, label: 'r3f-state' },
];

const TARGETS_BY_SCENARIO: Record<string, readonly ImplTarget[]> = {
  s1: TARGETS_S1,
  s2: TARGETS_S2,
  s3: TARGETS_S3,
  s4: TARGETS_S4,
  s5: TARGETS_S5,
};

export const DEFAULT_CONFIG: BenchConfig = {
  scenarioId: 's1',
  warmupMs: 5000,
  recordMs: 30000,
  iterations: 5,
  warmupRuns: 1,
  quietWindowMs: 2000,
  ttiTimeoutMs: 15000,
  clickIntervalMs: 250,
  seed: 4242,
  levels: S5_LEVELS,
  fpsFloor: 30,
  targets: TARGETS_S1,
  resultsDir: new URL('../../../results', import.meta.url).pathname,
};

export function parseArgs(argv: readonly string[]): BenchConfig {
  const out: {
    scenarioId: string;
    warmupMs: number;
    recordMs: number;
    iterations: number;
    warmupRuns: number;
    quietWindowMs: number;
    ttiTimeoutMs: number;
    clickIntervalMs: number;
    seed: number;
    levels: readonly number[];
    fpsFloor: number;
    targets: readonly ImplTarget[];
    resultsDir: string;
  } = { ...DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--scenario' && next) out.scenarioId = next;
    if (a === '--iterations' && next) out.iterations = Number(next);
    if (a === '--warmupRuns' && next) out.warmupRuns = Number(next);
    if (a === '--record' && next) out.recordMs = Number(next);
    if (a === '--warmup' && next) out.warmupMs = Number(next);
    if (a === '--quiet' && next) out.quietWindowMs = Number(next);
    if (a === '--ttiTimeout' && next) out.ttiTimeoutMs = Number(next);
    if (a === '--clickInterval' && next) out.clickIntervalMs = Number(next);
    if (a === '--seed' && next) out.seed = Number(next);
    if (a === '--fpsFloor' && next) out.fpsFloor = Number(next);
    if (a === '--levels' && next) {
      out.levels = next
        .split(',')
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
  }
  out.targets = TARGETS_BY_SCENARIO[out.scenarioId] ?? TARGETS_S1;
  // S3 — холодный старт: повторов нужно больше, а recordMs/warmupMs не релевантны
  if (out.scenarioId === 's3' && out.iterations === DEFAULT_CONFIG.iterations) {
    out.iterations = 10;
  }
  // S5 — свип: warmup/record трактуются ПОУРОВНЕВО, поэтому окна короче, а
  // полный свип идёт по нескольким уровням → меньше повторов всего сценария.
  if (out.scenarioId === 's5') {
    if (out.warmupMs === DEFAULT_CONFIG.warmupMs) out.warmupMs = 1500;
    if (out.recordMs === DEFAULT_CONFIG.recordMs) out.recordMs = 3000;
    if (out.iterations === DEFAULT_CONFIG.iterations) out.iterations = 3;
  }
  return out;
}
