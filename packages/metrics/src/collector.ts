import { mean, percentile, stddev } from './stats.js';
import type { BenchResult } from './types.js';

export interface CollectorConfig {
  readonly scenarioId: string;
  readonly implementation: 'threejs' | 'r3f';
  readonly mode: 'ref' | 'state' | null;
  readonly warmupMs: number;
  readonly recordMs: number;
  /** автоматически выставлять window.__BENCH__ */
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
 * MetricsCollector подключается к циклу рендера через .tick() на каждый кадр.
 *
 * Жизненный цикл:
 *   .start()  → warmup (warmupMs)  → recording (recordMs)  → result published.
 *
 * Результат публикуется в window.__BENCH__ для последующего считывания
 * из Playwright или devtools.
 */
export class MetricsCollector {
  private readonly cfg: CollectorConfig;
  private phase: Phase = 'idle';
  private startTs = 0;
  private recordStartTs = 0;
  private lastFrameTs = 0;
  private readonly frameTimesMs: number[] = [];
  private heapPeak: number | null = null;
  private result: BenchResult | null = null;
  private onDoneCb: ((r: BenchResult) => void) | null = null;

  constructor(cfg: CollectorConfig) {
    this.cfg = cfg;
    this.publish();
  }

  start(): void {
    this.phase = 'warmup';
    this.startTs = performance.now();
    this.lastFrameTs = this.startTs;
    this.publish();
  }

  onDone(cb: (r: BenchResult) => void): void {
    this.onDoneCb = cb;
  }

  /** вызывается на каждый кадр рендера */
  tick(): void {
    const now = performance.now();
    const delta = now - this.lastFrameTs;
    this.lastFrameTs = now;

    if (this.phase === 'idle' || this.phase === 'done') return;

    if (this.phase === 'warmup') {
      if (now - this.startTs >= this.cfg.warmupMs) {
        this.phase = 'recording';
        this.recordStartTs = now;
        this.publish();
      }
      return;
    }

    if (this.phase === 'recording') {
      this.frameTimesMs.push(delta);
      const heap = readHeap();
      if (heap !== null) {
        this.heapPeak = this.heapPeak === null ? heap : Math.max(this.heapPeak, heap);
      }

      if (now - this.recordStartTs >= this.cfg.recordMs) {
        this.finish(now);
      }
    }
  }

  private finish(now: number): void {
    const frames = this.frameTimesMs;
    const durationMs = now - this.recordStartTs;
    const sortedAsc = [...frames].sort((a, b) => a - b);
    const sortedDesc = [...frames].sort((a, b) => b - a);
    const avgFrame = mean(frames);

    const worst1pct = sortedDesc.slice(0, Math.max(1, Math.floor(frames.length * 0.01)));
    const worst5pct = sortedDesc.slice(0, Math.max(1, Math.floor(frames.length * 0.05)));

    const result: BenchResult = {
      kind: 'frame',
      scenarioId: this.cfg.scenarioId,
      implementation: this.cfg.implementation,
      mode: this.cfg.mode,
      recordedFrames: frames.length,
      durationMs,
      fps_avg: 1000 / avgFrame,
      fps_median: 1000 / percentile(sortedAsc, 50),
      fps_p1_low: 1000 / mean(worst1pct),
      fps_p5_low: 1000 / mean(worst5pct),
      frame_time_ms_avg: avgFrame,
      frame_time_ms_median: percentile(sortedAsc, 50),
      frame_time_ms_stddev: stddev(frames),
      frame_time_ms_p95: percentile(sortedAsc, 95),
      frame_time_ms_p99: percentile(sortedAsc, 99),
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
