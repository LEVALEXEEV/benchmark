import { FrameRecorder } from './frame-recorder.js';
import { bench, type FrameProbe } from './runtime.js';
import { median } from './stats.js';
import type { ScaleLevel } from './types.js';

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
 *
 * Пишутся только длительности кадров каждого уровня. Медиана FPS
 * считается здесь лишь для решения, где остановить свип; ёмкость при
 * 60 / 30 FPS считает анализ.
 */
export class ScaleCollector implements FrameProbe {
  private readonly cfg: ScaleCollectorConfig;
  private phase: Phase = 'idle';
  private index = 0;
  private count = 0;
  private warmStart = NaN;
  private recordStart = NaN;
  private recorder: FrameRecorder | null = null;
  private readonly results: ScaleLevel[] = [];
  private firstBelow: number | null = null;
  private beyond = 0;
  private onAdvanceCb: ((count: number) => void) | null = null;
  private onDoneCb: ((levels: readonly ScaleLevel[]) => void) | null = null;

  constructor(cfg: ScaleCollectorConfig) {
    if (cfg.levels.length === 0) throw new Error('S5: пустой список уровней');
    this.cfg = cfg;
  }

  onAdvanceLevel(cb: (count: number) => void): void {
    this.onAdvanceCb = cb;
  }

  onDone(cb: (levels: readonly ScaleLevel[]) => void): void {
    this.onDoneCb = cb;
  }

  get currentCount(): number {
    return this.count;
  }

  start(): void {
    this.enterLevel(0);
  }

  /** реализация сообщает, что объекты уровня уже в графе сцены */
  levelReady(): void {
    if (this.phase !== 'building') return;
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
        this.recorder = new FrameRecorder();
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
      this.finalizeLevel(rec);
      return;
    }
    rec.beginFrame(now, bench.frameIndex);
  }

  beginRender(now: number): void {
    this.recorder?.beginRender(now);
  }

  endRender(now: number): void {
    this.recorder?.endRender(now);
  }

  private enterLevel(i: number): void {
    this.index = i;
    this.count = this.cfg.levels[i]!;
    this.phase = 'building';
    bench.setStatus('building');
    bench.setHudValue(`${this.count} obj`);
    this.onAdvanceCb?.(this.count);
  }

  private finalizeLevel(rec: FrameRecorder): void {
    this.results.push({ objects: this.count, frame_ms: rec.frameMs });
    const fps = 1000 / median(rec.frameMs);

    const below = fps < this.cfg.fpsFloor;
    if (below && this.firstBelow === null) this.firstBelow = this.count;
    if (this.firstBelow !== null && this.count !== this.firstBelow) this.beyond++;

    const stop =
      fps < TOO_SLOW_FPS ||
      (this.firstBelow !== null && this.beyond >= this.cfg.levelsBeyondFloor) ||
      this.index >= this.cfg.levels.length - 1;
    if (!stop) {
      this.enterLevel(this.index + 1);
      return;
    }
    this.phase = 'done';
    this.onDoneCb?.(this.results);
  }
}
