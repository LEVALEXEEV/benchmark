import { FrameRecorder } from './frame-recorder.js';
import { bench, type FrameProbe } from './runtime.js';
import type { ScaleLevel, ScaleRunResult } from './types.js';

export interface ScaleCollectorConfig {
  readonly levels: readonly number[];
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly fpsFloor: number;
  /** сколько уровней пройти после первого падения ниже fpsFloor */
  readonly levelsBeyondFloor: number;
  /**
   * Минимум кадров на уровне: на тяжёлых уровнях за recordMs набирается
   * лишь десяток кадров, и медиана неустойчива. Запись продлевается, но не
   * дольше MAX_RECORD_FACTOR × recordMs.
   */
  readonly minLevelFrames: number;
}

const MAX_RECORD_FACTOR = 5;

/** уровень, на котором median FPS ниже этого, прекращает свип безусловно */
const TOO_SLOW_FPS = 2;

type Phase = 'idle' | 'building' | 'warmup' | 'recording' | 'done';

/**
 * S5: свип по числу объектов.
 *
 * Отличия от НИР2:
 *   - прогрев уровня отсчитывается от ГОТОВНОСТИ сцены (levelReady), а не от
 *     запроса уровня: в R3F монтирование десятков тысяч компонентов идёт
 *     асинхронно и раньше «съедало» прогрев, а первый записанный кадр
 *     содержал всё время монтирования;
 *   - свип не обрывается на первом провале: проходится ещё
 *     levelsBeyondFloor уровней, чтобы у всех вариантов была кривая за порогом;
 *   - ёмкость при 60/30 FPS интерполируется, а не округляется до уровня сетки.
 */
export class ScaleCollector implements FrameProbe {
  private readonly cfg: ScaleCollectorConfig;
  private phase: Phase = 'idle';
  private index = 0;
  private enterTs = NaN;
  private buildMs = NaN;
  private warmStart = NaN;
  private recordStart = NaN;
  private recorder: FrameRecorder | null = null;
  private readonly results: ScaleLevel[] = [];
  private firstBelow: number | null = null;
  private beyond = 0;
  private onAdvanceCb: ((count: number) => void) | null = null;
  private onDoneCb:
    | ((r: Omit<ScaleRunResult, 'kind' | 'meta'>) => void)
    | null = null;

  constructor(cfg: ScaleCollectorConfig) {
    if (cfg.levels.length === 0) throw new Error('S5: пустой список уровней');
    this.cfg = cfg;
  }

  onAdvanceLevel(cb: (count: number) => void): void {
    this.onAdvanceCb = cb;
  }

  onDone(cb: (r: Omit<ScaleRunResult, 'kind' | 'meta'>) => void): void {
    this.onDoneCb = cb;
  }

  get currentCount(): number {
    return this.cfg.levels[this.index] ?? 0;
  }

  start(): void {
    this.enterLevel(0);
  }

  /** реализация сообщает, что объекты уровня уже в графе сцены */
  levelReady(): void {
    if (this.phase !== 'building') return;
    this.buildMs = performance.now() - this.enterTs;
    this.phase = 'warmup';
    this.warmStart = NaN;
    bench.setStatus('warmup');
  }

  beginFrame(now: number): void {
    if (this.phase === 'warmup') {
      if (Number.isNaN(this.warmStart)) this.warmStart = now;
      if (now - this.warmStart >= this.cfg.warmupMs) {
        this.phase = 'recording';
        this.recordStart = now;
        this.recorder = new FrameRecorder(now);
        bench.mark(`level-${this.currentCount}-start`);
        bench.setStatus('recording');
      }
    }
    if (this.phase !== 'recording') return;
    const rec = this.recorder!;
    const elapsed = now - this.recordStart;
    const enough = rec.frameCount >= this.cfg.minLevelFrames || elapsed >= this.cfg.recordMs * MAX_RECORD_FACTOR;
    if (elapsed >= this.cfg.recordMs && enough) {
      rec.finish(now);
      this.recorder = null;
      bench.mark(`level-${this.currentCount}-end`);
      this.finalizeLevel(rec);
      return;
    }
    rec.beginFrame(now);
  }

  beginRender(now: number): void {
    this.recorder?.beginRender(now);
  }

  endRender(now: number): void {
    this.recorder?.endRender(now);
  }

  private enterLevel(i: number): void {
    this.index = i;
    this.phase = 'building';
    this.enterTs = performance.now();
    bench.setStatus('building');
    bench.setHudValue(`${this.currentCount} obj`);
    this.onAdvanceCb?.(this.currentCount);
  }

  private finalizeLevel(rec: FrameRecorder): void {
    const summary = rec.summary();
    this.results.push({ count: this.currentCount, build_ms: this.buildMs, summary, raw: rec.raw() });

    const below = summary.fps_median < this.cfg.fpsFloor;
    if (below && this.firstBelow === null) this.firstBelow = this.currentCount;
    if (this.firstBelow !== null && this.currentCount !== this.firstBelow) this.beyond++;

    let reason: ScaleRunResult['stopped_reason'] | null = null;
    if (summary.fps_median < TOO_SLOW_FPS) reason = 'too-slow';
    else if (this.firstBelow !== null && this.beyond >= this.cfg.levelsBeyondFloor) reason = 'beyond-floor';
    else if (this.index >= this.cfg.levels.length - 1) reason = 'levels-exhausted';

    if (reason === null) {
      this.enterLevel(this.index + 1);
      return;
    }
    this.phase = 'done';
    this.onDoneCb?.({
      levels: this.results,
      fpsFloor: this.cfg.fpsFloor,
      first_below_floor: this.firstBelow,
      capacity_fps60: capacityAt(this.results, 60),
      capacity_fps30: capacityAt(this.results, 30),
      stopped_reason: reason,
    });
  }
}

/**
 * Число объектов, при котором median FPS впервые опускается до target:
 * линейная интерполяция в координатах (log N, log FPS) между соседними
 * уровнями. null — порог не пересечён в пределах пройденных уровней.
 */
export function capacityAt(levels: readonly ScaleLevel[], target: number): number | null {
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1]!;
    const b = levels[i]!;
    const fa = a.summary.fps_median;
    const fb = b.summary.fps_median;
    if (fa >= target && fb < target) {
      const la = Math.log(a.count);
      const lb = Math.log(b.count);
      const u = (Math.log(target) - Math.log(fa)) / (Math.log(fb) - Math.log(fa));
      return Math.round(Math.exp(la + u * (lb - la)));
    }
  }
  return null;
}
