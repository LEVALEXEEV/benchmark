/**
 * Результат прогона, который страница отдаёт harness (НИР3, серия r3).
 *
 * Только сырые замеры — метрики (медианы, p99, ёмкость, фазы) считает
 * анализ. Harness пишет замеры в CSV прогона (формат — docs/DATA.md),
 * meta — в manifest серии. NaN сериализуется в JSON как null.
 */
export const RESULT_SCHEMA_VERSION = 3;

export type BenchStatus =
  | 'idle'
  | 'building'
  | 'warmup'
  | 'recording'
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

/**
 * Покадровые ряды окна записи; индекс — номер кадра. Длительности, мс:
 *   frame  — от начала кадра до начала следующего;
 *   update — beginFrame → beginRender (анимация, доставка значений в сцену);
 *   render — renderer.render() на CPU;
 *   gpu    — время GPU на кадр; NaN, если таймера нет или замер отброшен.
 */
export interface FrameRows {
  readonly frame_ms: readonly number[];
  readonly update_ms: readonly number[];
  readonly render_ms: readonly number[];
  readonly gpu_ms: readonly number[];
}

/** S1, S2 */
export interface FrameRunResult {
  readonly kind: 'frame';
  readonly meta: BenchMeta;
  readonly frames: FrameRows;
}

/**
 * S3 — холодный старт. Отметки — мс от начала навигации (timeOrigin) в
 * одних и тех же точках обеих реализаций.
 */
export interface InitRunResult {
  readonly kind: 'init';
  readonly meta: BenchMeta;
  /** все модули бандла исполнены, стартует код приложения */
  readonly code_ready_ms: number;
  /** начало renderer.render() первого кадра со всеми объектами сцены */
  readonly render_start_ms: number;
  /** конец этого renderer.render() — время до первого кадра */
  readonly render_end_ms: number;
}

export type InputOutcome = 'ok' | 'miss' | 'timeout' | 'superseded';

/**
 * Один клик S4. Отметки — мс от начала окна записи; NaN — этапа не было
 * (промах, таймаут).
 */
export interface InputClick {
  readonly click: number;
  readonly outcome: InputOutcome;
  /** event.timeStamp — браузер создал событие */
  readonly event_ms: number;
  /** первый обработчик на странице (capture на canvas) */
  readonly handler_start_ms: number;
  /** все синхронные обработчики отработали (bubble на window) */
  readonly handler_end_ms: number;
  /** цвет объекта в сцене фактически изменился; ≤ handler_end — применён внутри обработчика */
  readonly applied_ms: number;
  /** renderer.render() кадра, в котором отклик впервые в сцене */
  readonly render_start_ms: number;
  readonly render_end_ms: number;
}

export interface InputRunResult {
  readonly kind: 'input';
  readonly meta: BenchMeta;
  readonly clicks: readonly InputClick[];
}

/** S5 — один уровень свипа: длительности кадров окна записи, мс */
export interface ScaleLevel {
  readonly objects: number;
  readonly frame_ms: readonly number[];
}

export interface ScaleRunResult {
  readonly kind: 'scale';
  readonly meta: BenchMeta;
  readonly levels: readonly ScaleLevel[];
}

export type BenchResult = FrameRunResult | InitRunResult | InputRunResult | ScaleRunResult;
