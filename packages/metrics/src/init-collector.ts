import type { BenchInitResult } from './types.js';

export interface InitCollectorConfig {
  readonly scenarioId: string;
  readonly implementation: 'threejs' | 'r3f';
  readonly mode: 'ref' | 'state' | null;
  /** длина "тихого окна" без longtask, после которого считаем достигнутым TTI */
  readonly quietWindowMs: number;
  /** максимальное время ожидания TTI с момента TTFR; при превышении публикуем результат с tti_ms = max */
  readonly ttiTimeoutMs: number;
  readonly publishToWindow: boolean;
}

type Phase = 'idle' | 'recording' | 'done';

interface PerformanceMemory {
  readonly usedJSHeapSize: number;
}

function readHeap(): number | null {
  const perf = performance as Performance & { memory?: PerformanceMemory };
  return perf.memory?.usedJSHeapSize ?? null;
}

interface LongTaskEntry {
  readonly startTime: number;
  readonly duration: number;
}

/**
 * Собирает метрики холодного старта (TTFR / TTI / heap).
 *
 * Жизненный цикл:
 *   new InitCollector(...)   — подписываемся на longtask заранее (как можно раньше),
 *                              чтобы поймать "тяжёлый" момент инициализации.
 *   .markFirstFrame()        — вызывается ВНУТРИ rAF после первого render().
 *                              Здесь снимаем TTFR и первый замер heap.
 *   (после TTFR ждём тихого окна) — публикуем итог в window.__BENCH__.
 */
export class InitCollector {
  private readonly cfg: InitCollectorConfig;
  private phase: Phase = 'idle';
  private firstFrameMs: number | null = null;
  private firstFrameDurationMs = 0;
  private heapAtFirstFrame: number | null = null;
  private heapAtTti: number | null = null;
  private result: BenchInitResult | null = null;
  private onDoneCb: ((r: BenchInitResult) => void) | null = null;

  private readonly longTasks: LongTaskEntry[] = [];
  private observer: PerformanceObserver | null = null;
  private observerSupported = true;

  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private ttiDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cfg: InitCollectorConfig) {
    this.cfg = cfg;
    this.subscribeLongTasks();
    this.publish();
  }

  private subscribeLongTasks(): void {
    if (typeof PerformanceObserver === 'undefined') {
      this.observerSupported = false;
      return;
    }
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
        // longtask откладывает "тихое окно"
        if (this.firstFrameMs !== null && this.phase === 'recording') {
          this.scheduleQuietWindow();
        }
      });
      this.observer.observe({ type: 'longtask', buffered: true });
    } catch {
      this.observerSupported = false;
      this.observer = null;
    }
  }

  onDone(cb: (r: BenchInitResult) => void): void {
    this.onDoneCb = cb;
  }

  /**
   * Должен быть вызван внутри rAF сразу после первого render-вызова,
   * либо в onAfterRender-хуке рендерера.
   *
   * frameStartMs — timestamp в шкале performance.now() в начале кадра.
   * frameEndMs   — timestamp в той же шкале в конце кадра (после render).
   */
  markFirstFrame(frameStartMs: number, frameEndMs: number): void {
    if (this.firstFrameMs !== null) return;
    this.firstFrameMs = frameEndMs;
    this.firstFrameDurationMs = frameEndMs - frameStartMs;
    this.heapAtFirstFrame = readHeap();
    this.phase = 'recording';
    this.publish();

    if (!this.observerSupported) {
      // longtask не поддерживается — TTI измерить не можем, заканчиваем сразу.
      this.finish(null);
      return;
    }

    this.scheduleQuietWindow();
    this.ttiDeadlineTimer = setTimeout(() => {
      // достигли максимального окна ожидания — фиксируем TTI как сейчас
      this.finish(performance.now());
    }, this.cfg.ttiTimeoutMs);
  }

  private scheduleQuietWindow(): void {
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      // достигли quietWindowMs без новых longtask
      const lastTaskEnd =
        this.longTasks.length === 0
          ? this.firstFrameMs!
          : Math.max(
              ...this.longTasks.map((t) => t.startTime + t.duration)
            );
      const tti = Math.max(this.firstFrameMs!, lastTaskEnd);
      this.finish(tti);
    }, this.cfg.quietWindowMs);
  }

  private finish(ttiMs: number | null): void {
    if (this.phase === 'done') return;
    if (this.quietTimer !== null) clearTimeout(this.quietTimer);
    if (this.ttiDeadlineTimer !== null) clearTimeout(this.ttiDeadlineTimer);
    this.observer?.disconnect();

    this.heapAtTti = readHeap();

    const longTaskTotal = this.longTasks.reduce((s, t) => s + t.duration, 0);
    const result: BenchInitResult = {
      kind: 'init',
      scenarioId: this.cfg.scenarioId,
      implementation: this.cfg.implementation,
      mode: this.cfg.mode,
      ttfr_ms: this.firstFrameMs ?? 0,
      tti_ms: ttiMs,
      first_frame_duration_ms: this.firstFrameDurationMs,
      heap_mb_at_first_frame:
        this.heapAtFirstFrame === null ? null : this.heapAtFirstFrame / (1024 * 1024),
      heap_mb_at_tti:
        this.heapAtTti === null ? null : this.heapAtTti / (1024 * 1024),
      long_tasks_count: this.longTasks.length,
      long_tasks_total_ms: longTaskTotal,
      finishedAt: performance.now(),
    };

    this.result = result;
    this.phase = 'done';
    this.publish();
    this.onDoneCb?.(result);
  }

  private publish(): void {
    if (!this.cfg.publishToWindow) return;
    window.__BENCH__ = {
      status: this.phase === 'idle' ? 'idle' : this.phase === 'recording' ? 'recording' : 'done',
      result: this.result,
    };
  }
}
