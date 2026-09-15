import { mean, percentile, stddev } from './stats.js';
import type { BenchScaleResult, ScaleLevelResult } from './types.js';

export interface ScaleCollectorConfig {
  readonly scenarioId: string;
  readonly implementation: 'threejs' | 'r3f';
  readonly mode: 'ref' | 'state' | null;
  /** возрастающий список чисел объектов: [100, 500, 1000, ...] */
  readonly levels: readonly number[];
  /** прогрев на каждом уровне, мс */
  readonly warmupMs: number;
  /** запись FPS на каждом уровне, мс */
  readonly recordMs: number;
  /** порог median FPS, ниже которого фиксируем деградацию и останавливаем свип */
  readonly fpsFloor: number;
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

/**
 * ScaleCollector прогоняет одну и ту же анимированную сцену при возрастающем
 * числе объектов и ищет точку деградации производительности (S5).
 *
 * Сам коллектор НЕ строит сцену — он лишь управляет прогрессией уровней и
 * измеряет FPS. Перестроение сцены под новый уровень делегируется реализации
 * через onAdvanceLevel(count): three.js пересобирает сцену, R3F меняет state
 * с числом мешей. Это сохраняет инвариант «обе реализации строят сцену каждая
 * своим способом из общего числа объектов».
 *
 * Жизненный цикл:
 *   new ScaleCollector(cfg)
 *   .onAdvanceLevel(cb)   — РЕГИСТРИРУЕТСЯ до start(); вызывается на каждый
 *                           новый уровень (включая первый) с числом объектов.
 *   .start()              — строит уровень 0 (через onAdvanceLevel) и входит
 *                           в warmup.
 *   .tick()               — вызывается каждый кадр; ведёт warmup→recording,
 *                           по окончании recordMs финализирует уровень и либо
 *                           переходит к следующему, либо завершает свип.
 *
 * Свип завершается, когда median FPS уровня < fpsFloor (деградация найдена)
 * либо когда уровни закончились.
 */
export class ScaleCollector {
  private readonly cfg: ScaleCollectorConfig;
  private phase: Phase = 'idle';
  private levelIndex = 0;
  private levelStartTs = 0;
  private recordStartTs = 0;
  private lastFrameTs = 0;
  private frameTimesMs: number[] = [];
  private heapPeak: number | null = null;

  private readonly levelResults: ScaleLevelResult[] = [];
  private degradationCount: number | null = null;

  private result: BenchScaleResult | null = null;
  private onAdvanceCb: ((count: number) => void) | null = null;
  private onDoneCb: ((r: BenchScaleResult) => void) | null = null;

  constructor(cfg: ScaleCollectorConfig) {
    this.cfg = cfg;
    this.publish();
  }

  onAdvanceLevel(cb: (count: number) => void): void {
    this.onAdvanceCb = cb;
  }

  onDone(cb: (r: BenchScaleResult) => void): void {
    this.onDoneCb = cb;
  }

  /** число объектов текущего уровня (для HUD реализации) */
  get currentCount(): number {
    return this.cfg.levels[this.levelIndex] ?? 0;
  }

  start(): void {
    if (this.cfg.levels.length === 0) {
      this.finishAll();
      return;
    }
    this.levelIndex = 0;
    this.enterLevel(performance.now());
  }

  private enterLevel(now: number): void {
    this.phase = 'warmup';
    this.levelStartTs = now;
    this.lastFrameTs = now;
    this.frameTimesMs = [];
    this.heapPeak = null;
    this.publish();
    // реализация строит сцену под этот уровень
    this.onAdvanceCb?.(this.cfg.levels[this.levelIndex]!);
  }

  /** вызывается на каждый кадр рендера */
  tick(): void {
    const now = performance.now();
    const delta = now - this.lastFrameTs;
    this.lastFrameTs = now;

    if (this.phase === 'idle' || this.phase === 'done') return;

    if (this.phase === 'warmup') {
      if (now - this.levelStartTs >= this.cfg.warmupMs) {
        this.phase = 'recording';
        this.recordStartTs = now;
        this.publish();
      }
      return;
    }

    // recording
    this.frameTimesMs.push(delta);
    const heap = readHeap();
    if (heap !== null) {
      this.heapPeak = this.heapPeak === null ? heap : Math.max(this.heapPeak, heap);
    }

    if (now - this.recordStartTs >= this.cfg.recordMs) {
      this.finalizeLevel();
    }
  }

  private finalizeLevel(): void {
    const frames = this.frameTimesMs;
    const sortedAsc = [...frames].sort((a, b) => a - b);
    const sortedDesc = [...frames].sort((a, b) => b - a);
    const avgFrame = mean(frames);
    const worst1pct = sortedDesc.slice(0, Math.max(1, Math.floor(frames.length * 0.01)));

    const level: ScaleLevelResult = {
      count: this.cfg.levels[this.levelIndex]!,
      recordedFrames: frames.length,
      fps_avg: avgFrame > 0 ? 1000 / avgFrame : 0,
      fps_median: 1000 / percentile(sortedAsc, 50),
      fps_p1_low: 1000 / mean(worst1pct),
      frame_time_ms_avg: avgFrame,
      frame_time_ms_stddev: stddev(frames),
      frame_time_ms_p99: percentile(sortedAsc, 99),
      heap_mb_peak: this.heapPeak === null ? null : this.heapPeak / (1024 * 1024),
    };
    this.levelResults.push(level);

    const degraded = level.fps_median < this.cfg.fpsFloor;
    if (degraded && this.degradationCount === null) {
      this.degradationCount = level.count;
    }

    const isLast = this.levelIndex >= this.cfg.levels.length - 1;
    if (degraded || isLast) {
      this.finishAll();
      return;
    }

    this.levelIndex++;
    this.enterLevel(performance.now());
  }

  private finishAll(): void {
    if (this.phase === 'done') return;
    this.result = {
      kind: 'scale',
      scenarioId: this.cfg.scenarioId,
      implementation: this.cfg.implementation,
      mode: this.cfg.mode,
      levels: this.levelResults,
      degradation_count: this.degradationCount,
      fpsFloor: this.cfg.fpsFloor,
      finishedAt: performance.now(),
    };
    this.phase = 'done';
    this.publish();
    this.onDoneCb?.(this.result);
  }

  private publish(): void {
    if (!this.cfg.publishToWindow) return;
    window.__BENCH__ = {
      status: this.phase,
      result: this.result,
    };
  }
}
