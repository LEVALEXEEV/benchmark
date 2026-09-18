/**
 * Схема результатов стенда, версия 2 (НИР3).
 *
 * Каждый результат несёт meta с параметрами прогона и окружением страницы,
 * чтобы прогон был самодостаточной единицей датасета. Сырые ряды хранятся
 * рядом со сводками. NaN сериализуется в JSON как null.
 */
export const RESULT_SCHEMA_VERSION = 2;

export type BenchStatus =
  | 'idle'
  | 'building'
  | 'warmup'
  | 'recording'
  | 'settling'
  | 'parity-ready'
  | 'done'
  | 'error';

export interface BenchWindowState {
  readonly status: BenchStatus;
  readonly result: unknown;
  readonly error: string | null;
}

export type ImplName = 'threejs' | 'r3f';

export interface PageEnv {
  readonly userAgent: string;
  readonly crossOriginIsolated: boolean;
  /** минимальный наблюдаемый шаг performance.now(), мс */
  readonly timerResolutionMs: number;
  readonly devicePixelRatio: number;
  /** 'production' | 'development' — прогоны на dev-сборке недопустимы */
  readonly buildMode: string;
  readonly libs: Readonly<Record<string, string>>;
  readonly gl: {
    readonly version: string;
    readonly vendor: string | null;
    readonly renderer: string | null;
    readonly contextAttributes: WebGLContextAttributes | null;
    readonly drawingBufferWidth: number;
    readonly drawingBufferHeight: number;
    readonly canvasCssWidth: number;
    readonly canvasCssHeight: number;
  };
  /** доступен ли GPU-таймер (EXT_disjoint_timer_query_webgl2) */
  readonly gpuTimer: boolean;
  readonly renderer: {
    readonly pixelRatio: number;
    readonly clearAlpha: number;
    readonly toneMapping: number;
    readonly outputColorSpace: string;
    readonly shadowMapEnabled: boolean;
    readonly shadowMapType: number;
  };
}

export interface BenchMeta {
  readonly schema: number;
  readonly scenario: string;
  readonly specId: string;
  readonly impl: ImplName;
  readonly mode: string | null;
  readonly parentState: boolean;
  readonly params: Readonly<Record<string, unknown>>;
  readonly env: PageEnv;
}

export interface FrameRaw {
  readonly start_ms: readonly number[];
  /** время GPU кадра, мс; NaN → null, если расширение недоступно */
  readonly gpu_ms: readonly number[];
  readonly frame_ms: readonly number[];
  readonly update_ms: readonly number[];
  readonly render_ms: readonly number[];
  /** [t_ms от начала записи, usedJSHeapSize МБ] раз в ~100 мс */
  readonly heap_mb: readonly (readonly [number, number])[];
}

export interface FrameSummary {
  readonly frames: number;
  readonly duration_ms: number;
  readonly fps_mean: number;
  readonly fps_median: number;
  /** 1000 / среднее худшего 1% времён кадра */
  readonly fps_p1_low: number;
  readonly fps_p5_low: number;
  readonly frame_ms_mean: number;
  readonly frame_ms_median: number;
  readonly frame_ms_stddev: number;
  readonly frame_ms_p95: number;
  readonly frame_ms_p99: number;
  readonly frame_ms_max: number;
  /** доля кадров длиннее 16,7 мс и 33,3 мс */
  readonly jank_60_share: number;
  readonly jank_30_share: number;
  readonly update_ms_median: number;
  readonly update_ms_p99: number;
  readonly render_ms_median: number;
  readonly render_ms_p99: number;
  readonly other_ms_median: number;
  /** время GPU (только там, где доступен EXT_disjoint_timer_query_webgl2) */
  readonly gpu_ms_median: number;
  readonly gpu_ms_p99: number;
  readonly gpu_samples: number;
  readonly heap_mb_start: number | null;
  readonly heap_mb_peak: number | null;
  readonly heap_mb_end: number | null;
}

/** S1, S2 — стационарный режим рендера */
export interface FrameRunResult {
  readonly kind: 'frame';
  readonly meta: BenchMeta;
  readonly summary: FrameSummary;
  readonly raw: FrameRaw;
}

/** S3 — холодный старт. Все метки — мс от performance.timeOrigin. */
export interface InitRunResult {
  readonly kind: 'init';
  readonly meta: BenchMeta;
  readonly nav: {
    readonly response_end_ms: number;
    readonly dom_interactive_ms: number;
    readonly dom_content_loaded_end_ms: number;
    readonly load_event_end_ms: number;
  };
  /** момент, когда все модули бандла исполнены и стартует код приложения */
  readonly js_ready_ms: number;
  /** endRender первого кадра, в котором в сцене все объекты спецификации */
  readonly ttfr_submit_ms: number;
  /** начало следующего кадра — ближайшая доступная оценка «кадр показан» */
  readonly ttfr_frame_ms: number;
  /** ttfr_submit − js_ready: построение сцены + старт фреймворка + первый рендер */
  readonly init_ms: number;
  readonly first_frame_render_ms: number;
  /** сколько кадров отрисовано до появления всех объектов (у R3F возможно > 0) */
  readonly frames_before_ready: number;
  readonly long_tasks_supported: boolean;
  readonly long_tasks: readonly (readonly [number, number])[];
  /** Σ max(0, d − 50) по long task, пересекающим интервал [0, ttfr_frame] */
  readonly tbt_to_ttfr_ms: number | null;
  /** то же до конца окна settle */
  readonly tbt_total_ms: number | null;
  readonly resources: {
    readonly script_count: number;
    readonly script_encoded_kb: number;
    readonly script_decoded_kb: number;
    readonly total_count: number;
    readonly total_encoded_kb: number;
  };
  readonly heap_mb_at_ttfr: number | null;
  readonly heap_mb_at_end: number | null;
}

export type InputOutcome = 'ok' | 'miss' | 'timeout' | 'superseded';

/**
 * Один клик S4. Фазы задержки (мс):
 *   queue      — event.timeStamp → начало обработки (доставка ввода браузером);
 *   dispatch   — все синхронные обработчики события, включая микрозадачи
 *                между ними: для дискретных событий React коммитит SyncLane
 *                именно здесь;
 *   apply      — сообщение реализации о попадании → отклик фактически в сцене
 *                (0 у императивных путей; у React — рендер и коммит);
 *   commit     — ожидание применения ПОСЛЕ окончания обработки события
 *                (ненулевое, если обновление ушло в отложенную очередь React);
 *   frame_wait — ожидание кадра, который его отрисует;
 *   render     — renderer.render() кадра с откликом.
 */
export interface InputSample {
  readonly seq: number;
  readonly t_ms: number;
  readonly outcome: InputOutcome;
  readonly queue_ms: number;
  readonly dispatch_ms: number;
  readonly apply_ms: number;
  readonly commit_ms: number;
  readonly frame_wait_ms: number;
  readonly render_ms: number;
  /** event.timeStamp → конец renderer.render() кадра с откликом (основная метрика) */
  readonly latency_render_ms: number;
  /** event.timeStamp → начало следующего кадра */
  readonly latency_frame_ms: number;
  /** номер кадра с откликом: 1 — первый кадр, начавшийся после события */
  readonly frames: number;
  /** момент применения определён проверкой цвета в начале рендера, а не сигналом реализации */
  readonly applied_inferred: boolean;
}

export interface InputRunResult {
  readonly kind: 'input';
  readonly meta: BenchMeta;
  readonly summary: {
    readonly clicks: number;
    readonly ok: number;
    readonly miss: number;
    readonly timeout: number;
    readonly superseded: number;
    readonly latency_render_ms_median: number;
    readonly latency_render_ms_p95: number;
    readonly latency_render_ms_mean: number;
    readonly latency_frame_ms_median: number;
    readonly queue_ms_median: number;
    readonly dispatch_ms_median: number;
    readonly apply_ms_median: number;
    readonly commit_ms_median: number;
    readonly frame_wait_ms_median: number;
    readonly render_ms_median: number;
  };
  readonly samples: readonly InputSample[];
  readonly frames: { readonly summary: FrameSummary; readonly raw: FrameRaw };
}

export interface ScaleLevel {
  readonly count: number;
  /** от запроса уровня до готовности сцены (объекты в графе сцены) */
  readonly build_ms: number;
  readonly summary: FrameSummary;
  readonly raw: FrameRaw;
}

export interface ScaleRunResult {
  readonly kind: 'scale';
  readonly meta: BenchMeta;
  readonly levels: readonly ScaleLevel[];
  readonly fpsFloor: number;
  /** первый уровень с median FPS < fpsFloor */
  readonly first_below_floor: number | null;
  /** число объектов, при котором median FPS = 60 / 30 (лог-линейная интерполяция) */
  readonly capacity_fps60: number | null;
  readonly capacity_fps30: number | null;
  readonly stopped_reason: 'beyond-floor' | 'levels-exhausted' | 'too-slow';
}

export type BenchResult = FrameRunResult | InitRunResult | InputRunResult | ScaleRunResult;
