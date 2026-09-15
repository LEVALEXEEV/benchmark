import { readHeapMb } from './frame-recorder.js';
import { bench, type FrameProbe } from './runtime.js';
import type { InitRunResult } from './types.js';

export interface InitCollectorConfig {
  /** ожидание long tasks после первого кадра, мс */
  readonly settleMs: number;
  /** true, когда в сцене все объекты спецификации (проверяется в endRender) */
  readonly isSceneComplete: () => boolean;
}

type InitMeasures = Omit<InitRunResult, 'kind' | 'meta'>;

const LONG_TASK_BLOCKING_MS = 50;

/**
 * S3: холодный старт.
 *
 * Метки ставятся в ОДНИХ И ТЕХ ЖЕ точках кадра обеих реализаций:
 *   js_ready     — начало кода приложения (все модули исполнены);
 *   ttfr_submit  — конец renderer.render() первого кадра с полной сценой;
 *   ttfr_frame   — начало следующего кадра.
 * В НИР2 three.js ставил метку после render(), а R3F — на втором useFrame,
 * то есть с лишним ожиданием кадра, что завышало разницу.
 *
 * TTI заменён на TBT по long tasks. Старый TTI был вырожден (у R3F совпадал
 * с TTFR во всех прогонах): наблюдатель подписывался уже после исполнения
 * бандла и не видел основную long task. Теперь long tasks собирает инлайн-
 * скрипт в <head> до загрузки модулей (window.__LT__).
 */
export class InitCollector implements FrameProbe {
  private readonly cfg: InitCollectorConfig;
  private jsReady = NaN;
  private renderStart = NaN;
  private ttfrSubmit = NaN;
  private ttfrFrame = NaN;
  private firstRender = NaN;
  private framesBeforeReady = 0;
  private heapAtTtfr: number | null = null;
  private onDoneCb: ((m: InitMeasures) => void) | null = null;

  constructor(cfg: InitCollectorConfig) {
    this.cfg = cfg;
  }

  onDone(cb: (m: InitMeasures) => void): void {
    this.onDoneCb = cb;
  }

  markJsReady(now: number): void {
    if (Number.isNaN(this.jsReady)) this.jsReady = now;
  }

  beginFrame(now: number): void {
    if (!Number.isNaN(this.ttfrSubmit) && Number.isNaN(this.ttfrFrame)) {
      this.ttfrFrame = now;
      bench.setStatus('settling');
      bench.setHudValue(`ttfr ${this.ttfrSubmit.toFixed(0)} ms`);
      setTimeout(() => this.finish(), this.cfg.settleMs);
    }
  }

  beginRender(now: number): void {
    this.renderStart = now;
  }

  endRender(now: number): void {
    if (!Number.isNaN(this.ttfrSubmit)) return;
    if (!this.cfg.isSceneComplete()) {
      this.framesBeforeReady++;
      return;
    }
    this.ttfrSubmit = now;
    this.firstRender = now - this.renderStart;
    this.heapAtTtfr = readHeapMb();
  }

  private finish(): void {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const supported = window.__LT_SUPPORTED__ === true;
    const longTasks = (window.__LT__ ?? []).map(
      ([s, d]) => [Math.round(s * 100) / 100, Math.round(d * 100) / 100] as const
    );
    const tbt = (until: number): number | null => {
      if (!supported) return null;
      let sum = 0;
      for (const [start, dur] of longTasks) {
        if (start >= until) continue;
        const end = Math.min(start + dur, until);
        sum += Math.max(0, end - start - LONG_TASK_BLOCKING_MS);
      }
      return sum;
    };

    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const scripts = resources.filter((r) => r.initiatorType === 'script' || /\.m?js(\?|$)/.test(r.name));
    const kb = (xs: PerformanceResourceTiming[], k: 'encodedBodySize' | 'decodedBodySize'): number =>
      xs.reduce((s, r) => s + r[k], 0) / 1024;

    this.onDoneCb?.({
      nav: {
        response_end_ms: nav?.responseEnd ?? NaN,
        dom_interactive_ms: nav?.domInteractive ?? NaN,
        dom_content_loaded_end_ms: nav?.domContentLoadedEventEnd ?? NaN,
        load_event_end_ms: nav?.loadEventEnd ?? NaN,
      },
      js_ready_ms: this.jsReady,
      ttfr_submit_ms: this.ttfrSubmit,
      ttfr_frame_ms: this.ttfrFrame,
      init_ms: this.ttfrSubmit - this.jsReady,
      first_frame_render_ms: this.firstRender,
      frames_before_ready: this.framesBeforeReady,
      long_tasks_supported: supported,
      long_tasks: longTasks,
      tbt_to_ttfr_ms: tbt(this.ttfrFrame),
      tbt_total_ms: tbt(Infinity),
      resources: {
        script_count: scripts.length,
        script_encoded_kb: kb(scripts, 'encodedBodySize'),
        script_decoded_kb: kb(scripts, 'decodedBodySize'),
        total_count: resources.length,
        total_encoded_kb: kb(resources, 'encodedBodySize'),
      },
      heap_mb_at_ttfr: this.heapAtTtfr,
      heap_mb_at_end: readHeapMb(),
    });
  }
}
