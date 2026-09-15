import { InitCollector } from '@bench/metrics';
import type { SceneSpec } from '@bench/scene-spec';
import { buildScene } from './scene-builder.js';

export interface InitRunnerConfig {
  readonly spec: SceneSpec;
  readonly host: HTMLElement;
  readonly quietWindowMs: number;
  readonly ttiTimeoutMs: number;
  readonly onPhaseChange?: (phase: string, ttfr: number | null) => void;
}

/**
 * Init-раннер для S3 на чистом three.js.
 *
 * Отличается от runScenario тем, что:
 *   - НЕ запускает render-loop (один кадр, потом сцена просто стоит);
 *   - фиксирует TTFR сразу после первого render();
 *   - после первого кадра ждёт InitCollector'ом тихое окно для TTI.
 *
 * Важный нюанс: buildScene вызывается ВНУТРИ rAF, чтобы первый замер
 * TTFR включил стоимость инициализации WebGL-контекста, компиляции
 * шейдеров и аплоада геометрии — то есть всё, что мы и сравниваем.
 */
export function runInitScenario(cfg: InitRunnerConfig): () => void {
  const collector = new InitCollector({
    scenarioId: cfg.spec.id,
    implementation: 'threejs',
    mode: null,
    quietWindowMs: cfg.quietWindowMs,
    ttiTimeoutMs: cfg.ttiTimeoutMs,
    publishToWindow: true,
  });

  cfg.onPhaseChange?.('warmup', null);
  collector.onDone((r) => cfg.onPhaseChange?.('done', r.ttfr_ms));

  let disposables: readonly { dispose(): void }[] = [];

  const rafId = requestAnimationFrame(() => {
    const frameStart = performance.now();
    const built = buildScene(cfg.spec, cfg.host);
    built.renderer.render(built.scene, built.camera);
    const frameEnd = performance.now();
    disposables = built.disposables;
    collector.markFirstFrame(frameStart, frameEnd);
    cfg.onPhaseChange?.('recording', frameEnd);
  });

  return () => {
    cancelAnimationFrame(rafId);
    for (const d of disposables) d.dispose();
    cfg.host.innerHTML = '';
  };
}
