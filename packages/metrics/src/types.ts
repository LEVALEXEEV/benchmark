/**
 * Метрики, снятые в стационарном режиме рендера (S1, S2).
 * Снимаются MetricsCollector через .tick() на каждый кадр.
 */
export interface BenchResult {
  readonly kind: 'frame';
  readonly scenarioId: string;
  readonly implementation: 'threejs' | 'r3f';
  /** для R3F: вариант обновления состояния (ref|state); для threejs — null */
  readonly mode: 'ref' | 'state' | null;
  readonly recordedFrames: number;
  readonly durationMs: number;
  readonly fps_avg: number;
  readonly fps_median: number;
  readonly fps_p1_low: number;
  readonly fps_p5_low: number;
  readonly frame_time_ms_avg: number;
  readonly frame_time_ms_median: number;
  readonly frame_time_ms_stddev: number;
  readonly frame_time_ms_p95: number;
  readonly frame_time_ms_p99: number;
  readonly heap_mb_peak: number | null;
  readonly startedAt: number;
  readonly finishedAt: number;
}

/**
 * Метрики холодного старта (S3).
 * Снимаются InitCollector один раз на загрузку страницы.
 *
 * Все временные метки — миллисекунды от performance.timeOrigin
 * (фактически navigationStart), чтобы не зависеть от того, в какой
 * момент сработал собственно код страницы.
 */
export interface BenchInitResult {
  readonly kind: 'init';
  readonly scenarioId: string;
  readonly implementation: 'threejs' | 'r3f';
  readonly mode: 'ref' | 'state' | null;
  /** от navigationStart до первого rAF, в котором отрисовался кадр */
  readonly ttfr_ms: number;
  /**
   * от navigationStart до момента, когда main-thread "тих" в течение
   * quietWindowMs (нет longtask >50ms). Если PerformanceObserver не
   * поддерживает longtask, поле = null.
   */
  readonly tti_ms: number | null;
  /** размер первого кадра, после которого зафиксировали TTFR */
  readonly first_frame_duration_ms: number;
  readonly heap_mb_at_first_frame: number | null;
  readonly heap_mb_at_tti: number | null;
  /** число longtask, зафиксированных до TTI (или до timeout-а) */
  readonly long_tasks_count: number;
  /** суммарная длительность longtask, мс */
  readonly long_tasks_total_ms: number;
  readonly finishedAt: number;
}

/**
 * Метрики отзывчивости на пользовательский ввод (S4).
 * Снимаются InputCollector: он сам синтезирует поток pointerdown-событий
 * по детерминированной траектории и измеряет задержку до визуального
 * отклика (подсветки объекта по raycast'у).
 *
 * input_latency_ms определяется как:
 *   (момент кадра, в котором подсветка целевого объекта фактически
 *    отрисована) − (performance.now() в начале обработчика pointerdown).
 *
 * Это включает в three.js — ожидание ближайшего кадра, а в R3F (mode=state)
 * дополнительно стоимость setState → реконсиляции → commit → ближайшего
 * кадра. mode=ref в R3F обновляет материал императивно (через ref), минуя
 * реконсиляцию, — это «правильный» путь R3F.
 */
export interface BenchInputResult {
  readonly kind: 'input';
  readonly scenarioId: string;
  readonly implementation: 'threejs' | 'r3f';
  readonly mode: 'ref' | 'state' | null;
  /** число синтезированных pointerdown-событий за период записи */
  readonly dispatched_clicks: number;
  /** число событий, попавших в объект (raycast hit) и измеренных */
  readonly recorded_samples: number;
  /** число событий, не попавших ни в один объект (промах raycast) */
  readonly missed_clicks: number;
  readonly input_latency_ms_avg: number;
  readonly input_latency_ms_median: number;
  readonly input_latency_ms_p95: number;
  readonly input_latency_ms_p99: number;
  readonly input_latency_ms_max: number;
  readonly input_latency_ms_stddev: number;
  /** среднее число кадров от pointerdown до отрисовки отклика */
  readonly frames_to_feedback_avg: number;
  readonly heap_mb_peak: number | null;
  readonly startedAt: number;
  readonly finishedAt: number;
}

/** FPS-метрики одного уровня (числа объектов) в свипе S5. */
export interface ScaleLevelResult {
  readonly count: number;
  readonly recordedFrames: number;
  readonly fps_avg: number;
  readonly fps_median: number;
  readonly fps_p1_low: number;
  readonly frame_time_ms_avg: number;
  readonly frame_time_ms_stddev: number;
  readonly frame_time_ms_p99: number;
  readonly heap_mb_peak: number | null;
}

/**
 * Метрики свипа по масштабу (S5).
 * Снимаются ScaleCollector: сцена прогоняется при возрастающем числе объектов,
 * на каждом уровне пишется FPS; свип останавливается, когда median FPS падает
 * ниже fpsFloor (найдена точка деградации).
 */
export interface BenchScaleResult {
  readonly kind: 'scale';
  readonly scenarioId: string;
  readonly implementation: 'threejs' | 'r3f';
  readonly mode: 'ref' | 'state' | null;
  readonly levels: readonly ScaleLevelResult[];
  /** первый count, где median FPS < fpsFloor; null — деградация не достигнута */
  readonly degradation_count: number | null;
  readonly fpsFloor: number;
  readonly finishedAt: number;
}

declare global {
  interface Window {
    __BENCH__?: {
      readonly status: 'idle' | 'warmup' | 'recording' | 'done';
      readonly result:
        | BenchResult
        | BenchInitResult
        | BenchInputResult
        | BenchScaleResult
        | null;
    };
  }
}
