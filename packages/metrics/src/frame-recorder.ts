import { mean, percentile, round4, sortedFinite, stddev } from './stats.js';
import type { FrameRaw, FrameSummary } from './types.js';

interface PerformanceMemory {
  readonly usedJSHeapSize: number;
}

export function readHeapMb(): number | null {
  const perf = performance as Performance & { memory?: PerformanceMemory };
  const bytes = perf.memory?.usedJSHeapSize;
  return bytes === undefined ? null : bytes / (1024 * 1024);
}

const HEAP_SAMPLE_INTERVAL_MS = 100;
const JANK_60_MS = 1000 / 60;
const JANK_30_MS = 1000 / 30;

/**
 * Покадровая запись с разбивкой времени кадра на фазы.
 *
 * Строка i описывает ПОЛНЫЙ цикл кадра i:
 *   start    — начало кадра относительно начала записи;
 *   frame    — start(i+1) − start(i): вся длительность цикла, включая работу
 *              между кадрами (React-коммиты вне rAF, GC, композитинг, ожидание);
 *   update   — beginRender − beginFrame: анимация/доставка значений в сцену;
 *   render   — endRender − beginRender: renderer.render() на CPU
 *              (подготовка и отправка команд; GPU работает асинхронно);
 *   gpu      — время GPU на кадр (EXT_disjoint_timer_query_webgl2), приходит
 *              с задержкой в несколько кадров и привязывается по номеру кадра;
 *              null там, где расширения нет или замер отброшен.
 * other = frame − update − render считается при анализе.
 *
 * Сырые ряды сохраняются целиком: в НИР2 оставались только сводки, и
 * ни распределения, ни периодические пики восстановить было нельзя.
 */
export class FrameRecorder {
  private readonly origin: number;
  private readonly starts: number[] = [];
  private readonly frames: number[] = [];
  private readonly updates: number[] = [];
  private readonly renders: number[] = [];
  private readonly heap: [number, number][] = [];
  private readonly ids: number[] = [];
  private readonly gpuById = new Map<number, number>();
  private curId = -1;

  private curStart = NaN;
  private curRenderStart = NaN;
  private curUpdate = NaN;
  private curRender = NaN;
  private lastHeapTs = -Infinity;

  constructor(origin: number) {
    this.origin = origin;
  }

  beginFrame(now: number, frameId: number): void {
    this.closeCurrent(now);
    this.curStart = now;
    this.curId = frameId;
    this.curUpdate = NaN;
    this.curRender = NaN;
    this.curRenderStart = NaN;
    if (now - this.lastHeapTs >= HEAP_SAMPLE_INTERVAL_MS) {
      this.lastHeapTs = now;
      const mb = readHeapMb();
      if (mb !== null) this.heap.push([round4(now - this.origin), round4(mb)]);
    }
  }

  beginRender(now: number): void {
    if (Number.isNaN(this.curStart)) return;
    this.curUpdate = now - this.curStart;
    this.curRenderStart = now;
  }

  endRender(now: number): void {
    if (Number.isNaN(this.curRenderStart)) return;
    this.curRender = now - this.curRenderStart;
  }

  /** замер GPU приходит позже кадра, поэтому кладётся по номеру кадра */
  gpuSample(frameId: number, gpuMs: number): void {
    this.gpuById.set(frameId, gpuMs);
  }

  /** закрывает последний кадр моментом `now` и прекращает запись */
  finish(now: number): void {
    this.closeCurrent(now);
    this.curStart = NaN;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  private closeCurrent(now: number): void {
    if (Number.isNaN(this.curStart)) return;
    this.starts.push(this.curStart - this.origin);
    this.ids.push(this.curId);
    this.frames.push(now - this.curStart);
    this.updates.push(this.curUpdate);
    this.renders.push(this.curRender);
  }

  /** значения GPU в порядке строк; NaN — замера нет */
  private gpuSeries(): number[] {
    return this.ids.map((id) => this.gpuById.get(id) ?? NaN);
  }

  raw(): FrameRaw {
    return {
      start_ms: this.starts.map(round4),
      gpu_ms: this.gpuSeries().map(round4),
      frame_ms: this.frames.map(round4),
      update_ms: this.updates.map(round4),
      render_ms: this.renders.map(round4),
      heap_mb: this.heap,
    };
  }

  summary(): FrameSummary {
    const frames = this.frames;
    const sorted = sortedFinite(frames);
    const n = sorted.length;
    const duration = n === 0 ? 0 : this.starts[n - 1]! - this.starts[0]! + frames[n - 1]!;
    const worst = (share: number): number => {
      const k = Math.max(1, Math.floor(n * share));
      return 1000 / mean(sorted.slice(n - k));
    };
    const others = frames.map((f, i) => f - this.updates[i]! - this.renders[i]!);
    const sUpd = sortedFinite(this.updates);
    const sRen = sortedFinite(this.renders);
    const heapVals = this.heap.map((h) => h[1]);
    const sGpu = sortedFinite(this.gpuSeries());
    let jank60 = 0;
    let jank30 = 0;
    for (const f of sorted) {
      if (f > JANK_60_MS) jank60++;
      if (f > JANK_30_MS) jank30++;
    }
    return {
      frames: n,
      duration_ms: round4(duration),
      fps_mean: n === 0 ? NaN : (n * 1000) / duration,
      fps_median: 1000 / percentile(sorted, 50),
      fps_p1_low: worst(0.01),
      fps_p5_low: worst(0.05),
      frame_ms_mean: mean(sorted),
      frame_ms_median: percentile(sorted, 50),
      frame_ms_stddev: stddev(sorted),
      frame_ms_p95: percentile(sorted, 95),
      frame_ms_p99: percentile(sorted, 99),
      frame_ms_max: n === 0 ? NaN : sorted[n - 1]!,
      jank_60_share: n === 0 ? NaN : jank60 / n,
      jank_30_share: n === 0 ? NaN : jank30 / n,
      update_ms_median: percentile(sUpd, 50),
      update_ms_p99: percentile(sUpd, 99),
      render_ms_median: percentile(sRen, 50),
      render_ms_p99: percentile(sRen, 99),
      other_ms_median: percentile(sortedFinite(others), 50),
      gpu_ms_median: percentile(sGpu, 50),
      gpu_ms_p99: percentile(sGpu, 99),
      gpu_samples: sGpu.length,
      heap_mb_start: heapVals.length ? heapVals[0]! : null,
      heap_mb_peak: heapVals.length ? Math.max(...heapVals) : null,
      heap_mb_end: heapVals.length ? heapVals[heapVals.length - 1]! : null,
    };
  }
}
