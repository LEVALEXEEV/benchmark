import { fileURLToPath } from 'node:url';
import { S5_LEVELS } from '@bench/scene-spec';

export type BrowserName = 'chrome' | 'chromium' | 'firefox' | 'webkit';
export type ScenarioId = 's1' | 's2' | 's3' | 's4' | 's5';

export interface Target {
  /** ключ варианта в датасете */
  readonly label: string;
  readonly impl: 'threejs' | 'r3f';
  readonly mode: string | null;
  readonly extraParams?: Readonly<Record<string, string>>;
}

const T = {
  threejs: { label: 'threejs', impl: 'threejs', mode: null },
  r3f: { label: 'r3f', impl: 'r3f', mode: null },
  ref: { label: 'r3f-ref', impl: 'r3f', mode: 'ref' },
  refCentral: { label: 'r3f-ref-central', impl: 'r3f', mode: 'ref-central' },
  state: { label: 'r3f-state', impl: 'r3f', mode: 'state' },
  events: { label: 'r3f-events', impl: 'r3f', mode: 'events' },
  refParent: { label: 'r3f-ref+parent-state', impl: 'r3f', mode: 'ref', extraParams: { parentState: '1' } },
} as const satisfies Record<string, Target>;

/** все варианты сценария; первый — эталон паритета (three.js) */
export const AVAILABLE_TARGETS: Record<ScenarioId, readonly Target[]> = {
  s1: [T.threejs, T.ref, T.refParent],
  s2: [T.threejs, T.ref, T.refCentral, T.state, T.refParent],
  s3: [T.threejs, T.r3f],
  s4: [T.threejs, T.ref, T.state, T.events],
  s5: [T.threejs, T.ref, T.refCentral, T.state],
};

/** варианты по умолчанию; антипаттерн parent-state в S1 — только по запросу */
const DEFAULT_TARGETS: Record<ScenarioId, readonly string[]> = {
  s1: ['threejs', 'r3f-ref'],
  s2: ['threejs', 'r3f-ref', 'r3f-ref-central', 'r3f-state', 'r3f-ref+parent-state'],
  s3: ['threejs', 'r3f'],
  s4: ['threejs', 'r3f-ref', 'r3f-state', 'r3f-events'],
  s5: ['threejs', 'r3f-ref', 'r3f-ref-central', 'r3f-state'],
};

/**
 * Точка нагрузочного свипа S1. Кадр S1 определяется стоимостью рендера, и
 * важно, ЧЕМ именно он ограничен: заливкой пикселей, обработкой вершин или
 * числом draw calls. Точки разводят эти оси, чтобы гипотезу «при насыщении
 * GPU технология не влияет» можно было проверить не в одной конфигурации,
 * а вдоль всей оси нагрузки.
 */
export interface LoadPoint {
  readonly id: string;
  readonly note: string;
  readonly objects?: number;
  readonly shadowMapSize?: number;
  readonly renderScale?: number;
  readonly detailScale?: number;
}

export const S1_LOADS: Record<string, LoadPoint> = {
  A: { id: 'A', note: 'заливка: мало объектов, 2× разрешение, тени 4096', objects: 300, shadowMapSize: 4096, renderScale: 2 },
  B: { id: 'B', note: 'вершины: 3000 объектов, половинное разрешение', objects: 3000, renderScale: 0.5 },
  C: { id: 'C', note: 'draw calls: 3000 объектов, лёгкая геометрия и разрешение', objects: 3000, renderScale: 0.5, detailScale: 0.25 },
  D: { id: 'D', note: 'исходная сцена НИР2 (смешанная нагрузка)' },
};

/** сценарии без свипа идут одной точкой */
export const NO_LOAD: LoadPoint = { id: '-', note: 'базовая конфигурация' };

export interface BenchConfig {
  readonly scenario: ScenarioId;
  readonly targets: readonly Target[];
  readonly loads: readonly LoadPoint[];
  readonly browser: BrowserName;
  readonly serve: 'preview' | 'dev';
  readonly build: boolean;
  readonly iterations: number;
  readonly warmupRuns: number;
  readonly cooldownMs: number;
  /** random — порядок вариантов перемешивается в каждой итерации (блоки) */
  readonly order: 'random' | 'blocked';
  readonly orderSeed: number;
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly settleMs: number;
  readonly clickIntervalMs: number;
  readonly clickSeed: number;
  readonly levels: readonly number[];
  readonly fpsFloor: number;
  readonly levelsBeyondFloor: number;
  readonly minLevelFrames: number;
  readonly renderScale: number;
  readonly detailScale: number;
  readonly parityOnly: boolean;
  readonly skipParity: boolean;
  readonly trace: boolean;
  readonly gpuTimer: boolean;
  readonly device: string | null;
  readonly resultsDir: string;
}

/**
 * Протокол основной серии. Число повторов выведено из пилота 2026-09-18
 * (140 прогонов, Chrome, Apple M4): по разбросу МЕЖДУ прогонами рассчитано n,
 * достаточное для заявленной разрешающей способности при alpha = 0,05 и
 * мощности 0,8. Расчёт и таблица CV — analysis/pilot_variance.py и nir3-plan.md.
 *
 *   S1 — CV ≤ 1,6%: 10 повторов дают границу эквивалентности ±5%;
 *   S2 — CV до 4,5%: 15 повторов на центральные метрики (±5%), хвосты ±10%;
 *   S3 — CV до 21%, но прогон дешёвый и эффект двукратный: 30 загрузок;
 *   S4 — CV до 7,3%: 20 повторов на эквивалентность с границей ±10%;
 *   S5 — CV ≤ 6,5%: 8 свипов.
 *
 * Фактически применённые значения сохраняются в manifest.json каждой серии.
 */
const SCENARIO_DEFAULTS: Record<
  ScenarioId,
  { iterations: number; warmupMs: number; recordMs: number }
> = {
  s1: { iterations: 10, warmupMs: 5000, recordMs: 30000 },
  s2: { iterations: 15, warmupMs: 5000, recordMs: 30000 },
  // S3: одна загрузка страницы — дёшево, повторов больше
  s3: { iterations: 30, warmupMs: 0, recordMs: 1 },
  s4: { iterations: 20, warmupMs: 5000, recordMs: 30000 },
  // S5: warmup/record — поуровневые
  s5: { iterations: 8, warmupMs: 1500, recordMs: 3000 },
};

function usage(msg: string): never {
  throw new Error(
    `${msg}\n\nПример: npm run bench -- --scenario s2 --iterations 10 --browser chrome\n` +
      'Флаги: --scenario --targets --browser (chrome|chromium|firefox|webkit) --serve (preview|dev) --no-build\n' +
      '       --iterations --warmupRuns --cooldown --order (random|blocked) --orderSeed\n' +
      '       --warmup --record --settle --clickInterval --clickSeed --levels --fpsFloor --levelsBeyondFloor --minLevelFrames\n' +
      '       --renderScale --detailScale --loads (s1: A,B,C,D) --parity-only --skip-parity --trace --no-gpu-timer --device --out'
  );
}

export function parseArgs(argv: readonly string[]): BenchConfig {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) usage(`Неожиданный аргумент ${a}`);
    const key = a.slice(2);
    if (['no-build', 'parity-only', 'skip-parity', 'trace', 'no-gpu-timer'].includes(key)) {
      flags.add(key);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`Флаг ${a} требует значение`);
    values.set(key, v);
    i++;
  }
  const known = new Set([
    'scenario', 'targets', 'browser', 'serve', 'iterations', 'warmupRuns', 'cooldown', 'order',
    'orderSeed', 'warmup', 'record', 'settle', 'clickInterval', 'clickSeed', 'levels', 'fpsFloor',
    'levelsBeyondFloor', 'minLevelFrames', 'renderScale', 'detailScale', 'loads', 'device', 'out',
  ]);
  for (const k of values.keys()) if (!known.has(k)) usage(`Неизвестный флаг --${k}`);

  const num = (k: string, def: number): number => {
    const raw = values.get(k);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) usage(`--${k}=${raw}: ожидается неотрицательное число`);
    return n;
  };

  const scenario = (values.get('scenario') ?? 's1') as ScenarioId;
  if (!(scenario in AVAILABLE_TARGETS)) usage(`Неизвестный сценарий ${scenario}`);
  const available = AVAILABLE_TARGETS[scenario];
  const labels = values.get('targets')?.split(',') ?? DEFAULT_TARGETS[scenario];
  const targets = labels.map((l) => {
    const t = available.find((x) => x.label === l);
    if (!t) usage(`Вариант ${l} недоступен для ${scenario}; есть: ${available.map((x) => x.label).join(', ')}`);
    return t;
  });

  const browser = (values.get('browser') ?? 'firefox') as BrowserName;
  if (!['chrome', 'chromium', 'firefox', 'webkit'].includes(browser)) usage(`Неизвестный браузер ${browser}`);
  const serve = values.get('serve') ?? 'preview';
  if (serve !== 'preview' && serve !== 'dev') usage('--serve: preview | dev');
  const order = values.get('order') ?? 'random';
  if (order !== 'random' && order !== 'blocked') usage('--order: random | blocked');

  const loadsRaw = values.get('loads');
  const loads: LoadPoint[] =
    scenario === 's1'
      ? (loadsRaw?.split(',') ?? Object.keys(S1_LOADS)).map((id) => {
          const l = S1_LOADS[id];
          if (!l) usage(`Точка нагрузки ${id} неизвестна; есть: ${Object.keys(S1_LOADS).join(', ')}`);
          return l;
        })
      : [NO_LOAD];
  if (loadsRaw && scenario !== 's1') usage('--loads применим только к s1');

  const d = SCENARIO_DEFAULTS[scenario];
  const levels = values.get('levels')?.split(',').map(Number) ?? S5_LEVELS;
  if (levels.some((n) => !Number.isInteger(n) || n <= 0)) usage('--levels: список целых > 0');

  return {
    scenario,
    targets,
    loads,
    browser,
    serve,
    build: !flags.has('no-build'),
    iterations: num('iterations', d.iterations),
    warmupRuns: num('warmupRuns', 1),
    cooldownMs: num('cooldown', 3000),
    order,
    orderSeed: num('orderSeed', Date.now() % 2 ** 31),
    warmupMs: num('warmup', d.warmupMs),
    recordMs: num('record', d.recordMs),
    settleMs: num('settle', 3000),
    clickIntervalMs: num('clickInterval', 250),
    clickSeed: num('clickSeed', 4242),
    levels,
    fpsFloor: num('fpsFloor', 30),
    levelsBeyondFloor: num('levelsBeyondFloor', 2),
    minLevelFrames: num('minLevelFrames', 60),
    renderScale: num('renderScale', 1),
    detailScale: num('detailScale', 1),
    parityOnly: flags.has('parity-only'),
    skipParity: flags.has('skip-parity'),
    trace: flags.has('trace'),
    gpuTimer: !flags.has('no-gpu-timer'),
    device: values.get('device') ?? null,
    resultsDir: values.get('out') ?? fileURLToPath(new URL('../../../results', import.meta.url)),
  };
}

export const PREVIEW_PORTS = { threejs: 4173, r3f: 4174 } as const;
export const DEV_PORTS = { threejs: 5173, r3f: 5174 } as const;

export function baseUrl(cfg: BenchConfig, impl: 'threejs' | 'r3f'): string {
  const port = cfg.serve === 'preview' ? PREVIEW_PORTS[impl] : DEV_PORTS[impl];
  return `http://localhost:${port}`;
}

/** эффективные множители нагрузки: точка свипа перекрывает значения по умолчанию */
export function effRenderScale(cfg: BenchConfig, load: LoadPoint): number {
  return load.renderScale ?? cfg.renderScale;
}

export function effDetailScale(cfg: BenchConfig, load: LoadPoint): number {
  return load.detailScale ?? cfg.detailScale;
}

/** URL прогона; hud=0 — HUD не трогает DOM во время замеров */
export function runUrl(
  cfg: BenchConfig,
  target: Target,
  load: LoadPoint,
  extra: Record<string, string> = {}
): string {
  const p = new URLSearchParams({
    scenario: cfg.scenario,
    warmup: String(cfg.warmupMs),
    record: String(cfg.recordMs),
    settle: String(cfg.settleMs),
    fpsFloor: String(cfg.fpsFloor),
    levels: cfg.levels.join(','),
    levelsBeyondFloor: String(cfg.levelsBeyondFloor),
    minLevelFrames: String(cfg.minLevelFrames),
    renderScale: String(effRenderScale(cfg, load)),
    detailScale: String(effDetailScale(cfg, load)),
    hud: '0',
    gpuTimer: cfg.gpuTimer ? '1' : '0',
    ...(target.extraParams ?? {}),
    ...extra,
  });
  if (load.objects !== undefined) p.set('objects', String(load.objects));
  if (load.shadowMapSize !== undefined) p.set('shadowMapSize', String(load.shadowMapSize));
  if (target.mode) p.set('mode', target.mode);
  return `${baseUrl(cfg, target.impl)}/?${p.toString()}`;
}
