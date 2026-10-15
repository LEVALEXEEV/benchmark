import { bench, type FrameProbe } from './runtime.js';
import type { InitRunResult } from './types.js';

export interface InitCollectorConfig {
  /** true, когда в сцене все объекты спецификации (проверяется в endRender) */
  readonly isSceneComplete: () => boolean;
}

type InitMarks = Omit<InitRunResult, 'kind' | 'meta'>;

/**
 * S3: холодный старт.
 *
 * Метки ставятся в ОДНИХ И ТЕХ ЖЕ точках кадра обеих реализаций (мс от
 * начала навигации — performance.now() отсчитывается от timeOrigin):
 *   code_ready   — начало кода приложения (все модули исполнены);
 *   render_start — начало renderer.render() первого кадра с полной сценой;
 *   render_end   — его конец.
 * В НИР2 three.js ставил метку после render(), а R3F — на втором useFrame,
 * то есть с лишним ожиданием кадра, что завышало разницу. Кадры, в которых
 * у R3F сцена ещё неполная, в отметки не попадают.
 */
export class InitCollector implements FrameProbe {
  private readonly cfg: InitCollectorConfig;
  private codeReady = NaN;
  private renderStart = NaN;
  private done = false;
  private onDoneCb: ((m: InitMarks) => void) | null = null;

  constructor(cfg: InitCollectorConfig) {
    this.cfg = cfg;
  }

  onDone(cb: (m: InitMarks) => void): void {
    this.onDoneCb = cb;
  }

  markJsReady(now: number): void {
    if (Number.isNaN(this.codeReady)) this.codeReady = now;
  }

  beginRender(now: number): void {
    this.renderStart = now;
  }

  endRender(now: number): void {
    if (this.done || !this.cfg.isSceneComplete()) return;
    this.done = true;
    bench.setHudValue(`ttfr ${now.toFixed(0)} ms`);
    this.onDoneCb?.({ code_ready_ms: this.codeReady, render_start_ms: this.renderStart, render_end_ms: now });
  }
}
