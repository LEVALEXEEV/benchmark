import { fileURLToPath } from 'node:url';
import { S5_LEVELS } from '@bench/scene-spec';

/**
 * Параметры серии. Что и зачем снимается — nir3-spec.md; формат данных —
 * docs/DATA.md. Всё, чего нет в спецификации, из стенда убрано: условия
 * (cpu×4, сеть, vsync), трасса GC, контрольные прогоны, повтор уровня S5.
 */

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

/**
 * Версии браузеров пула: сборки, которые Playwright 1.63.0 скачивает
 * командой `npm run browsers` (node_modules/playwright-core/browsers.json).
 * Версия задаётся точной версией Playwright в package.json и на всех
 * устройствах одинакова. Несовпадение останавливает серию.
 */
export const PINNED_BROWSER_VERSIONS: Record<BrowserName, string> = {
  chromium: '153.0.8010.12',
  firefox: '155.0',
  webkit: '26.6',
};

export type ScenarioId = 's1' | 's2' | 's3' | 's4' | 's5';

export interface Target {
  /** ключ варианта в именах файлов и manifest */
  readonly label: string;
  readonly impl: 'threejs' | 'r3f';
  readonly mode: string | null;
  readonly extraParams?: Readonly<Record<string, string>>;
}

const T = {
  threejs: { label: 'threejs', impl: 'threejs', mode: null },
  // S3: сцена статична, способа обновления нет — у R3F один вариант
  r3f: { label: 'r3f', impl: 'r3f', mode: null },
  ref: { label: 'r3f-ref', impl: 'r3f', mode: 'ref' },
  refCentral: { label: 'r3f-ref-central', impl: 'r3f', mode: 'ref-central' },
  state: { label: 'r3f-state', impl: 'r3f', mode: 'state' },
  parentState: { label: 'r3f-parent-state', impl: 'r3f', mode: 'ref', extraParams: { parentState: '1' } },
  events: { label: 'r3f-events', impl: 'r3f', mode: 'events' },
} as const satisfies Record<string, Target>;

/**
 * Варианты сценария (nir3-spec.md, раздел 2). Первый — three.js, эталон
 * паритета. Стоимость паттернов R3F измеряется в S2, events — в S4.
 */
export const TARGETS: Record<ScenarioId, readonly Target[]> = {
  s1: [T.threejs, T.ref],
  s2: [T.threejs, T.ref, T.refCentral, T.state, T.parentState],
  s3: [T.threejs, T.r3f],
  s4: [T.threejs, T.ref, T.events],
  s5: [T.threejs, T.ref],
};

/**
 * WebKit — дополнительная серия: vsync не снимается (кадр ≤ 60 FPS) и нет
 * GPU-таймера, поэтому S1 (нагрузка на GPU) не измерить; на S5 от ≈ 6400
 * объектов теряется контекст WebGL.
 */
export const SCENARIOS_BY_BROWSER: Record<BrowserName, readonly ScenarioId[]> = {
  chromium: ['s1', 's2', 's3', 's4', 's5'],
  firefox: ['s1', 's2', 's3', 's4', 's5'],
  webkit: ['s2', 's3', 's4'],
};

/**
 * Точки нагрузки S1: каждая нагружает GPU по своей оси — заливкой пикселей,
 * обработкой вершин или числом вызовов отрисовки.
 */
export interface LoadPoint {
  readonly id: string;
  readonly note: string;
  readonly objects?: number;
  readonly shadowMapSize?: number;
  readonly renderScale?: number;
  readonly detailScale?: number;
}

export const S1_LOADS: readonly LoadPoint[] = [
  { id: 'A', note: 'заливка: 300 объектов, 2× разрешение, тени 4096', objects: 300, shadowMapSize: 4096, renderScale: 2 },
  { id: 'B', note: 'вершины: 3000 объектов, ½ разрешения', objects: 3000, renderScale: 0.5 },
  { id: 'C', note: 'вызовы отрисовки: 3000 лёгких объектов, ½ разрешения', objects: 3000, renderScale: 0.5, detailScale: 0.25 },
];

/** сценарии без точек нагрузки идут одной точкой */
export const NO_LOAD: LoadPoint = { id: '-', note: 'базовая конфигурация' };

/** S4: клики */
export const CLICKS = { intervalMs: 250, seed: 4242, timeoutMs: 2000 } as const;

/** S5: свип по числу объектов, окна — на каждый уровень */
export const SWEEP = { levels: S5_LEVELS, fpsFloor: 30, levelsBeyondFloor: 2, minLevelFrames: 60 } as const;

/**
 * Повторы и окна по сценарию. Число повторов на вариант рассчитано по пилоту
 * (analysis/pilot.ipynb, 2026-10-15): различить 5% (S4 — 10%) при α = 0,05 и
 * мощности 0,8 по верхней границе разброса; не меньше 10; S2 — 30 из-за
 * двух уровней быстродействия процесса на M4.
 */
export const SCENARIO_DEFAULTS: Record<ScenarioId, { repeats: number; warmupMs: number; recordMs: number }> = {
  s1: { repeats: 10, warmupMs: 5000, recordMs: 30000 },
  s2: { repeats: 30, warmupMs: 5000, recordMs: 30000 },
  // S3: одна холодная загрузка, окон нет
  s3: { repeats: 45, warmupMs: 0, recordMs: 0 },
  s4: { repeats: 15, warmupMs: 5000, recordMs: 30000 },
  // S5: окна — на каждый уровень
  s5: { repeats: 29, warmupMs: 1500, recordMs: 3000 },
};

export interface BenchConfig {
  readonly scenario: ScenarioId;
  readonly targets: readonly Target[];
  readonly loads: readonly LoadPoint[];
  readonly browser: BrowserName;
  readonly build: boolean;
  readonly repeats: number;
  /** прогревочных прогонов на ячейку: выполняются, но не сохраняются */
  readonly warmupRuns: number;
  readonly pauseMs: number;
  readonly orderSeed: number;
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly parityOnly: boolean;
  readonly device: string | null;
  readonly resultsDir: string;
  /** имя кампании; папка серии — «<кампания> <время>» */
  readonly campaign: string | null;
  /** разрешить незакоммиченный код — только для отладки, в manifest code.clean = false */
  readonly allowDirty: boolean;
}

function usage(msg: string): never {
  throw new Error(
    `${msg}\n\nПример: npm run bench -- --scenario s2 --browser chromium\n` +
      'Флаги: --scenario --browser (chromium|firefox|webkit) --targets --loads (s1: A,B,C)\n' +
      '       --repeats --warmupRuns --pause --orderSeed --warmup --record\n' +
      '       --campaign --device --out --no-build --parity-only\n' +
      '       --allow-dirty (только для отладки: в manifest code.clean = false)'
  );
}

export function parseArgs(argv: readonly string[]): BenchConfig {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) usage(`Неожиданный аргумент ${a}`);
    const key = a.slice(2);
    if (['no-build', 'parity-only', 'allow-dirty'].includes(key)) {
      flags.add(key);
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`Флаг ${a} требует значение`);
    values.set(key, v);
    i++;
  }
  const known = new Set([
    'scenario', 'browser', 'targets', 'loads', 'repeats', 'warmupRuns', 'pause', 'orderSeed',
    'warmup', 'record', 'campaign', 'device', 'out',
  ]);
  for (const k of values.keys()) if (!known.has(k)) usage(`Неизвестный флаг --${k}`);

  const num = (k: string, def: number): number => {
    const raw = values.get(k);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) usage(`--${k}=${raw}: ожидается целое ≥ 0`);
    return n;
  };

  const scenario = (values.get('scenario') ?? 's1') as ScenarioId;
  if (!(scenario in TARGETS)) usage(`Неизвестный сценарий ${scenario}`);
  const browser = (values.get('browser') ?? 'chromium') as BrowserName;
  if (!(browser in SCENARIOS_BY_BROWSER)) usage(`Неизвестный браузер ${browser}`);
  if (!SCENARIOS_BY_BROWSER[browser].includes(scenario)) {
    usage(`${scenario} в ${browser} не снимается; доступно: ${SCENARIOS_BY_BROWSER[browser].join(', ')}`);
  }

  const available = TARGETS[scenario];
  const targetsRaw = values.get('targets');
  const targets = targetsRaw
    ? targetsRaw.split(',').map((l) => {
        const t = available.find((x) => x.label === l);
        if (!t) usage(`Вариант ${l} недоступен для ${scenario}; есть: ${available.map((x) => x.label).join(', ')}`);
        return t;
      })
    : available;
  if (!targets.some((t) => t.label === 'threejs')) usage('нужен вариант threejs — эталон паритета');

  const loadsRaw = values.get('loads');
  if (loadsRaw && scenario !== 's1') usage('--loads применим только к s1');
  const loads =
    scenario === 's1'
      ? loadsRaw
        ? loadsRaw.split(',').map((id) => S1_LOADS.find((l) => l.id === id) ?? usage(`Точка нагрузки ${id} неизвестна`))
        : S1_LOADS
      : [NO_LOAD];

  const campaign = values.get('campaign') ?? null;
  if (campaign !== null && !/^[a-z0-9][a-z0-9-]*$/.test(campaign)) usage('--campaign: латиница в нижнем регистре, цифры, дефис');

  const d = SCENARIO_DEFAULTS[scenario];
  return {
    scenario,
    targets,
    loads,
    browser,
    build: !flags.has('no-build'),
    repeats: num('repeats', d.repeats),
    warmupRuns: num('warmupRuns', 1),
    pauseMs: num('pause', 3000),
    orderSeed: num('orderSeed', Date.now() % 2 ** 31),
    warmupMs: num('warmup', d.warmupMs),
    recordMs: num('record', d.recordMs),
    parityOnly: flags.has('parity-only'),
    device: values.get('device') ?? null,
    resultsDir: values.get('out') ?? fileURLToPath(new URL('../../../results', import.meta.url)),
    campaign,
    allowDirty: flags.has('allow-dirty'),
  };
}

export const PORTS = { threejs: 4173, r3f: 4174 } as const;

export function effRenderScale(load: LoadPoint): number {
  return load.renderScale ?? 1;
}

/** URL прогона; hud=0 — HUD не трогает DOM во время замеров */
export function runUrl(cfg: BenchConfig, target: Target, load: LoadPoint, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({
    scenario: cfg.scenario,
    warmup: String(cfg.warmupMs),
    record: String(Math.max(1, cfg.recordMs)),
    fpsFloor: String(SWEEP.fpsFloor),
    levels: SWEEP.levels.join(','),
    levelsBeyondFloor: String(SWEEP.levelsBeyondFloor),
    minLevelFrames: String(SWEEP.minLevelFrames),
    renderScale: String(effRenderScale(load)),
    detailScale: String(load.detailScale ?? 1),
    hud: '0',
    ...(target.extraParams ?? {}),
    ...extra,
  });
  if (load.objects !== undefined) p.set('objects', String(load.objects));
  if (load.shadowMapSize !== undefined) p.set('shadowMapSize', String(load.shadowMapSize));
  if (target.mode) p.set('mode', target.mode);
  return `http://localhost:${PORTS[target.impl]}/?${p.toString()}`;
}
