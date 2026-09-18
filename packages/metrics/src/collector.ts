import { FrameRecorder } from './frame-recorder.js';
import { bench, type FrameProbe } from './runtime.js';
import type { FrameRaw, FrameSummary } from './types.js';

export interface FrameCollectorConfig {
  readonly warmupMs: number;
  readonly recordMs: number;
}

/**
 * S1/S2: прогрев → запись окна recordMs → публикация сводки и сырых рядов.
 *
 * Отсчёт прогрева начинается с ПЕРВОГО КАДРА, а не с создания коллектора:
 * в R3F между монтированием и первым кадром проходит асинхронная настройка
 * корня, в three.js — нет, и прогрев «от конструктора» был бы неравным.
 */
export class FrameCollector implements FrameProbe {
  private readonly cfg: FrameCollectorConfig;
  private phase: 'idle' | 'warmup' | 'recording' | 'done' = 'idle';
  private warmStart = NaN;
  private recordStart = NaN;
  private recorder: FrameRecorder | null = null;
  private onDoneCb: ((s: FrameSummary, raw: FrameRaw) => void) | null = null;

  constructor(cfg: FrameCollectorConfig) {
    this.cfg = cfg;
  }

  onDone(cb: (s: FrameSummary, raw: FrameRaw) => void): void {
    this.onDoneCb = cb;
  }

  beginFrame(now: number): void {
    if (this.phase === 'done') return;
    if (this.phase === 'idle') {
      this.phase = 'warmup';
      this.warmStart = now;
      bench.setStatus('warmup');
    }
    if (this.phase === 'warmup' && now - this.warmStart >= this.cfg.warmupMs) {
      this.phase = 'recording';
      this.recordStart = now;
      this.recorder = new FrameRecorder(now);
      bench.mark('record-start');
      bench.setStatus('recording');
    }
    if (this.phase !== 'recording') return;

    const rec = this.recorder!;
    if (now - this.recordStart >= this.cfg.recordMs) {
      rec.finish(now);
      bench.mark('record-end');
      this.phase = 'done';
      this.onDoneCb?.(rec.summary(), rec.raw());
      return;
    }
    rec.beginFrame(now, bench.frameIndex);
    if (rec.frameCount > 0 && rec.frameCount % 30 === 0) {
      bench.setHudValue(`${Math.round(1000 / (now - this.recordStart) * rec.frameCount)} fps`);
    }
  }

  beginRender(now: number): void {
    this.recorder?.beginRender(now);
  }

  endRender(now: number): void {
    this.recorder?.endRender(now);
  }

  gpuSample(frame: number, gpuMs: number): void {
    this.recorder?.gpuSample(frame, gpuMs);
  }
}
