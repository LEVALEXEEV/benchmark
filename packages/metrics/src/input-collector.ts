import { mean, percentile, stddev } from './stats.js';
import type { BenchInputResult } from './types.js';

export interface InputCollectorConfig {
  readonly scenarioId: string;
  readonly implementation: 'threejs' | 'r3f';
  readonly mode: 'ref' | 'state' | null;
  readonly warmupMs: number;
  readonly recordMs: number;
  /** период между синтезированными pointerdown-событиями, мс */
  readonly clickIntervalMs: number;
  /** seed для детерминированной траектории кликов */
  readonly seed: number;
  readonly publishToWindow: boolean;
}

type Phase = 'idle' | 'warmup' | 'recording' | 'done';

interface PerformanceMemory {
  readonly usedJSHeapSize: number;
}

function readHeap(): number | null {
  const perf = performance as Performance & { memory?: PerformanceMemory };
  return perf.memory?.usedJSHeapSize ?? null;
}

/** Mulberry32 — тот же детерминированный PRNG, что и в scene-spec. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Доля каждой стороны canvas, отсекаемая с краёв при выборе точки клика.
 * Облако объектов S4 проецируется в центральную часть кадра; стрельба точками
 * по этому региону поднимает долю попаданий raycast'а, не внося смещения в
 * сравнение (регион одинаков для обеих реализаций).
 */
const CLICK_REGION_INSET = 0.2;

interface Pending {
  readonly token: number;
  /** число кадров с момента диспатча до резолва */
  framesElapsed: number;
  t0: number;
  hit: boolean;
}

/**
 * InputCollector измеряет задержку «ввод → визуальный отклик» (S4).
 *
 * Принцип воспроизводимости: коллектор САМ синтезирует поток pointerdown-
 * событий по детерминированной (seeded) траектории и диспатчит их на canvas.
 * Так обе реализации (three.js и R3F) получают идентичный по таймингу и
 * координатам ввод — устраняется человеческий фактор и джиттер реального
 * указателя.
 *
 * Жизненный цикл:
 *   new InputCollector(cfg)
 *   .start(canvas)                 → warmup → recording
 *   .frame(now, renderedToken)     вызывается КАЖДЫЙ кадр после render():
 *                                  резолвит «висящий» клик и при наступлении
 *                                  момента — диспатчит следующий.
 *   .onPointerDown(t0, hit)        вызывается из обработчика pointerdown
 *                                  реализации (после raycast'а).
 *
 * Сопоставление «клик → отрисованный отклик» идёт по токену:
 *   - каждый диспатч получает монотонный token (== currentToken);
 *   - реализация, применив подсветку к объекту, отмечает этот token как
 *     «отрисованный» и передаёт его в .frame();
 *   - как только renderedToken догоняет token висящего клика, фиксируется
 *     задержка now − t0.
 */
export class InputCollector {
  private readonly cfg: InputCollectorConfig;
  private readonly rng: () => number;
  private phase: Phase = 'idle';
  private startTs = 0;
  private recordStartTs = 0;
  private lastDispatchTs = 0;
  private canvas: HTMLElement | null = null;

  /** токен текущего «в полёте» клика; реализация читает его при подсветке */
  currentToken = 0;
  private pending: Pending | null = null;

  private readonly latenciesMs: number[] = [];
  private readonly framesToFeedback: number[] = [];
  private dispatched = 0;
  private hits = 0;
  private misses = 0;
  private heapPeak: number | null = null;

  private result: BenchInputResult | null = null;
  private onDoneCb: ((r: BenchInputResult) => void) | null = null;

  constructor(cfg: InputCollectorConfig) {
    this.cfg = cfg;
    this.rng = mulberry32(cfg.seed);
    this.publish();
  }

  start(canvas: HTMLElement): void {
    this.canvas = canvas;
    this.phase = 'warmup';
    this.startTs = performance.now();
    this.publish();
  }

  onDone(cb: (r: BenchInputResult) => void): void {
    this.onDoneCb = cb;
  }

  /**
   * Вызывается обработчиком pointerdown реализации сразу после raycast'а.
   * t0  — performance.now() в начале обработчика (момент «прихода» ввода).
   * hit — попал ли клик в объект сцены.
   */
  onPointerDown(t0: number, hit: boolean): void {
    if (!this.pending) return;
    this.pending.t0 = t0;
    this.pending.hit = hit;
  }

  /** вызывается каждый кадр рендера после render(); см. описание класса */
  frame(now: number, renderedToken: number): void {
    if (this.phase === 'idle' || this.phase === 'done') return;

    const heap = readHeap();
    if (heap !== null) {
      this.heapPeak = this.heapPeak === null ? heap : Math.max(this.heapPeak, heap);
    }

    if (this.phase === 'warmup') {
      if (now - this.startTs >= this.cfg.warmupMs) {
        this.phase = 'recording';
        this.recordStartTs = now;
        // первый клик диспатчим сразу на следующем кадре
        this.lastDispatchTs = now - this.cfg.clickIntervalMs;
        this.publish();
      }
      return;
    }

    // recording
    if (this.pending && this.pending.hit && this.pending.t0 > 0) {
      this.pending.framesElapsed++;
      if (renderedToken === this.pending.token) {
        this.latenciesMs.push(now - this.pending.t0);
        this.framesToFeedback.push(this.pending.framesElapsed);
        this.hits++;
        this.pending = null;
      }
    }

    if (now - this.recordStartTs >= this.cfg.recordMs) {
      this.finish(now);
      return;
    }

    if (this.pending === null && now - this.lastDispatchTs >= this.cfg.clickIntervalMs) {
      this.lastDispatchTs = now;
      this.dispatchClick();
    }
  }

  private dispatchClick(): void {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const span = 1 - 2 * CLICK_REGION_INSET;
    const x = rect.width * (CLICK_REGION_INSET + this.rng() * span);
    const y = rect.height * (CLICK_REGION_INSET + this.rng() * span);

    const token = ++this.currentToken;
    this.pending = { token, framesElapsed: 0, t0: 0, hit: false };
    this.dispatched++;

    const ev = new PointerEvent('pointerdown', {
      clientX: rect.left + x,
      clientY: rect.top + y,
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    });
    // обработчик реализации отработает синхронно внутри dispatchEvent
    this.canvas.dispatchEvent(ev);

    // промах raycast'а — измерять нечего, освобождаем слот под следующий клик
    if (this.pending && !this.pending.hit) {
      this.misses++;
      this.pending = null;
    }
  }

  private finish(now: number): void {
    if (this.phase === 'done') return;
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const result: BenchInputResult = {
      kind: 'input',
      scenarioId: this.cfg.scenarioId,
      implementation: this.cfg.implementation,
      mode: this.cfg.mode,
      dispatched_clicks: this.dispatched,
      recorded_samples: this.hits,
      missed_clicks: this.misses,
      input_latency_ms_avg: mean(this.latenciesMs),
      input_latency_ms_median: percentile(sorted, 50),
      input_latency_ms_p95: percentile(sorted, 95),
      input_latency_ms_p99: percentile(sorted, 99),
      input_latency_ms_max: sorted.length ? sorted[sorted.length - 1]! : 0,
      input_latency_ms_stddev: stddev(this.latenciesMs),
      frames_to_feedback_avg: mean(this.framesToFeedback),
      heap_mb_peak: this.heapPeak === null ? null : this.heapPeak / (1024 * 1024),
      startedAt: this.recordStartTs,
      finishedAt: now,
    };

    this.result = result;
    this.phase = 'done';
    this.publish();
    this.onDoneCb?.(result);
  }

  private publish(): void {
    if (!this.cfg.publishToWindow) return;
    window.__BENCH__ = {
      status: this.phase,
      result: this.result,
    };
  }
}
