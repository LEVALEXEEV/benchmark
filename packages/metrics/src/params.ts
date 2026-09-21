/**
 * Параметры прогона из URL. Разбор общий для обеих реализаций — чтобы
 * одинаковый URL гарантированно давал одинаковую конфигурацию.
 *
 * Невалидные значения — ошибка, а не тихий дефолт: в НИР2 любой mode,
 * кроме 'state', молча превращался в 'ref', и опечатка в harness
 * незаметно подменила бы вариант.
 */
export interface RunParams {
  readonly scenario: string;
  readonly mode: string | null;
  readonly warmupMs: number;
  readonly recordMs: number;
  /** S3: сколько ждать long tasks после первого кадра */
  readonly settleMs: number;
  /** S5 */
  readonly fpsFloor: number;
  readonly levels: readonly number[] | null;
  /** S5: сколько уровней пройти ПОСЛЕ первого падения ниже fpsFloor */
  readonly levelsBeyondFloor: number;
  /** S5: минимум кадров на уровень */
  readonly minLevelFrames: number;
  /** S5: после свипа повторно записать контрольный уровень (дрейф внутри прогона) */
  readonly levelControl: boolean;
  /** множитель pixelRatio; 0.5 — проверка GPU-bound (S1) на половинном разрешении */
  readonly renderScale: number;
  /** множитель сегментов процедурной геометрии (диагностика S1) */
  readonly detailScale: number;
  /** S1: число объектов в точке нагрузочного свипа */
  readonly objects: number | null;
  /** S1: размер карты теней */
  readonly shadowMapSize: number | null;
  /** фиксированное время анимации, с — для проверки паритета кадров */
  readonly freezeTime: number | null;
  /** режим проверки паритета: сцена рендерится, замеры не ведутся */
  readonly parity: boolean;
  /** S5 в режиме паритета: число объектов */
  readonly parityCount: number | null;
  /** включать GPU-таймер; отключение позволяет оценить его собственные накладные расходы */
  readonly gpuTimer: boolean;
  /** обновлять HUD (для ручного просмотра); harness выключает */
  readonly hud: boolean;
  /** R3F-антипаттерн: state в родителе Canvas меняется 2 раза в секунду */
  readonly parentState: boolean;
}

function num(p: URLSearchParams, key: string, def: number, min = 0): number {
  const raw = p.get(key);
  if (raw === null || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) {
    throw new Error(`URL-параметр ${key}=${raw} невалиден (ожидается число ≥ ${min})`);
  }
  return v;
}

function flag(p: URLSearchParams, key: string, def: boolean): boolean {
  const raw = p.get(key);
  if (raw === null) return def;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error(`URL-параметр ${key}=${raw} невалиден (ожидается 0/1)`);
}

export function readRunParams(search: string = window.location.search): RunParams {
  const p = new URLSearchParams(search);
  const levelsRaw = p.get('levels');
  let levels: number[] | null = null;
  if (levelsRaw) {
    levels = levelsRaw.split(',').map((s) => Number(s));
    if (levels.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new Error(`URL-параметр levels=${levelsRaw} невалиден`);
    }
    for (let i = 1; i < levels.length; i++) {
      if (levels[i]! <= levels[i - 1]!) throw new Error('levels должны строго возрастать');
    }
  }
  const freezeRaw = p.get('freezeTime');
  const parityCountRaw = p.get('parityCount');
  return {
    scenario: p.get('scenario') ?? 's1',
    mode: p.get('mode'),
    warmupMs: num(p, 'warmup', 5000),
    recordMs: num(p, 'record', 30000, 1),
    settleMs: num(p, 'settle', 3000),
    fpsFloor: num(p, 'fpsFloor', 30, 1),
    levels,
    levelsBeyondFloor: num(p, 'levelsBeyondFloor', 2),
    minLevelFrames: num(p, 'minLevelFrames', 60),
    levelControl: flag(p, 'levelControl', false),
    renderScale: num(p, 'renderScale', 1, 0.05),
    detailScale: num(p, 'detailScale', 1, 0.01),
    objects: p.get('objects') === null ? null : num(p, 'objects', 0, 1),
    shadowMapSize: p.get('shadowMapSize') === null ? null : num(p, 'shadowMapSize', 0, 16),
    freezeTime: freezeRaw === null ? null : num(p, 'freezeTime', 0),
    parity: flag(p, 'parity', false),
    parityCount: parityCountRaw === null ? null : num(p, 'parityCount', 0, 1),
    gpuTimer: flag(p, 'gpuTimer', true),
    hud: flag(p, 'hud', true),
    parentState: flag(p, 'parentState', false),
  };
}

/** допустимые режимы по сценарию; null — сценарий без режимов */
export const MODES_BY_SCENARIO: Record<string, { r3f: readonly string[]; threejs: readonly string[] }> = {
  s1: { threejs: [], r3f: ['ref'] },
  s2: { threejs: [], r3f: ['ref', 'ref-central', 'state'] },
  s3: { threejs: [], r3f: [] },
  s4: { threejs: [], r3f: ['ref', 'state', 'events'] },
  s5: { threejs: [], r3f: ['ref', 'ref-central', 'state'] },
};

/**
 * Проверяет mode для реализации и возвращает нормализованное значение.
 * Для сценариев без режимов mode обязан отсутствовать.
 */
export function resolveMode(params: RunParams, impl: 'threejs' | 'r3f'): string | null {
  const allowed = MODES_BY_SCENARIO[params.scenario];
  if (!allowed) throw new Error(`Неизвестный сценарий ${params.scenario}`);
  const list = allowed[impl];
  if (list.length === 0) {
    if (params.mode !== null) {
      throw new Error(`Сценарий ${params.scenario} (${impl}) не поддерживает mode=${params.mode}`);
    }
    return null;
  }
  const mode = params.mode ?? list[0]!;
  if (!list.includes(mode)) {
    throw new Error(
      `mode=${mode} недопустим для ${params.scenario}/${impl}; допустимо: ${list.join(', ')}`
    );
  }
  return mode;
}
